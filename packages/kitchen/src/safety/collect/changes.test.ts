import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { collectChanges } from "./changes.ts";

let dir = "";
let repo = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(message: string): string {
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);

  return git(repo, "rev-parse", "HEAD");
}

function manifest(vite: string): string {
  return JSON.stringify({
    name: "app",
    version: "1.0.0",
    engines: { node: ">=22.13.0" },
    devDependencies: { vite },
  });
}

function lock(vite: string): string {
  return JSON.stringify({
    name: "app",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "app", devDependencies: { vite: `^${vite}` } },
      "node_modules/vite": {
        version: vite,
        resolved: `https://registry.npmjs.org/vite/-/vite-${vite}.tgz`,
        integrity: `sha512-vite${vite}`,
        dev: true,
      },
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kitchen-changes-"));
  repo = join(dir, "origin");
  execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface PublishedPr {
  base: string;
  head: string;
}

/** main → PR branch bumping vite and renaming a doc → main moves on with an unrelated change. */
function publishPr(): PublishedPr {
  writeFileSync(join(repo, "package.json"), manifest("^7.1.2"));
  writeFileSync(join(repo, "package-lock.json"), lock("7.1.2"));
  writeFileSync(join(repo, "NOTES.md"), "notes\n");

  const base = commit("base");

  git(repo, "checkout", "--quiet", "-b", "renovate/vite");
  writeFileSync(join(repo, "package.json"), manifest("^7.1.3"));
  writeFileSync(join(repo, "package-lock.json"), lock("7.1.3"));
  mkdirSync(join(repo, "docs"));
  renameSync(join(repo, "NOTES.md"), join(repo, "docs", "NOTES.md"));

  const head = commit("bump vite");

  git(repo, "update-ref", "refs/pull/1/head", head);
  git(repo, "checkout", "--quiet", "main");
  writeFileSync(join(repo, "README.md"), "moved on\n");
  commit("unrelated");

  return { base, head };
}

test("changes are read from the merge base to the exact head, with manifests and lockfiles diffed", async () => {
  const { base, head } = publishPr();
  const workDir = join(dir, "work", "changes");

  const changes = await collectChanges({
    checkout: { cloneUrl: repo, headRef: "refs/pull/1/head", credentialHelper: "" },
    headSha: head,
    baseRef: "main",
    baseSha: git(repo, "rev-parse", "main"),
    workDir,
  });

  assert.equal(changes.mergeBaseSha, base);
  assert.equal(changes.headSha, head);
  assert.deepEqual(changes.files, [
    { path: "docs/NOTES.md", status: "renamed", previousPath: "NOTES.md" },
    { path: "package-lock.json", status: "modified", previousPath: null },
    { path: "package.json", status: "modified", previousPath: null },
  ]);
  assert.deepEqual(changes.manifests, [
    {
      path: "package.json",
      dependencyChanges: [{ name: "vite", type: "devDependency", from: "^7.1.2", to: "^7.1.3" }],
      otherChanges: [],
    },
  ]);
  assert.equal(changes.lockfiles.length, 1);
  assert.deepEqual(
    changes.lockfiles[0]?.added.map((locked) => `${locked.name}@${locked.version}`),
    ["vite@7.1.3"],
  );
  assert.deepEqual(
    changes.lockfiles[0]?.removed.map((locked) => `${locked.name}@${locked.version}`),
    ["vite@7.1.2"],
  );
  assert.deepEqual(changes.importers, [
    {
      path: ".",
      dependencies: [
        { name: "vite", type: "devDependency", specifier: "^7.1.3", version: "7.1.3" },
      ],
    },
  ]);
  assert.equal(changes.projectNodeEngine, ">=22.13.0");
  assert.ok(!existsSync(workDir), "work dir is deleted");
});

test("a head that moved since the PR was read is refused", async () => {
  const { base } = publishPr();

  await assert.rejects(
    collectChanges({
      checkout: { cloneUrl: repo, headRef: "refs/pull/1/head", credentialHelper: "" },
      headSha: base,
      baseRef: "main",
      baseSha: git(repo, "rev-parse", "main"),
      workDir: join(dir, "work", "moved"),
    }),
    /PR head moved/,
  );
});

test("a merged PR is diffed from the base it merged into, not the branch tip that contains it", async () => {
  const { base, head } = publishPr();
  const mergedInto = git(repo, "rev-parse", "main");

  git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "merge",
    "--quiet",
    "--no-ff",
    "-m",
    "merge",
    head,
  );

  const changes = await collectChanges({
    checkout: { cloneUrl: repo, headRef: "refs/pull/1/head", credentialHelper: "" },
    headSha: head,
    baseRef: "main",
    baseSha: mergedInto,
    workDir: join(dir, "work", "merged"),
  });

  assert.equal(changes.mergeBaseSha, base);
  assert.deepEqual(
    changes.files.map((file) => file.path),
    ["docs/NOTES.md", "package-lock.json", "package.json"],
  );
});
