import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type {
  Check,
  Checkout,
  Forge,
  PrCommit,
  PrRef,
  PullRequest,
  RepoPolicy,
  RepoRef,
} from "../../forge/forge.ts";
import type { Advisory } from "../evidence.ts";
import { DEFAULT_POLICY, type Policy } from "../policy.ts";

import type { AdvisorySource, PackageVersion } from "./advisories.ts";
import { collectEvidence, type CollectDeps } from "./collect.ts";
import type { Packument, Registry } from "./registry.ts";

const REF: PrRef = { forge: "github", host: "github.com", project: "octo/app", number: 7 };

const NOW = new Date("2025-09-01T12:00:00.000Z");

const ROW =
  "| [vite](https://vite.dev) | [`7.1.2` → `7.1.3`](https://renovatebot.com/diffs/npm/vite/7.1.2/7.1.3) |";

const BODY = [
  "This PR contains the following updates:",
  "",
  "| Package | Change |",
  "|---|---|",
  ROW,
  "",
  "---",
  "",
  "### Release Notes",
  "",
  "Fixes a bug.",
  "",
  "---",
].join("\n");

let dir = "";
let repo = "";
let headSha = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(vite: string): string {
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ devDependencies: { vite: `^${vite}` } }),
  );
  writeFileSync(
    join(repo, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { vite: `^${vite}` } },
        "node_modules/vite": { version: vite, integrity: `sha512-${vite}` },
      },
    }),
  );
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", vite);

  return git(repo, "rev-parse", "HEAD");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kitchen-collect-"));
  repo = join(dir, "origin");
  execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
  write("7.1.2");
  git(repo, "checkout", "--quiet", "-b", "renovate/vite");
  headSha = write("7.1.3");
  git(repo, "update-ref", "refs/pull/7/head", headSha);
  git(repo, "checkout", "--quiet", "main");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function pullRequest(title: string, body: string): PullRequest {
  return {
    url: "https://github.com/octo/app/pull/7",
    title,
    body,
    author: { login: "renovate[bot]", isBot: true, dependencyBot: true },
    state: "OPEN",
    isDraft: false,
    headSha,
    baseRef: "main",
    baseSha: "base-tip",
    labels: [],
    createdAt: "2025-08-30T00:00:00.000Z",
    mergedAt: null,
  };
}

/** Answers only what collection asks; anything else is a test bug. */
class FakeForge implements Forge {
  repoPolicyError: string | null = null;

  async getPullRequest(): Promise<PullRequest> {
    throw new Error("not used");
  }

  async listPullRequests(): Promise<PrRef[]> {
    throw new Error("not used");
  }

  dependencyBots(_repo: RepoRef): readonly string[] {
    return ["renovate[bot]"];
  }

  async getCommits(): Promise<PrCommit[]> {
    return [
      { sha: headSha, authorLogin: "renovate[bot]", committerLogin: "web-flow", verified: true },
    ];
  }

  async getRepoPolicy(_ref: PrRef, baseRef: string): Promise<RepoPolicy> {
    if (this.repoPolicyError !== null) throw new Error(this.repoPolicyError);

    return {
      baseRef,
      reviewDecision: "NONE",
      mergeStateStatus: "CLEAN",
      mergeQueueRequired: false,
      requiredChecks: ["test"],
    };
  }

  async getChecks(): Promise<Check[]> {
    throw new Error("not used");
  }

  checkout(): Checkout {
    return { cloneUrl: repo, headRef: "refs/pull/7/head", credentialHelper: "" };
  }

  async upsertComment(): Promise<string> {
    throw new Error("not used");
  }
}

const VITE: Packument = {
  name: "vite",
  time: { "7.1.2": "2025-08-12T00:00:00.000Z", "7.1.3": "2025-08-26T00:00:00.000Z" },
  versions: {
    "7.1.2": { version: "7.1.2", dist: { integrity: "sha512-7.1.2" } },
    "7.1.3": { version: "7.1.3", dist: { integrity: "sha512-7.1.3" } },
  },
};

function deps(forge: Forge, asked: PackageVersion[][]): CollectDeps {
  const registry: Registry = {
    url: "https://registry.example",
    packument: async (name) => (name === "vite" ? VITE : null),
  };

  const source: AdvisorySource = {
    name: "fake audit",
    check: async (packages): Promise<Advisory[]> => {
      asked.push([...packages]);

      return [];
    },
  };

  return {
    forge,
    registry: () => registry,
    advisories: () => [source],
    workDir: join(dir, "work"),
  };
}

test("every item carries its id, source, time, and commit; data comes from git, registry, and forge", async () => {
  const asked: PackageVersion[][] = [];

  const evidence = await collectEvidence(
    deps(new FakeForge(), asked),
    REF,
    pullRequest("chore(deps): update dependency vite to v7.1.3", BODY),
    DEFAULT_POLICY,
    () => NOW,
  );

  const meta = Object.values(evidence).map((item) => [item.id, item.source, item.sha, item.status]);

  assert.deepEqual(meta, [
    ["pull-request", "github api", headSha, "ok"],
    ["changes", "git", headSha, "ok"],
    ["registry", DEFAULT_POLICY.safety.registry, null, "ok"],
    ["advisories", "fake audit", null, "ok"],
    ["repo-policy", "github api", headSha, "ok"],
    ["release-notes", "pr body", headSha, "ok"],
  ]);
  assert.ok(Object.values(evidence).every((item) => item.collectedAt === NOW.toISOString()));

  const pr = evidence.pullRequest.data;

  assert.equal(pr.bump?.package, "vite");
  assert.equal(pr.updateCount, 1);
  assert.equal(pr.author.trustedBot, true);
  assert.equal(pr.commits.length, 1);
  assert.equal(
    evidence.registry.status === "ok" && evidence.registry.data.to?.integrity,
    "sha512-7.1.3",
  );
  assert.deepEqual(evidence.advisories.status === "ok" && evidence.advisories.data.checked, [
    "vite@7.1.3",
  ]);
  assert.deepEqual(asked, [[{ name: "vite", version: "7.1.3" }]]);
  assert.equal(
    evidence.releaseNotes.status === "ok" && evidence.releaseNotes.data.text,
    "Fixes a bug.",
  );
});

test("failures become error items; groups have no registry or advisory lookups", async () => {
  const forge = new FakeForge();

  forge.repoPolicyError = "HTTP 502";

  const policy: Policy = {
    ...DEFAULT_POLICY,
    safety: { ...DEFAULT_POLICY.safety, requireSecurityAssessment: false },
  };

  const evidence = await collectEvidence(
    deps(forge, []),
    REF,
    pullRequest("Update all non-major dependencies", `${ROW}\n${ROW}`),
    policy,
    () => NOW,
  );

  assert.equal(evidence.pullRequest.data.bump, null);
  assert.equal(evidence.pullRequest.data.updateCount, 2);
  assert.equal(evidence.repoPolicy.status, "error");
  assert.equal(evidence.repoPolicy.status === "error" && evidence.repoPolicy.reason, "HTTP 502");
  assert.equal(evidence.registry.status, "unavailable");
  assert.equal(evidence.advisories.status, "not-collected");
  assert.equal(evidence.releaseNotes.status, "unavailable");
});

test("a head that moved makes changes an error and leaves advisories unchecked", async () => {
  const pr = {
    ...pullRequest("chore(deps): update dependency vite to v7.1.3", BODY),
    headSha: "f".repeat(40),
  };

  const evidence = await collectEvidence(
    deps(new FakeForge(), []),
    REF,
    pr,
    DEFAULT_POLICY,
    () => NOW,
  );

  assert.equal(evidence.changes.status, "error");
  assert.equal(evidence.advisories.status, "error");
  assert.equal(
    evidence.registry.status === "ok" && evidence.registry.data.transitiveComplete,
    false,
  );
});
