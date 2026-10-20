import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";

import type { Answer, Decider, Question } from "./decider.ts";
import type { Check, GitHub, PrRef, PullRequest } from "./github/pull-request.ts";
import { Kitchen } from "./kitchen.ts";
import {
  createDependabotBump,
  RECIPE_LIMITS,
  type RecipeRuns,
} from "./mastra/workflows/dependabot-bump.ts";
import { KitchenStore } from "./store.ts";

// A local repository stands in for GitHub's: each PR is a commit published at refs/pull/<n>/head.
const PASSING_PR = 1;
const FAILING_PR = 2;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function publishPr(repo: string, number: number, testExitCode: number): string {
  const manifest = {
    name: "fixture",
    version: "1.0.0",
    scripts: { test: `node -e "process.exit(${testExitCode})"` },
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
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", `pr ${number}`);

  const sha = git(repo, "rev-parse", "HEAD");

  git(repo, "update-ref", `refs/pull/${number}/head`, sha);

  return sha;
}

class FakeGitHub implements GitHub {
  readonly pullRequests = new Map<number, PullRequest>();
  readonly checks = new Map<string, Check[]>();
  readonly comments = new Map<number, string>();
  readonly merges: number[] = [];

  readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  async getPullRequest(ref: PrRef): Promise<PullRequest> {
    const pr = this.pullRequests.get(ref.number);

    if (pr === undefined) throw new Error(`no PR ${ref.number}`);

    return pr;
  }

  async getChecks(_ref: PrRef, sha: string): Promise<Check[]> {
    return this.checks.get(sha) ?? [];
  }

  cloneUrl(): string {
    return this.repoPath;
  }

  async upsertComment(ref: PrRef, marker: string, body: string): Promise<string> {
    assert.ok(body.startsWith(marker));
    this.comments.set(ref.number, body);

    return `https://github.test/pr/${ref.number}#comment`;
  }

  async merge(ref: PrRef): Promise<void> {
    this.merges.push(ref.number);
  }
}

function dependabotPr(number: number, headSha: string, title: string): PullRequest {
  return {
    url: `https://github.com/octo/app/pull/${number}`,
    title,
    body: "Bumps left-pad. Release notes: fixes a typo in the README.",
    author: { login: "app/dependabot", isBot: true },
    state: "OPEN",
    isDraft: false,
    headSha,
    labels: ["dependencies"],
  };
}

/** Answers like a confident model: the PR is a Dependabot bump, and the bump is safe. */
const confidentModel: Decider = {
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
      verdict: {
        type: "choice",
        choice: "safe",
        probabilities: { safe: 0.95, review: 0.04, unsafe: 0.01 },
        confidence: 0.9,
      },
      breaking: { type: "noul", noul: 0.02 },
    };
  },
};

let dir: string;
let github: FakeGitHub;
let store: KitchenStore;
let kitchen: Kitchen;
let now: Date;
let passingSha: string;
let failingSha: string;
let runs: RecipeRuns;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kitchen-test-"));

  const repo = join(dir, "origin");

  execFileSync("git", ["init", "--quiet", repo]);
  passingSha = publishPr(repo, PASSING_PR, 0);
  failingSha = publishPr(repo, FAILING_PR, 1);
  github = new FakeGitHub(repo);
  github.pullRequests.set(
    PASSING_PR,
    dependabotPr(PASSING_PR, passingSha, "Bump left-pad from 1.3.0 to 1.3.1"),
  );
  github.pullRequests.set(
    FAILING_PR,
    dependabotPr(FAILING_PR, failingSha, "Bump left-pad from 1.3.0 to 1.4.0"),
  );
  now = new Date("2026-01-01T00:00:00Z");

  const recipe = createDependabotBump({
    github,
    decider: confidentModel,
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
  kitchen = new Kitchen({ store, github, decider: confidentModel, runs, now: () => now });
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

test("submitting the same PR twice stores one Input", () => {
  const first = kitchen.intake("https://github.com/octo/app/pull/1");
  const second = kitchen.intake("https://github.com/octo/app/pull/1/files");

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.input.id, first.input.id);
  assert.equal(store.listInputs().length, 1);
  assert.equal(store.listInputs()[0]?.raw, "https://github.com/octo/app/pull/1");
});

test("a PR whose tests fail is parked with a reason and next action, and the comment says so", async () => {
  const workItem = await kitchen.run(await manualWorkItem(FAILING_PR), true);

  assert.equal(workItem.status, "parked");
  assert.equal(workItem.reason, "local tests failed");
  assert.match(workItem.nextAction ?? "", /rerun/);
  assert.match(github.comments.get(FAILING_PR) ?? "", /\*\*Parked:\*\* local tests failed/);
  assert.deepEqual(github.merges, []);
});

test("pending CI suspends the run until a due tick resumes it", async () => {
  github.checks.set(passingSha, [{ name: "build", state: "pending" }]);

  const workItemId = await manualWorkItem(PASSING_PR);
  const waiting = await kitchen.run(workItemId, false);

  assert.equal(waiting.status, "waiting");
  assert.equal(github.comments.size, 0);

  // Not due yet: the tick leaves it alone.
  now = new Date(now.getTime() + RECIPE_LIMITS.ciPollMs - 1);
  assert.deepEqual(await kitchen.tick(), []);

  github.checks.set(passingSha, [{ name: "build", state: "pass" }]);
  now = new Date(now.getTime() + 1);

  const [done] = await kitchen.tick();

  assert.equal(done?.status, "done");
  assert.match(github.comments.get(PASSING_PR) ?? "", /\| Safe rule \| passes \|/);
  assert.deepEqual(github.merges, [], "no merge without --allow-merge");
  assert.equal(store.listDecisions().length, 1);
});

test("CI that never finishes parks the run once the wait limit passes", async () => {
  github.checks.set(passingSha, [{ name: "build", state: "pending" }]);

  const workItemId = await manualWorkItem(PASSING_PR);

  await kitchen.run(workItemId, true);
  now = new Date(now.getTime() + RECIPE_LIMITS.ciWaitMs);

  const [parked] = await kitchen.tick();

  assert.equal(parked?.status, "parked");
  assert.match(parked?.reason ?? "", /CI still pending/);
  assert.deepEqual(github.merges, []);
});

test("with --allow-merge, a bump that passes the safe rule is merged", async () => {
  github.checks.set(passingSha, [{ name: "build", state: "pass" }]);

  const workItem = await kitchen.run(await manualWorkItem(PASSING_PR), true);

  assert.equal(workItem.status, "done");
  assert.deepEqual(github.merges, [PASSING_PR]);
});

test("triage routes a Dependabot PR to the recipe without a --recipe flag", async () => {
  const { input } = kitchen.intake("https://github.com/octo/app/pull/1");
  const result = await kitchen.createWorkItem(input.id, null);

  assert.ok(result.routed);
  assert.equal(result.workItem.recipe, "dependabot-bump");
  assert.equal(result.workItem.risk, "low");
  assert.equal(store.listDecisions()[0]?.kind, "triage");
});

test("the router rejects the model's proposal when the PR isn't from Dependabot", async () => {
  const human = dependabotPr(3, passingSha, "Bump left-pad from 1.3.0 to 1.3.1");

  github.pullRequests.set(3, { ...human, author: { login: "octocat", isBot: false } });

  const { input } = kitchen.intake("https://github.com/octo/app/pull/3");
  const result = await kitchen.createWorkItem(input.id, null);

  assert.deepEqual(result, {
    routed: false,
    reason: "dependabot-bump proposed, but opened by octocat, not Dependabot",
  });
  assert.equal(store.listWorkItems().length, 0);
});

test("a run started with something other than a PR URL is rejected before touching GitHub", async () => {
  // Studio's input form once received an owner plus a whole URL in the repo field.
  await assert.rejects(
    runs.start("bad-input", { url: "https://github.com/octo", allowMerge: true }),
    /pull request URL/,
  );
  assert.deepEqual(github.merges, []);
  assert.equal(github.comments.size, 0);
});

test("a run that throws in every attempt is parked, not left running", async () => {
  const workItemId = await manualWorkItem(PASSING_PR);

  github.pullRequests.delete(PASSING_PR);

  const workItem = await kitchen.run(workItemId, false);

  assert.equal(workItem.status, "parked");
  assert.match(workItem.reason ?? "", /no PR 1/);
});
