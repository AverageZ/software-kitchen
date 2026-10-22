import { join } from "node:path";

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import type { Decider } from "../../decider.ts";
import { parsePrUrl, prSlug, type Forge, type PrRef, type RepoRef } from "../../forge/forge.ts";
import { parseBump } from "../../recipes/dependabot-bump/bump.ts";
import { COMMENT_MARKER, renderComment } from "../../recipes/dependabot-bump/comment.ts";
import {
  analyzedSchema,
  assessedSchema,
  ciCheckedSchema,
  ciWaitSchema,
  collectedSchema,
  inspectedSchema,
  outcomeSchema,
  recipeInputSchema,
  verifiedSchema,
  type Outcome,
} from "../../recipes/dependabot-bump/schemas.ts";
import { verifyLocally } from "../../recipes/dependabot-bump/verify.ts";
import { RECIPES } from "../../routing.ts";
import { analyzeReleaseNotes } from "../../safety/analysis.ts";
import { assess } from "../../safety/assess.ts";
import type { SafetyAssessment } from "../../safety/assessment.ts";
import type { AdvisorySource } from "../../safety/collect/advisories.ts";
import { collectEvidence } from "../../safety/collect/collect.ts";
import type { Registry } from "../../safety/collect/registry.ts";
import type { EvidenceBundle } from "../../safety/evidence.ts";
import type { Policy } from "../../safety/policy.ts";

/** Attempt and time limits per stage. Command time limits live in `VERIFY_LIMITS`. */
export const RECIPE_LIMITS = {
  /** Extra attempts after a stage throws (host, git, or model outage). Results such as failing tests are not retried. */
  retries: { inspect: 2, collect: 1, verify: 1, waitCi: 2, assess: 2, report: 2 },
  /** How long a run sleeps between CI checks. */
  ciPollMs: 2 * 60_000,
  /** Total time a run waits for CI before deferring. */
  ciWaitMs: 60 * 60_000,
  /** When a deferred run comes back if the assessment doesn't say when the condition clears. */
  deferMs: 6 * 60 * 60_000,
};

export interface RecipeDeps {
  forge: Forge;
  decider: Decider;
  /** The safety policy for a repository. */
  policy: (repo: RepoRef) => Policy;
  /** npm registry client for a registry URL. */
  registry: (baseUrl: string) => Registry;
  /** Advisory databases to check, given the policy's registry URL. */
  advisories: (registryUrl: string) => AdvisorySource[];
  /** Parent directory for per-run checkouts. */
  workRoot: string;
  now: () => Date;
}

/** What each decision asks of the owner, as the WorkItem's next action. */
const NEXT_ACTIONS = {
  BLOCK: "Don't merge this update; close the PR and check the release (see the PR comment)",
  HUMAN_REVIEW: "Review the PR yourself; the PR comment lists what the kitchen found",
  INVESTIGATE: "Look into the deductions listed in the PR comment, then merge or close",
  INSUFFICIENT_EVIDENCE:
    "Fix what kept evidence from being collected (see the PR comment), then rerun with `kitchen run`",
} as const satisfies Partial<Record<SafetyAssessment["decision"], string>>;

/** How a finished assessment leaves the WorkItem. */
function settle(
  assessment: SafetyAssessment,
  now: Date,
): Pick<Outcome, "status" | "reason" | "nextAction" | "retryAt"> {
  const why = assessment.explanation[0] ?? assessment.decision;

  switch (assessment.decision) {
    case "AUTO_MERGE":
      return { status: "done", reason: null, nextAction: null, retryAt: null };
    case "DEFER":
      return {
        status: "deferred",
        reason: why,
        nextAction: null,
        retryAt:
          assessment.retryAt ?? new Date(now.getTime() + RECIPE_LIMITS.deferMs).toISOString(),
      };
    default:
      return {
        status: "parked",
        reason: why,
        nextAction: NEXT_ACTIONS[assessment.decision],
        retryAt: null,
      };
  }
}

function itemMeta(id: string, source: string, sha: string | null, now: Date) {
  return { id, source, sha, collectedAt: now.toISOString() };
}

/**
 * Inspect, collect evidence, test, wait for CI, ask the model for release-note findings, assess, and
 * report on the PR. The recipe never approves or merges: `kitchen merge` acts on its assessments
 * with a separate identity.
 */
export function createDependabotBump(deps: RecipeDeps) {
  const inspect = createStep({
    id: "inspect",
    description:
      "Loads the PR and parses the bump; parks anything that isn't a single-package Dependabot or Renovate PR.",
    inputSchema: recipeInputSchema,
    outputSchema: inspectedSchema,
    retries: RECIPE_LIMITS.retries.inspect,
    execute: async ({ inputData, bail }) => {
      const pr = parsePrUrl(inputData.url);

      if (pr === null) throw new Error(`Not a pull request URL: ${inputData.url}`);

      const pullRequest = await deps.forge.getPullRequest(pr);
      const bump = parseBump(pullRequest.title, pullRequest.body);
      const refusal = RECIPES["dependabot-bump"].ineligibility(pullRequest);

      if (refusal !== null || bump === null) {
        return bail<Outcome>({
          status: "parked",
          reason: refusal ?? "not a single-package bump",
          nextAction: "Handle this PR by hand or with another recipe",
          retryAt: null,
          commentUrl: null,
          subject: pullRequest.title,
          input: null,
          assessment: null,
          modelCall: null,
        });
      }

      return { ...inputData, pr, pullRequest, bump, policy: deps.policy(pr) };
    },
  });

  const collect = createStep({
    id: "collect",
    description:
      "Collects evidence without running PR code: commits, changed files, manifests and lockfiles, registry metadata, advisories, merge rules, release notes.",
    inputSchema: inspectedSchema,
    outputSchema: collectedSchema,
    retries: RECIPE_LIMITS.retries.collect,
    execute: async ({ inputData, runId }) => {
      const { pr, pullRequest, policy } = inputData;

      const evidence = await collectEvidence(
        {
          forge: deps.forge,
          registry: deps.registry,
          advisories: deps.advisories,
          workDir: workDir(pr, `collect-${runId}`),
        },
        pr,
        pullRequest,
        policy,
        deps.now,
      );

      return { ...inputData, evidence };
    },
  });

  const verify = createStep({
    id: "verify",
    description:
      "If the policy allows, checks out the PR head in a fresh directory, installs, runs the tests, and compares build artifacts.",
    inputSchema: collectedSchema,
    outputSchema: verifiedSchema,
    retries: RECIPE_LIMITS.retries.verify,
    execute: async ({ inputData, runId }) => {
      const { pr, pullRequest, bump, policy } = inputData;
      const headSha = pullRequest.headSha;

      if (!policy.verification.localTests) {
        const reason = "verification.localTests is off for this repository";
        const now = deps.now();

        return {
          ...inputData,
          tests: null,
          localTests: {
            ...itemMeta("local-tests", "kitchen", headSha, now),
            status: "not-collected" as const,
            reason,
          },
          artifacts: {
            ...itemMeta("artifacts", "kitchen", headSha, now),
            status: "not-collected" as const,
            reason,
          },
        };
      }

      const result = await verifyLocally({
        checkout: deps.forge.checkout(pr),
        headSha,
        baseRef: pullRequest.baseRef,
        directory: bump.directory,
        workDir: workDir(pr, runId),
        artifacts: policy.verification.artifacts,
      });

      const meta = itemMeta("artifacts", "local checkout", headSha, deps.now());

      const notCollected =
        policy.verification.artifacts === null
          ? "verification.artifacts is not configured"
          : `skipped: local tests ${result.tests.status}`;

      return {
        ...inputData,
        tests: result.tests,
        localTests: { ...meta, id: "local-tests", status: "ok" as const, data: result.tests },
        artifacts:
          result.artifacts === null
            ? { ...meta, status: "not-collected" as const, reason: notCollected }
            : { ...meta, ...result.artifacts },
      };
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
      const { pr, pullRequest, tests } = inputData;
      const sha = pullRequest.headSha;
      const source = `${pr.host} checks`;

      if (tests !== null && tests.status !== "passed") {
        return {
          ...inputData,
          checks: {
            ...itemMeta("checks", source, sha, deps.now()),
            status: "not-collected" as const,
            reason: `not waited for: local tests ${tests.status}`,
          },
        };
      }

      const checks = await deps.forge.getChecks(pr, sha);
      const pending = checks.flatMap((check) => (check.state === "pending" ? [check.name] : []));
      const now = deps.now();
      const settled = { ...itemMeta("checks", source, sha, now), status: "ok" as const };

      if (pending.length === 0)
        return {
          ...inputData,
          checks: { ...settled, data: { sha, status: "settled" as const, checks } },
        };

      const since = suspendData?.since ?? now.toISOString();

      if (now.getTime() - Date.parse(since) >= RECIPE_LIMITS.ciWaitMs)
        return {
          ...inputData,
          checks: { ...settled, data: { sha, status: "timed-out" as const, checks } },
        };

      return suspend({
        since,
        wakeAt: new Date(now.getTime() + RECIPE_LIMITS.ciPollMs).toISOString(),
        pending,
      });
    },
  });

  const analyze = createStep({
    id: "analyze",
    description:
      "Asks the model for structured findings about the release notes. Its answers are evidence for the rubric, never a verdict.",
    inputSchema: ciCheckedSchema,
    outputSchema: analyzedSchema,
    execute: async ({ inputData }) => {
      const { bump, evidence, checks, localTests, pullRequest } = inputData;
      const notes = evidence.releaseNotes;
      const sha = pullRequest.headSha;
      const meta = itemMeta("analysis", `model ${deps.decider.model}`, sha, deps.now());

      if (notes.status !== "ok")
        return {
          ...inputData,
          analysis: {
            ...meta,
            status: "not-collected" as const,
            reason: "no release notes to read",
          },
          modelCall: null,
        };

      const failed =
        (localTests.status === "ok" && localTests.data.status !== "passed") ||
        (checks.status === "ok" && checks.data.checks.some((check) => check.state === "fail"));

      if (failed)
        return {
          ...inputData,
          analysis: {
            ...meta,
            status: "not-collected" as const,
            reason: "tests or CI failed; not worth a model call",
          },
          modelCall: null,
        };

      try {
        const result = await analyzeReleaseNotes(deps.decider, {
          package: bump.package,
          from: bump.from,
          to: bump.to,
          notes: notes.data,
          notesId: notes.id,
        });

        return {
          ...inputData,
          analysis: { ...meta, status: "ok" as const, data: result.evidence },
          modelCall: {
            model: result.call.model,
            verdict: result.call.verdict,
            confidence: result.call.confidence,
            answers: JSON.stringify(result.call.answers),
          },
        };
      } catch (error) {
        // A model outage is missing evidence, which the evaluator handles; it never counts as a pass.
        const reason = error instanceof Error ? error.message : String(error);

        return {
          ...inputData,
          analysis: { ...meta, status: "error" as const, reason },
          modelCall: null,
        };
      }
    },
  });

  const assessStep = createStep({
    id: "assess",
    description:
      "Re-reads the PR head, then applies the deterministic policy: eligibility, hard gates, rubric, decision.",
    inputSchema: analyzedSchema,
    outputSchema: assessedSchema,
    retries: RECIPE_LIMITS.retries.assess,
    execute: async ({ inputData }) => {
      const { pr, policy, evidence } = inputData;
      const current = await deps.forge.getPullRequest(pr);
      const now = deps.now();

      const bundle: EvidenceBundle = {
        ...evidence,
        localTests: inputData.localTests,
        artifacts: inputData.artifacts,
        checks: inputData.checks,
        analysis: inputData.analysis,
        headCheck: {
          ...itemMeta("head-check", `${pr.host} api`, current.headSha, now),
          status: "ok",
          data: { headSha: current.headSha, baseRef: current.baseRef, state: current.state },
        },
      };

      const input = { evidence: bundle, policy, evaluatedAt: now.toISOString() };

      return { ...inputData, input, assessment: assess(input) };
    },
  });

  const report = createStep({
    id: "report",
    description: "Posts or updates the PR comment with the assessment and settles the WorkItem.",
    inputSchema: assessedSchema,
    outputSchema: outcomeSchema,
    retries: RECIPE_LIMITS.retries.report,
    execute: async ({ inputData }) => {
      const { pr, bump, tests, assessment, input, modelCall } = inputData;
      const body = renderComment({ assessment, tests });
      const commentUrl = await deps.forge.upsertComment(pr, COMMENT_MARKER, body);

      return {
        ...settle(assessment, deps.now()),
        commentUrl,
        subject: `${bump.package} ${bump.from} → ${bump.to} (${bump.level})`,
        input,
        assessment,
        modelCall,
      };
    },
  });

  function workDir(pr: PrRef, name: string): string {
    return join(deps.workRoot, `${prSlug(pr).replaceAll(/[^\w.-]+/g, "-")}-${name}`);
  }

  const workflow = createWorkflow({
    id: "dependabot-bump",
    description:
      "Recipe: collect evidence on a Dependabot or Renovate bump, assess it against the safety policy, and report on the PR.",
    inputSchema: recipeInputSchema,
    outputSchema: outcomeSchema,
  })
    .then(inspect)
    .then(collect)
    .then(verify)
    .then(waitCi)
    .then(analyze)
    .then(assessStep)
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
