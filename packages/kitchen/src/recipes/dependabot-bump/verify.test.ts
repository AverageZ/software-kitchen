import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { verifyLocally, type VerifyTarget } from "./verify.ts";

let dir = "";
let repo = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// The test script fails if the kitchen's own secrets or home directory reach PR code.
const TEST_SCRIPT = [
  'node -e "',
  "const home = process.env.HOME;",
  "if (process.env.KITCHEN_SECRET !== undefined) process.exit(3);",
  "if (!home.endsWith('home-head') || home === require('os').userInfo().homedir) process.exit(4);",
  '"',
].join(" ");

const BUILD_SCRIPT = `
const fs = require("fs");
fs.mkdirSync("dist/assets", { recursive: true });
fs.writeFileSync("dist/out.txt", fs.readFileSync("src.txt"));
fs.writeFileSync("dist/assets/static.txt", "same");
`;

function commit(source: string): string {
  const manifest = {
    name: "fixture",
    version: "1.0.0",
    scripts: { test: TEST_SCRIPT, build: "node build.js" },
  };

  const lock = {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "fixture", version: "1.0.0" } },
  };

  writeFileSync(join(repo, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify(lock));
  writeFileSync(join(repo, "build.js"), BUILD_SCRIPT);
  writeFileSync(join(repo, "src.txt"), source);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", source);

  return git(repo, "rev-parse", "HEAD");
}

function target(headSha: string, artifacts: VerifyTarget["artifacts"]): VerifyTarget {
  return {
    checkout: { cloneUrl: repo, headRef: "refs/pull/3/head", credentialHelper: "" },
    headSha,
    baseRef: "main",
    directory: null,
    workDir: join(dir, "work", "verify"),
    artifacts,
  };
}

let headSha = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kitchen-verify-"));
  repo = join(dir, "origin");
  execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
  commit("base");
  git(repo, "checkout", "--quiet", "-b", "pr");
  headSha = commit("head");
  git(repo, "update-ref", "refs/pull/3/head", headSha);
  git(repo, "checkout", "--quiet", "main");
  process.env["KITCHEN_SECRET"] = "hunter2";
});

afterEach(() => {
  delete process.env["KITCHEN_SECRET"];
  rmSync(dir, { recursive: true, force: true });
});

test("PR code runs without the kitchen's environment, in a fresh home", async () => {
  const result = await verifyLocally(target(headSha, null));

  assert.equal(result.tests.status, "passed", result.tests.log);
  assert.equal(result.artifacts, null);
  assert.ok(!existsSync(join(dir, "work", "verify")), "work dir is deleted");
});

test("artifacts built at head and at the merge base are compared file by file", async () => {
  const result = await verifyLocally(
    target(headSha, { command: ["npm", "run", "build"], paths: ["dist", "missing"] }),
  );

  assert.equal(result.tests.status, "passed", result.tests.log);
  assert.deepEqual(result.artifacts, {
    status: "ok",
    data: { command: ["npm", "run", "build"], differing: ["dist/out.txt"] },
  });
});

test("a failing build is an artifacts error, not a test failure", async () => {
  const result = await verifyLocally(target(headSha, { command: ["false"], paths: ["dist"] }));

  assert.equal(result.tests.status, "passed");
  assert.equal(result.artifacts?.status, "error");
});
