import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";

import type { Answer, Decider, Question } from "./decider.ts";
import type {
  Check,
  Checkout,
  Forge,
  PrCommit,
  PrRef,
  PullRequest,
  RepoPolicy,
  RepoRef,
} from "./forge/forge.ts";
import { Kitchen } from "./kitchen.ts";
import {
  createDependabotBump,
  RECIPE_LIMITS,
  type RecipeRuns,
} from "./mastra/workflows/dependabot-bump.ts";
import type { LivePullRequest } from "./merge/authorize.ts";
import { executeMerges } from "./merge/execute.ts";
import { HeadMovedError, type MergeClient, type MergeRequest } from "./merge/github-app.ts";
import type { Packument, Registry } from "./safety/collect/registry.ts";
import { resolvePolicy, type Policy, type PolicyOverride } from "./safety/policy.ts";
import { KitchenStore } from "./store.ts";

// A local repository stands in for the host's: `main` holds the base, and each PR is a commit on
// top of it published at its forge's head ref.
const RENOVATE_PR = 1;
const FAILING_PR = 2;
const RENOVATE_MR = 7;

const PACKAGE = "eslint-plugin-foo";
const REGISTRY = "https://registry.npmjs.org";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

interface Project {
  testExitCode: number;
  /** Version of the dev dependency, or null for a project without dependencies. */
  version: string | null;
}

function writeProject(repo: string, project: Project): void {
  const devDependencies = project.version === null ? {} : { [PACKAGE]: project.version };

  const manifest = {
    name: "fixture",
    version: "1.0.0",
    scripts: { test: `node -e "process.exit(${project.testExitCode})"` },
    devDependencies,
  };

  const locked =
    project.version === null
      ? {}
      : {
          [`node_modules/${PACKAGE}`]: {
            version: project.version,
            resolved: `${REGISTRY}/${PACKAGE}/-/${PACKAGE}-${project.version}.tgz`,
            integrity: `sha512-${project.version}`,
            dev: true,
          },
        };

  const lock = {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "fixture", version: "1.0.0", devDependencies }, ...locked },
  };

  writeFileSync(join(repo, "package.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify(lock, null, 2));
}

function commit(repo: string, message: string): string {
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);

  return git(repo, "rev-parse", "HEAD");
}

/** Commits `project` on top of `parent` and publishes it at `headRef`. */
function publishPr(repo: string, parent: string, headRef: string, project: Project): string {
  git(repo, "checkout", "--quiet", "--detach", parent);
  writeProject(repo, project);

  const sha = commit(repo, headRef);

  git(repo, "update-ref", headRef, sha);
  git(repo, "checkout", "--quiet", "main");

  return sha;
}

const HEAD_REFS = {
  github: (number: number) => `refs/pull/${number}/head`,
  gitlab: (number: number) => `refs/merge-requests/${number}/head`,
};

class FakeForge implements Forge {
  readonly pullRequests = new Map<number, PullRequest>();
  readonly checks = new Map<string, Check[]>();
  readonly comments = new Map<number, string>();
  repoPolicy: RepoPolicy = {
    baseRef: "main",
    reviewDecision: "NONE",
    mergeStateStatus: "CLEAN",
    mergeQueueRequired: false,
    requiredChecks: ["test"],
  };

  readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  async getPullRequest(ref: PrRef): Promise<PullRequest> {
    const pr = this.pullRequests.get(ref.number);

    if (pr === undefined) throw new Error(`no PR ${ref.number}`);

    return pr;
  }

  async listPullRequests(repo: RepoRef, author: string, limit: number): Promise<PrRef[]> {
    return [...this.pullRequests.entries()]
      .filter(([, pr]) => pr.author.login === author)
      .slice(0, limit)
      .map(([number]) => ({ ...repo, number }));
  }

  dependencyBots(): readonly string[] {
    return ["dependabot[bot]", "renovate[bot]", "renovate-bot"];
  }

  async getCommits(ref: PrRef): Promise<PrCommit[]> {
    const pr = await this.getPullRequest(ref);

    return [
      {
        sha: pr.headSha,
        authorLogin: pr.author.login,
        committerLogin: pr.author.login,
        verified: true,
      },
    ];
  }

  async getRepoPolicy(): Promise<RepoPolicy> {
    return this.repoPolicy;
  }

  async getChecks(_ref: PrRef, sha: string): Promise<Check[]> {
    return this.checks.get(sha) ?? [];
  }

  checkout(ref: PrRef): Checkout {
    return {
      cloneUrl: this.repoPath,
      headRef: HEAD_REFS[ref.forge](ref.number),
      credentialHelper: "",
    };
  }

  async upsertComment(ref: PrRef, marker: string, body: string): Promise<string> {
    assert.ok(body.startsWith(marker));
    this.comments.set(ref.number, body);

    return `https://forge.test/pr/${ref.number}#comment`;
  }
}

/** The merge app's view of the host: answers from the fake forge, merges recorded. */
class FakeMergeClient implements MergeClient {
  readonly merges: MergeRequest[] = [];
  readonly approvals: string[] = [];
  readonly forge: FakeForge;

  constructor(forge: FakeForge) {
    this.forge = forge;
  }

  async identity(): Promise<string> {
    return "kitchen-merger[bot]";
  }

  async livePullRequest(ref: PrRef): Promise<LivePullRequest> {
    const pr = await this.forge.getPullRequest(ref);

    return {
      headSha: pr.headSha,
      baseRef: pr.baseRef,
      state: pr.state,
      isDraft: pr.isDraft,
      authorLogin: pr.author.login,
      mergeStateStatus: this.forge.repoPolicy.mergeStateStatus,
      reviewDecision: this.forge.repoPolicy.reviewDecision,
      checks: await this.forge.getChecks(ref, pr.headSha),
    };
  }

  async approve(_ref: PrRef, sha: string): Promise<void> {
    this.approvals.push(sha);
  }

  async merge(ref: PrRef, request: MergeRequest): Promise<void> {
    const pr = await this.forge.getPullRequest(ref);

    // Like GitHub's `sha` parameter: a moved head refuses the merge.
    if (pr.headSha !== request.sha) throw new HeadMovedError("Head branch was modified");

    this.merges.push(request);
  }
}

const DAY_MS = 24 * 60 * 60_000;

/** The registry's view of the package: 1.2.4 was published at `releasedAt`, 1.2.3 30 days earlier. */
function packument(releasedAt: Date): Packument {
  const manifest = (version: string) => ({
    version,
    dist: {
      integrity: `sha512-${version}`,
      tarball: `${REGISTRY}/${PACKAGE}/-/${PACKAGE}-${version}.tgz`,
    },
    _npmUser: { name: "alice" },
    maintainers: [{ name: "alice" }],
  });

  return {
    name: PACKAGE,
    versions: { "1.2.3": manifest("1.2.3"), "1.2.4": manifest("1.2.4") },
    time: {
      created: "2025-01-01T00:00:00.000Z",
      "1.2.3": new Date(releasedAt.getTime() - 30 * DAY_MS).toISOString(),
      "1.2.4": releasedAt.toISOString(),
    },
  };
}

const RELEASE_NOTES = [
  "### Release Notes",
  "",
  "<details><summary>foo/eslint-plugin-foo (eslint-plugin-foo)</summary>",
  "",
  "### v1.2.4",
  "",
  "- Fix a crash on empty files",
  "",
  "</details>",
  "",
  "---",
].join("\n");

function renovateBody(packageCell: string, change: string): string {
  return [
    "This PR contains the following updates:",
    "",
    "| Package | Change |",
    "|---|---|",
    `| ${packageCell} | ${change} |`,
    "",
    RELEASE_NOTES,
  ].join("\n");
}

function pullRequest(number: number, headSha: string, baseSha: string, title: string): PullRequest {
  return {
    url: `https://github.com/octo/app/pull/${number}`,
    title,
    body: renovateBody(
      `[${PACKAGE}](https://github.com/foo/eslint-plugin-foo)`,
      "[`1.2.3` → `1.2.4`](https://renovatebot.com/diffs/npm/eslint-plugin-foo/1.2.3/1.2.4)",
    ),
    author: { login: "renovate[bot]", isBot: true, dependencyBot: true },
    state: "OPEN",
    isDraft: false,
    headSha,
    baseRef: "main",
    baseSha,
    labels: ["dependencies"],
    createdAt: "2025-12-31T00:00:00Z",
    mergedAt: null,
  };
}

/** Answers like a model that read routine release notes, and routes PRs to the bump recipe. */
const model: Decider = {
  model: "fake-decider",
  async ask(_state: string, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    if ("recipe" in questions) {
      return {
        recipe: {
          type: "choice",
          choice: "dependabot-bump",
          probabilities: { "dependabot-bump": 0.97, none: 0.03 },
          confidence: 0.9,
        },
      };
    }

    return {
      releaseBehavior: {
        type: "choice",
        choice: "release.no-relevant-change",
        probabilities: { "release.no-relevant-change": 0.9 },
        confidence: 0.9,
      },
      compatibility: {
        type: "choice",
        choice: "compatibility.compatible",
        probabilities: { "compatibility.compatible": 0.9 },
        confidence: 0.9,
      },
    };
  },
};

let dir: string;
let forge: FakeForge;
let store: KitchenStore;
let kitchen: Kitchen;
let now: Date;
let renovateSha: string;
let baseSha: string;
let runs: RecipeRuns;
let policy: Policy;
let releasedAt: Date;

function usePolicy(...overrides: PolicyOverride[]): void {
  policy = resolvePolicy([{ verification: { localTests: false } }, ...overrides]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kitchen-test-"));

  const repo = join(dir, "origin");

  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo]);
  writeProject(repo, { testExitCode: 0, version: "1.2.3" });
  baseSha = commit(repo, "base");
  renovateSha = publishPr(repo, baseSha, HEAD_REFS.github(RENOVATE_PR), {
    testExitCode: 0,
    version: "1.2.4",
  });
  forge = new FakeForge(repo);
  forge.pullRequests.set(
    RENOVATE_PR,
    pullRequest(
      RENOVATE_PR,
      renovateSha,
      baseSha,
      "chore(deps): update dependency eslint-plugin-foo to v1.2.4",
    ),
  );
  now = new Date("2026-01-01T00:00:00Z");
  releasedAt = new Date(now.getTime() - 10 * DAY_MS);
  usePolicy();

  const registry: Registry = {
    url: REGISTRY,
    packument: async (name) => (name === PACKAGE ? packument(releasedAt) : null),
  };

  const recipe = createDependabotBump({
    forge,
    decider: model,
    policy: () => policy,
    registry: () => registry,
    advisories: () => [{ name: "fake audit", check: async () => [] }],
    workRoot: join(dir, "work"),
    now: () => now,
  });

  // Registering with Mastra gives the workflow storage, which suspend and resume need.
  new Mastra({
    workflows: { dependabotBump: recipe.workflow },
    storage: new LibSQLStore({ id: "test", url: `file:${join(dir, "mastra.db")}` }),
    logger: false,
  });
  store = new KitchenStore(join(dir, "kitchen.db"));
  runs = recipe.runs;
  kitchen = new Kitchen({ store, forge, decider: model, runs, now: () => now });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function manualWorkItem(number: number): Promise<number> {
  const { input } = kitchen.intake(`https://github.com/octo/app/pull/${number}`);
  const result = await kitchen.createWorkItem(input.id, "dependabot-bump");

  assert.ok(result.routed);

  return result.workItem.id;
}

function mergeDeps(client: MergeClient | null) {
  return { store, policy: () => policy, client: async () => client };
}

test("submitting the same PR twice stores one Input", () => {
  const first = kitchen.intake("https://github.com/octo/app/pull/1");
  const second = kitchen.intake("https://github.com/octo/app/pull/1/files");

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.input.id, first.input.id);
  assert.equal(store.listInputs().length, 1);
  assert.equal(store.listInputs()[0]?.raw, "https://github.com/octo/app/pull/1");
});

test("a safe Renovate patch waits for CI, then is assessed AUTO_MERGE but only observed", async () => {
  forge.checks.set(renovateSha, [{ name: "test", state: "pending" }]);

  const workItemId = await manualWorkItem(RENOVATE_PR);
  const waiting = await kitchen.run(workItemId);

  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.wakeAction, "resume");
  assert.equal(forge.comments.size, 0);

  // Not due yet: the tick leaves it alone.
  now = new Date(now.getTime() + RECIPE_LIMITS.ciPollMs - 1);
  assert.deepEqual(await kitchen.tick(), []);

  forge.checks.set(renovateSha, [{ name: "test", state: "pass" }]);
  now = new Date(now.getTime() + 1);

  const [done] = await kitchen.tick();
  const [record] = store.listAssessments("run", 10);

  assert.equal(done?.status, "done");
  assert.equal(record?.assessment.decision, "AUTO_MERGE");
  assert.equal(record?.assessment.grade, "A");
  assert.equal(record?.assessment.headSha, renovateSha);
  assert.equal(record?.assessment.authorization.permitted, false);
  assert.match(forge.comments.get(RENOVATE_PR) ?? "", /\*\*AUTO_MERGE\*\*.*observe mode/);
  assert.match(forge.comments.get(RENOVATE_PR) ?? "", /observation mode: would merge/);
  assert.equal(store.listDecisions().at(-1)?.kind, "release-notes");

  const client = new FakeMergeClient(forge);
  const [attempt] = await executeMerges(mergeDeps(client));

  assert.equal(attempt?.status, "refused", "observation mode never merges");
  assert.match(attempt?.detail ?? "", /observ/);
  assert.deepEqual(client.merges, []);
});

test("with an autonomous policy, kitchen merge revalidates and merges the assessed commit as the app", async () => {
  usePolicy({ mode: "autonomous", automation: { merge: true } });
  forge.checks.set(renovateSha, [{ name: "test", state: "pass" }]);

  const workItem = await kitchen.run(await manualWorkItem(RENOVATE_PR));

  assert.equal(workItem.status, "done");
  assert.match(forge.comments.get(RENOVATE_PR) ?? "", /Queued for `kitchen merge`/);

  const client = new FakeMergeClient(forge);

  assert.deepEqual(await executeMerges(mergeDeps(null)), [
    {
      assessmentId: 1,
      scope: `github.com/octo/app#${RENOVATE_PR}`,
      status: "refused",
      detail:
        "no githubApps entry for github.com in config.json; the evaluator's own login never merges",
    },
  ]);

  // A refused attempt is recorded; a fresh assessment is needed to try again.
  await kitchen.run(workItem.id);

  const [attempt] = await executeMerges(mergeDeps(client));

  assert.equal(attempt?.status, "merged");
  assert.deepEqual(
    client.merges.map((merge) => merge.sha),
    [renovateSha],
  );
  assert.equal(client.merges[0]?.method, "squash");
  assert.match(client.merges[0]?.message ?? "", /grade A/);
  assert.deepEqual(
    await executeMerges(mergeDeps(client)),
    [],
    "an executed assessment is not retried",
  );
});

test("a PR head that moves after evaluation is not merged on the old assessment", async () => {
  usePolicy({ mode: "autonomous", automation: { merge: true } });
  forge.checks.set(renovateSha, [{ name: "test", state: "pass" }]);
  await kitchen.run(await manualWorkItem(RENOVATE_PR));

  const pr = forge.pullRequests.get(RENOVATE_PR);

  assert.ok(pr !== undefined);
  forge.pullRequests.set(RENOVATE_PR, { ...pr, headSha: "f".repeat(40) });

  const client = new FakeMergeClient(forge);
  const [attempt] = await executeMerges(mergeDeps(client));

  assert.equal(attempt?.status, "refused");
  assert.match(attempt?.detail ?? "", /PR head changed after evaluation/);
  assert.deepEqual(client.merges, []);
});

test("a release younger than the minimum age defers, then reruns once it matures", async () => {
  releasedAt = new Date(now.getTime() - DAY_MS);
  forge.checks.set(renovateSha, [{ name: "test", state: "pass" }]);

  const deferred = await kitchen.run(await manualWorkItem(RENOVATE_PR));
  const published = releasedAt.getTime();

  assert.equal(deferred.status, "waiting");
  assert.equal(deferred.wakeAction, "rerun");
  assert.equal(deferred.wakeAt, new Date(published + 72 * 60 * 60_000).toISOString());
  assert.match(deferred.reason ?? "", /release-maturity/);

  now = new Date(published + 72 * 60 * 60_000);

  const [rerun] = await kitchen.tick();

  assert.equal(rerun?.status, "done");
  assert.deepEqual(
    store.listAssessments("run", 10).map((record) => record.assessment.decision),
    ["AUTO_MERGE", "DEFER"],
  );
});

test("CI that never finishes defers the WorkItem instead of leaving it waiting forever", async () => {
  forge.checks.set(renovateSha, [{ name: "test", state: "pending" }]);

  const workItemId = await manualWorkItem(RENOVATE_PR);

  await kitchen.run(workItemId);
  now = new Date(now.getTime() + RECIPE_LIMITS.ciWaitMs);

  const [deferred] = await kitchen.tick();

  assert.equal(deferred?.status, "waiting");
  assert.equal(deferred?.wakeAction, "rerun");
  assert.match(deferred?.reason ?? "", /ci/);
});

test("a Dependabot PR is out of scope: parked for a human with its test log, not called unsafe", async () => {
  usePolicy({ verification: { localTests: true } });

  const failingSha = publishPr(forge.repoPath, baseSha, HEAD_REFS.github(FAILING_PR), {
    testExitCode: 1,
    version: null,
  });

  forge.pullRequests.set(FAILING_PR, {
    ...pullRequest(FAILING_PR, failingSha, baseSha, "Bump left-pad from 1.3.0 to 1.3.1"),
    body: "Bumps left-pad.",
    author: { login: "dependabot[bot]", isBot: true, dependencyBot: true },
  });

  const workItem = await kitchen.run(await manualWorkItem(FAILING_PR));
  const comment = forge.comments.get(FAILING_PR) ?? "";

  assert.equal(workItem.status, "parked");
  assert.match(workItem.reason ?? "", /HUMAN_REVIEW: out of scope/);
  assert.match(comment, /not a judgement that it's unsafe/);
  assert.match(comment, /author dependabot\[bot\] is not an eligible bot/);
  assert.match(comment, /Test log \(tail\): `npm test`/);
});

test("a Renovate MR on a self-managed GitLab is assessed, and ineligible by default", async () => {
  const sha = publishPr(forge.repoPath, baseSha, HEAD_REFS.gitlab(RENOVATE_MR), {
    testExitCode: 0,
    version: "1.2.4",
  });

  forge.pullRequests.set(RENOVATE_MR, {
    ...pullRequest(
      RENOVATE_MR,
      sha,
      baseSha,
      "chore(deps): update dependency eslint-plugin-foo to v1.2.4",
    ),
    url: `https://gitlab.acme.dev/web/app/-/merge_requests/${RENOVATE_MR}`,
    author: { login: "renovate-bot", isBot: false, dependencyBot: true },
  });
  forge.checks.set(sha, [{ name: "test", state: "pass" }]);

  const { input } = kitchen.intake(
    `https://gitlab.acme.dev/web/app/-/merge_requests/${RENOVATE_MR}`,
  );

  const routed = await kitchen.createWorkItem(input.id, null);

  assert.ok(routed.routed);
  assert.equal(routed.workItem.scope, `gitlab.acme.dev/web/app!${RENOVATE_MR}`);

  const workItem = await kitchen.run(routed.workItem.id);

  assert.equal(workItem.status, "parked");
  assert.match(
    forge.comments.get(RENOVATE_MR) ?? "",
    /`eslint-plugin-foo` 1\.2\.3 → 1\.2\.4 \(patch, devDependency\)/,
  );
  assert.match(forge.comments.get(RENOVATE_MR) ?? "", /forge gitlab is not eligible/);
});

test("the same owner/repo#n on two hosts is two Inputs", () => {
  const github = kitchen.intake("https://github.com/octo/app/pull/1");
  const enterprise = kitchen.intake("https://github.acme.dev/octo/app/pull/1");

  assert.equal(enterprise.created, true);
  assert.notEqual(enterprise.input.id, github.input.id);
});

test("triage routes a dependency-bot PR to the recipe without a --recipe flag", async () => {
  const { input } = kitchen.intake("https://github.com/octo/app/pull/1");
  const result = await kitchen.createWorkItem(input.id, null);

  assert.ok(result.routed);
  assert.equal(result.workItem.recipe, "dependabot-bump");
  assert.equal(result.workItem.risk, "low");
  assert.equal(store.listDecisions()[0]?.kind, "triage");
});

test("the router rejects the model's proposal when the PR isn't from a dependency bot", async () => {
  const human = pullRequest(
    3,
    renovateSha,
    baseSha,
    "chore(deps): update dependency eslint-plugin-foo to v1.2.4",
  );

  forge.pullRequests.set(3, {
    ...human,
    author: { login: "octocat", isBot: false, dependencyBot: false },
  });

  const { input } = kitchen.intake("https://github.com/octo/app/pull/3");
  const result = await kitchen.createWorkItem(input.id, null);

  assert.deepEqual(result, {
    routed: false,
    reason: "dependabot-bump proposed, but opened by octocat, not a dependency bot",
  });
  assert.equal(store.listWorkItems().length, 0);
});

test("a run started with something other than a PR URL is rejected before touching the host", async () => {
  // Studio's input form once received an owner plus a whole URL in the repo field.
  await assert.rejects(
    runs.start("bad-input", { url: "https://github.com/octo" }),
    /pull request URL/,
  );
  assert.equal(forge.comments.size, 0);
});

test("a run that throws in every attempt is parked, not left running", async () => {
  const workItemId = await manualWorkItem(RENOVATE_PR);

  forge.pullRequests.delete(RENOVATE_PR);

  const workItem = await kitchen.run(workItemId);

  assert.equal(workItem.status, "parked");
  assert.match(workItem.reason ?? "", /no PR 1/);
});
