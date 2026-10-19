import { join } from "node:path";

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import type { Decider } from "../../decider.ts";
import type { GitHub } from "../../github/pull-request.ts";
import { parseBumpTitle } from "../../recipes/dependabot-bump/bump.ts";
import {
  COMMENT_MARKER,
  renderComment,
  type CommentFacts,
} from "../../recipes/dependabot-bump/comment.ts";
import { rateBump } from "../../recipes/dependabot-bump/rate.ts";
import { evaluateSafeRule } from "../../recipes/dependabot-bump/safe-rule.ts";
import {
  ciCheckedSchema,
  ciWaitSchema,
  inspectedSchema,
  judgedSchema,
  outcomeSchema,
  ratedSchema,
  recipeInputSchema,
  verifiedSchema,
  type Ci,
  type Outcome,
  type Tests,
} from "../../recipes/dependabot-bump/schemas.ts";
import { verifyLocally } from "../../recipes/dependabot-bump/verify.ts";
import { RECIPES } from "../../routing.ts";

/** Attempt and time limits per stage. Command time limits live in `VERIFY_LIMITS`. */
export const RECIPE_LIMITS = {
  /** Extra attempts after a stage throws (GitHub, git, or model outage). Results such as failing tests are not retried. */
  retries: { inspect: 2, verify: 1, waitCi: 2, decide: 2, report: 2 },
  /** How long a run sleeps between CI checks. */
  ciPollMs: 2 * 60_000,
  /** Total time a run waits for CI before parking. */
  ciWaitMs: 60 * 60_000,
};

export interface RecipeDeps {
  github: GitHub;
  decider: Decider;
  /** Parent directory for per-run checkouts. */
  workRoot: string;
  now: () => Date;
}

const RERUN = "fix or close the PR, then rerun the WorkItem with `kitchen run`";

/** Why a verified PR can't finish, or null if it can. */
function parkReason(tests: Tests, ci: Ci): { reason: string; nextAction: string } | null {
  switch (tests.status) {
    case "passed":
      break;
    case "failed":
      return {
        reason: "local tests failed",
        nextAction: `Read the test log in the PR comment; ${RERUN}`,
      };
    case "install-failed":
      return {
        reason: "dependency install failed",
        nextAction: `Read the install log in the PR comment; ${RERUN}`,
      };
    case "timed-out":
      return {
        reason: `\`${tests.command ?? "install"}\` hit its time limit`,
        nextAction: `Check for a hanging test; ${RERUN}`,
      };
    case "no-tests":
      return {
        reason: "the repository has no test script",
        nextAction: "Verify this PR by hand; the recipe can't test it",
      };
    case "unsupported":
      return {
        reason: "no pnpm or npm project to test",
        nextAction: "Verify this PR by hand; the recipe can't test it",
      };
  }

  if (ci.status === "failed")
    return { reason: "CI failed", nextAction: `Check the failing CI jobs; ${RERUN}` };

  if (ci.status === "timed-out") {
    return {
      reason: `CI still pending after ${RECIPE_LIMITS.ciWaitMs / 60_000} minutes`,
      nextAction: "Check CI, then rerun the WorkItem",
    };
  }

  return null;
}

/** Check out, install, test, wait for CI, rate, judge against the safe rule, and report on the PR. */
export function createDependabotBump(deps: RecipeDeps) {
  const inspect = createStep({
    id: "inspect",
    description:
      "Loads the PR and parses the bump from its title; parks anything that isn't a single-package Dependabot PR.",
    inputSchema: recipeInputSchema,
    outputSchema: inspectedSchema,
    retries: RECIPE_LIMITS.retries.inspect,
    execute: async ({ inputData, bail }) => {
      const pullRequest = await deps.github.getPullRequest(inputData.pr);
      const bump = parseBumpTitle(pullRequest.title);
      const refusal = RECIPES["dependabot-bump"].ineligibility(pullRequest);

      if (refusal !== null || bump === null) {
        return bail<Outcome>({
          status: "parked",
          reason: refusal ?? "title isn't a single-package bump",
          nextAction: "Handle this PR by hand or with another recipe",
          commentUrl: null,
          merged: false,
          subject: pullRequest.title,
          rating: null,
        });
      }

      return { ...inputData, pullRequest, bump };
    },
  });

  const verify = createStep({
    id: "verify",
    description: "Checks out the PR head in a fresh directory, installs, and runs the tests.",
    inputSchema: inspectedSchema,
    outputSchema: verifiedSchema,
    retries: RECIPE_LIMITS.retries.verify,
    execute: async ({ inputData, runId }) => {
      const { pr, pullRequest, bump } = inputData;

      const tests = await verifyLocally({
        cloneUrl: deps.github.cloneUrl(pr),
        pr,
        headSha: pullRequest.headSha,
        directory: bump.directory,
        workDir: join(deps.workRoot, `${pr.owner}-${pr.repo}-${pr.number}-${runId}`),
      });

      return { ...inputData, tests };
    },
  });

  const waitCi = createStep({
    id: "wait-ci",
    description:
      "Suspends the run while CI is pending on the checked commit; gives up after the CI wait limit.",
    inputSchema: verifiedSchema,
    outputSchema: ciCheckedSchema,
    suspendSchema: ciWaitSchema,
    resumeSchema: z.object({}),
    retries: RECIPE_LIMITS.retries.waitCi,
    execute: async ({ inputData, suspendData, suspend }) => {
      if (inputData.tests.status !== "passed")
        return { ...inputData, ci: { status: "skipped" as const, checks: [] } };

      const checks = await deps.github.getChecks(inputData.pr, inputData.pullRequest.headSha);
      const pending = checks.flatMap((check) => (check.state === "pending" ? [check.name] : []));

      if (pending.length === 0) {
        const status: Ci["status"] =
          checks.length === 0
            ? "none"
            : checks.some((check) => check.state === "fail")
              ? "failed"
              : "passed";

        return { ...inputData, ci: { status, checks } };
      }

      const now = deps.now();
      const since = suspendData?.since ?? now.toISOString();

      if (now.getTime() - Date.parse(since) >= RECIPE_LIMITS.ciWaitMs) {
        return { ...inputData, ci: { status: "timed-out" as const, checks } };
      }

      return suspend({
        since,
        wakeAt: new Date(now.getTime() + RECIPE_LIMITS.ciPollMs).toISOString(),
        pending,
      });
    },
  });

  const decide = createStep({
    id: "decide",
    description:
      "Asks the decision model to rate the bump. Skipped when tests or CI already failed.",
    inputSchema: ciCheckedSchema,
    outputSchema: ratedSchema,
    retries: RECIPE_LIMITS.retries.decide,
    execute: async ({ inputData }) => {
      const { bump, tests, ci, pullRequest } = inputData;

      const worthRating =
        tests.status === "passed" && (ci.status === "passed" || ci.status === "none");

      const rating = worthRating
        ? await rateBump(deps.decider, { bump, tests, ci, body: pullRequest.body })
        : null;

      return { ...inputData, rating };
    },
  });

  const judge = createStep({
    id: "judge",
    description: "Applies the safe-to-merge rule.",
    inputSchema: ratedSchema,
    outputSchema: judgedSchema,
    execute: async ({ inputData }) => ({ ...inputData, rule: evaluateSafeRule(inputData) }),
  });

  const report = createStep({
    id: "report",
    description: "Merges if allowed and the rule passes, then posts or updates the PR comment.",
    inputSchema: judgedSchema,
    outputSchema: outcomeSchema,
    retries: RECIPE_LIMITS.retries.report,
    execute: async ({ inputData }) => {
      const { pr, pullRequest, bump, tests, ci, rating, rule, allowMerge } = inputData;
      const parked = parkReason(tests, ci);

      const merge: CommentFacts["merge"] =
        parked !== null
          ? "parked"
          : !rule.safe
            ? "rule-failed"
            : allowMerge
              ? "merged"
              : "not-allowed";

      // A retry after a successful merge must not merge again.
      if (merge === "merged" && (await deps.github.getPullRequest(pr)).state !== "MERGED") {
        await deps.github.merge(pr, pullRequest.headSha);
      }

      const body = renderComment({
        bump,
        headSha: pullRequest.headSha,
        tests,
        ci,
        rating,
        rule,
        merge,
        parked,
      });

      const commentUrl = await deps.github.upsertComment(pr, COMMENT_MARKER, body);

      return {
        status: parked === null ? ("done" as const) : ("parked" as const),
        reason: parked?.reason ?? null,
        nextAction: parked?.nextAction ?? null,
        commentUrl,
        merged: merge === "merged",
        subject: `${bump.package} ${bump.from} → ${bump.to} (${bump.level})`,
        rating,
      };
    },
  });

  const workflow = createWorkflow({
    id: "dependabot-bump",
    description:
      "Recipe: verify a Dependabot bump, rate it, apply the safe rule, and report on the PR.",
    inputSchema: recipeInputSchema,
    outputSchema: outcomeSchema,
  })
    .then(inspect)
    .then(verify)
    .then(waitCi)
    .then(decide)
    .then(judge)
    .then(report)
    .commit();

  /** Translates Mastra's run result into what the kitchen acts on. */
  function toRunResult(
    result: Awaited<ReturnType<Awaited<ReturnType<typeof workflow.createRun>>["start"]>>,
  ): RecipeRunResult {
    if (result.status === "success")
      return { status: "finished", outcome: outcomeSchema.parse(result.result) };

    if (result.status === "suspended") {
      const wait = ciWaitSchema.parse(result.steps["wait-ci"]?.suspendPayload);

      return { status: "waiting", wakeAt: wait.wakeAt, pending: wait.pending };
    }

    if (result.status === "failed") return { status: "failed", error: result.error.message };

    return { status: "failed", error: `run ended ${result.status}` };
  }

  const runs: RecipeRuns = {
    async start(runId: string, input: RecipeInput): Promise<RecipeRunResult> {
      const run = await workflow.createRun({ runId });

      return toRunResult(await run.start({ inputData: input }));
    },

    async resume(runId: string): Promise<RecipeRunResult> {
      const run = await workflow.createRun({ runId });

      return toRunResult(await run.resume({ step: "wait-ci", resumeData: {} }));
    },
  };

  return { workflow, runs };
}

export type RecipeInput = z.infer<typeof recipeInputSchema>;

export type RecipeRunResult =
  | { status: "finished"; outcome: Outcome }
  | { status: "waiting"; wakeAt: string; pending: string[] }
  | { status: "failed"; error: string };

/** Starting and resuming runs, without Mastra's types leaking into the kitchen. */
export interface RecipeRuns {
  start(runId: string, input: RecipeInput): Promise<RecipeRunResult>;
  /** Resumes a run suspended in `wait-ci`. */
  resume(runId: string): Promise<RecipeRunResult>;
}
