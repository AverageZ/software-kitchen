import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";

import { lastLines, runCommand } from "../../exec.ts";
import type { Checkout } from "../../forge/forge.ts";
import { addWorktree, checkoutDetached, cloneAt, fetchRef, mergeBase } from "../../git.ts";
import type { artifactsEvidenceSchema, Collected, Tests } from "../../safety/evidence.ts";

export const VERIFY_LIMITS = {
  installMs: 10 * 60_000,
  testMs: 15 * 60_000,
  buildMs: 15 * 60_000,
};

const LOG_LINES = 40;

const packageJsonSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() });

interface PackageManager {
  lockfile: string;
  command: string;
  install: string[];
}

const PACKAGE_MANAGERS: readonly PackageManager[] = [
  { lockfile: "pnpm-lock.yaml", command: "pnpm", install: ["install", "--frozen-lockfile"] },
  { lockfile: "package-lock.json", command: "npm", install: ["ci"] },
];

/**
 * Environment for code from the PR: no tokens or secrets from the kitchen's own environment, and a
 * fresh empty `home` so `~/.npmrc`, `~/.config/gh` and the like are out of reach.
 */
function untrustedEnv(home: string): NodeJS.ProcessEnv {
  const { PATH, TMPDIR, LANG } = process.env;

  return { PATH, HOME: home, TMPDIR, LANG, CI: "true", HUSKY: "0", NO_COLOR: "1" };
}

/** A build to run at head and at the merge base, and the outputs to compare. */
export interface ArtifactsSpec {
  command: string[];
  /** Files or directories, relative to the package directory. */
  paths: string[];
}

export type ArtifactsResult = z.infer<typeof artifactsEvidenceSchema>;

export interface VerifyTarget {
  checkout: Checkout;
  headSha: string;
  /** Branch the PR merges into; its merge base with the head is the build artifacts are compared to. */
  baseRef: string;
  /** Dependabot's `in /dir` suffix: where the bumped manifest lives. */
  directory: string | null;
  /** Scratch directory for this run, deleted afterwards. */
  workDir: string;
  artifacts: ArtifactsSpec | null;
}

export interface VerifyResult {
  tests: Tests;
  /** Null when no comparison was asked for or the tests didn't pass. */
  artifacts: Collected<ArtifactsResult> | null;
}

/**
 * Checks out exactly `headSha` from the PR in a fresh directory, installs, and runs the test script.
 * With `artifacts`, also builds at head and at the merge base and reports which outputs differ.
 * Throws only for infrastructure failures (clone, fetch, moved head) so the stage can retry them;
 * install, test and build failures are results.
 */
export async function verifyLocally(target: VerifyTarget): Promise<VerifyResult> {
  const { workDir, checkout } = target;
  const headDir = join(workDir, "head");
  const baseDir = join(workDir, "base");

  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  try {
    await cloneAt(checkout, headDir);

    const fetched = await fetchRef(checkout, headDir, checkout.headRef);

    if (fetched !== target.headSha)
      throw new Error(`PR head moved from ${target.headSha} to ${fetched} during the run`);

    await checkoutDetached(headDir, target.headSha);

    // Every git step happens before PR code runs: install scripts could plant hooks or config in .git.
    if (target.artifacts !== null) {
      const baseTip = await fetchRef(checkout, headDir, `refs/heads/${target.baseRef}`);

      await addWorktree(headDir, baseDir, await mergeBase(headDir, target.headSha, baseTip));
    }

    const directory = target.directory ?? ".";
    const headPackage = join(headDir, directory);

    const manager = PACKAGE_MANAGERS.find((candidate) =>
      existsSync(join(headPackage, candidate.lockfile)),
    );

    if (!existsSync(join(headPackage, "package.json")) || manager === undefined) {
      return {
        tests: {
          status: "unsupported",
          command: null,
          log: "No package.json with a pnpm or npm lockfile.",
        },
        artifacts: null,
      };
    }

    const headEnv = untrustedEnv(await freshHome(workDir, "home-head"));
    const tests = await installAndTest(headPackage, manager, headEnv);

    if (target.artifacts === null || tests.status !== "passed") return { tests, artifacts: null };

    const artifacts = await compareArtifacts({
      spec: target.artifacts,
      manager,
      head: { packageDir: headPackage, env: headEnv },
      base: {
        packageDir: join(baseDir, directory),
        env: untrustedEnv(await freshHome(workDir, "home-base")),
      },
    });

    return { tests, artifacts };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function freshHome(workDir: string, name: string): Promise<string> {
  const home = join(workDir, name);

  await mkdir(home, { recursive: true });

  return home;
}

async function installAndTest(
  packageDir: string,
  manager: PackageManager,
  env: NodeJS.ProcessEnv,
): Promise<Tests> {
  const manifestPath = join(packageDir, "package.json");
  const manifest = packageJsonSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const installCommand = [manager.command, ...manager.install].join(" ");

  const install = await runCommand(manager.command, manager.install, {
    cwd: packageDir,
    env,
    timeoutMs: VERIFY_LIMITS.installMs,
  });

  if (install.timedOut)
    return {
      status: "timed-out",
      command: installCommand,
      log: lastLines(install.output, LOG_LINES),
    };

  if (install.exitCode !== 0)
    return {
      status: "install-failed",
      command: installCommand,
      log: lastLines(install.output, LOG_LINES),
    };

  if (manifest.scripts?.["test"] === undefined)
    return { status: "no-tests", command: null, log: "" };

  const testCommand = `${manager.command} test`;

  const test = await runCommand(manager.command, ["test"], {
    cwd: packageDir,
    env,
    timeoutMs: VERIFY_LIMITS.testMs,
  });

  const log = lastLines(test.output, LOG_LINES);

  if (test.timedOut) return { status: "timed-out", command: testCommand, log };

  return { status: test.exitCode === 0 ? "passed" : "failed", command: testCommand, log };
}

/** One side of an artifact comparison: a checked-out package and the environment to build it in. */
interface BuildSide {
  packageDir: string;
  env: NodeJS.ProcessEnv;
}

interface ArtifactComparison {
  spec: ArtifactsSpec;
  manager: PackageManager;
  /** Already installed by the test run. */
  head: BuildSide;
  /** Not yet installed. */
  base: BuildSide;
}

/**
 * Builds head (already installed) and the merge base, then hashes the listed outputs of each. A
 * failed install or build is an `error`: there is nothing to compare.
 */
async function compareArtifacts(
  comparison: ArtifactComparison,
): Promise<Collected<ArtifactsResult>> {
  const { spec, manager, head, base } = comparison;
  const headBuild = await build(spec, head);

  if (headBuild !== null) return { status: "error", reason: `head build ${headBuild}` };

  const headHashes = await hashPaths(head.packageDir, spec.paths);

  const install = await runCommand(manager.command, manager.install, {
    cwd: base.packageDir,
    env: base.env,
    timeoutMs: VERIFY_LIMITS.installMs,
  });

  if (install.timedOut || install.exitCode !== 0) {
    return {
      status: "error",
      reason: `merge base install failed: ${lastLines(install.output, LOG_LINES)}`,
    };
  }

  const baseBuild = await build(spec, base);

  if (baseBuild !== null) return { status: "error", reason: `merge base build ${baseBuild}` };

  const baseHashes = await hashPaths(base.packageDir, spec.paths);
  const files = new Set([...headHashes.keys(), ...baseHashes.keys()]);
  const differing: string[] = [];

  for (const file of files) {
    if (headHashes.get(file) !== baseHashes.get(file)) differing.push(file);
  }

  return { status: "ok", data: { command: spec.command, differing: differing.toSorted() } };
}

/** Runs the build command; returns why it failed, or null if it succeeded. */
async function build(spec: ArtifactsSpec, side: BuildSide): Promise<string | null> {
  const [command, ...args] = spec.command;

  if (command === undefined) return "has no command";

  const result = await runCommand(command, args, {
    cwd: side.packageDir,
    env: side.env,
    timeoutMs: VERIFY_LIMITS.buildMs,
  });

  if (result.timedOut) return `timed out: ${lastLines(result.output, LOG_LINES)}`;

  if (result.exitCode !== 0)
    return `exited ${result.exitCode}: ${lastLines(result.output, LOG_LINES)}`;

  return null;
}

/**
 * sha256 of every file under `paths`, keyed by path relative to `root`. Missing paths contribute
 * nothing, so an output only one side produced shows up as differing.
 */
async function hashPaths(root: string, paths: readonly string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  for (const path of paths) {
    const absolute = join(root, path);
    const info = await stat(absolute).catch(() => null);

    if (info === null) continue;

    const files = info.isDirectory()
      ? (await readdir(absolute, { recursive: true, withFileTypes: true })).flatMap((entry) =>
          entry.isFile() ? [join(entry.parentPath, entry.name)] : [],
        )
      : [absolute];

    for (const file of files) {
      hashes.set(
        relative(root, file),
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      );
    }
  }

  return hashes;
}
