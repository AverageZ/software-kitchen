import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { lastLines, runChecked, runCommand } from "../../exec.ts";
import type { PrRef } from "../../github/pull-request.ts";

import type { Tests } from "./schemas.ts";

export const VERIFY_LIMITS = {
  gitMs: 3 * 60_000,
  installMs: 10 * 60_000,
  testMs: 15 * 60_000,
};

const LOG_LINES = 40;

// Authenticate git over HTTPS with the gh CLI's token, whatever the user's git config says.
const GIT_AUTH = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

const packageJsonSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() });

const PACKAGE_MANAGERS = [
  { lockfile: "pnpm-lock.yaml", command: "pnpm", install: ["install", "--frozen-lockfile"] },
  { lockfile: "package-lock.json", command: "npm", install: ["ci"] },
];

/** Environment for code from the PR: no tokens or secrets from the kitchen's own environment. */
function untrustedEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, TMPDIR, LANG } = process.env;

  return { PATH, HOME, TMPDIR, LANG, CI: "true", HUSKY: "0", NO_COLOR: "1" };
}

export interface VerifyTarget {
  cloneUrl: string;
  pr: PrRef;
  headSha: string;
  /** Dependabot's `in /dir` suffix: where the bumped manifest lives. */
  directory: string | null;
  workDir: string;
}

/**
 * Checks out exactly `headSha` from the PR in a fresh directory, installs, and runs the test script.
 * Throws only for infrastructure failures (clone, fetch, moved head) so the stage can retry them;
 * install and test failures are results.
 */
export async function verifyLocally(target: VerifyTarget): Promise<Tests> {
  const { workDir } = target;
  const git = { timeoutMs: VERIFY_LIMITS.gitMs };

  await rm(workDir, { recursive: true, force: true });
  await mkdir(dirname(workDir), { recursive: true });

  try {
    await runChecked(
      "git",
      [...GIT_AUTH, "clone", "--quiet", "--no-checkout", target.cloneUrl, workDir],
      git,
    );
    await runChecked(
      "git",
      [
        ...GIT_AUTH,
        "-C",
        workDir,
        "fetch",
        "--quiet",
        "origin",
        `refs/pull/${target.pr.number}/head`,
      ],
      git,
    );

    const fetched = (
      await runChecked("git", ["-C", workDir, "rev-parse", "FETCH_HEAD"], git)
    ).trim();

    if (fetched !== target.headSha)
      throw new Error(`PR head moved from ${target.headSha} to ${fetched} during the run`);

    await runChecked(
      "git",
      ["-C", workDir, "checkout", "--quiet", "--detach", target.headSha],
      git,
    );

    return await installAndTest(join(workDir, target.directory ?? "."));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function installAndTest(packageDir: string): Promise<Tests> {
  const manifestPath = join(packageDir, "package.json");

  const manager = PACKAGE_MANAGERS.find((candidate) =>
    existsSync(join(packageDir, candidate.lockfile)),
  );

  if (!existsSync(manifestPath) || manager === undefined) {
    return {
      status: "unsupported",
      command: null,
      log: "No package.json with a pnpm or npm lockfile.",
    };
  }

  const manifest = packageJsonSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const env = untrustedEnv();
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
