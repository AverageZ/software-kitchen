import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { runChecked } from "./exec.ts";
import type { Checkout } from "./forge/forge.ts";

/** Time limit for one git network operation (clone or fetch). */
export const GIT_TIMEOUT_MS = 3 * 60_000;

/** Local git reads print whole lockfiles, far past `runCommand`'s output cap. */
const READ_LIMIT_BYTES = 512 * 1024 * 1024;

const READ_TIMEOUT_MS = 60_000;

const execFileAsync = promisify(execFile);

/** Git options that authenticate only through `helper`, whatever the user's git config says. */
export function gitAuth(helper: string): string[] {
  return ["-c", "credential.helper=", "-c", `credential.helper=${helper}`];
}

/** A local git command's stdout, uncapped. Throws on a non-zero exit. */
async function gitRead(repoDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    maxBuffer: READ_LIMIT_BYTES,
    timeout: READ_TIMEOUT_MS,
  });

  return stdout;
}

/**
 * A fresh clone of `checkout` at `repoDir` with no working tree, replacing anything already there.
 * Nothing is checked out, so no file from the repository is written or run.
 */
export async function cloneAt(checkout: Checkout, repoDir: string): Promise<void> {
  await rm(repoDir, { recursive: true, force: true });
  await mkdir(dirname(repoDir), { recursive: true });
  await runChecked(
    "git",
    [
      ...gitAuth(checkout.credentialHelper),
      "clone",
      "--quiet",
      "--no-checkout",
      checkout.cloneUrl,
      repoDir,
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
}

/** Fetches `ref` from the clone's origin and returns the commit it points to. */
export async function fetchRef(checkout: Checkout, repoDir: string, ref: string): Promise<string> {
  await runChecked(
    "git",
    [...gitAuth(checkout.credentialHelper), "-C", repoDir, "fetch", "--quiet", "origin", ref],
    { timeoutMs: GIT_TIMEOUT_MS },
  );

  return revParse(repoDir, "FETCH_HEAD");
}

/** The commit `rev` names. */
export async function revParse(repoDir: string, rev: string): Promise<string> {
  return (await gitRead(repoDir, ["rev-parse", "--verify", `${rev}^{commit}`])).trim();
}

/** The best common ancestor of two commits: where the PR branched off its base. */
export async function mergeBase(repoDir: string, a: string, b: string): Promise<string> {
  return (await gitRead(repoDir, ["merge-base", a, b])).trim();
}

/** Checks out `sha` as a detached head in the clone's working tree. */
export async function checkoutDetached(repoDir: string, sha: string): Promise<void> {
  await gitRead(repoDir, ["checkout", "--quiet", "--detach", sha]);
}

/**
 * A second working tree of the clone at `dir`, checked out at `sha`. Made before any repository code
 * runs, so the kitchen never needs git again in a clone that code could have tampered with.
 */
export async function addWorktree(repoDir: string, dir: string, sha: string): Promise<void> {
  await gitRead(repoDir, ["worktree", "add", "--quiet", "--detach", dir, sha]);
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "other";

/** One path in a diff, as `git diff --name-status` reports it. */
export interface ChangedFile {
  path: string;
  status: FileStatus;
  /** For renames and copies, where the file came from. */
  previousPath: string | null;
}

const STATUSES = new Map<string, FileStatus>([
  ["A", "added"],
  ["M", "modified"],
  ["D", "deleted"],
  ["R", "renamed"],
]);

/**
 * Parses `git diff --name-status -z`: a status field, then one path, or two for renames and copies.
 * NUL-separated so any file name survives.
 */
export function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0");
  const files: ChangedFile[] = [];
  let index = 0;

  while (index < fields.length) {
    const code = fields[index] ?? "";

    if (code === "") break;

    const letter = code.charAt(0);
    const twoPaths = letter === "R" || letter === "C";
    const first = fields[index + 1] ?? "";
    const second = fields[index + 2] ?? "";

    files.push({
      path: twoPaths ? second : first,
      status: STATUSES.get(letter) ?? "other",
      previousPath: twoPaths ? first : null,
    });
    index += twoPaths ? 3 : 2;
  }

  return files;
}

/** Files that differ between two commits, with renames detected. */
export async function diffNameStatus(
  repoDir: string,
  base: string,
  head: string,
): Promise<ChangedFile[]> {
  return parseNameStatus(await gitRead(repoDir, ["diff", "--name-status", "-M", "-z", base, head]));
}

/** A file's content at `sha`, or null if the path doesn't exist in that commit. */
export async function showFile(repoDir: string, sha: string, path: string): Promise<string | null> {
  const listed = await gitRead(repoDir, ["ls-tree", "-z", "--name-only", sha, "--", path]);

  if (listed === "") return null;

  return gitRead(repoDir, ["show", `${sha}:${path}`]);
}
