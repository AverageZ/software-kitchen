import { join } from "node:path";

import type { Decider } from "../decider.ts";
import { prSlug, type Forge, type PrRef, type RepoRef } from "../forge/forge.ts";

import { analyzeReleaseNotes } from "./analysis.ts";
import { assess } from "./assess.ts";
import type { AssessmentInput, Decision, SafetyAssessment } from "./assessment.ts";
import type { AdvisorySource } from "./collect/advisories.ts";
import { collectEvidence, type CollectedEvidence } from "./collect/collect.ts";
import type { Registry } from "./collect/registry.ts";
import type { EvidenceBundle } from "./evidence.ts";
import type { Policy } from "./policy.ts";

export interface ReplayDeps {
  forge: Forge;
  decider: Decider;
  policy: (repo: RepoRef) => Policy;
  registry: (baseUrl: string) => Registry;
  advisories: (registryUrl: string) => AdvisorySource[];
  workRoot: string;
  now: () => Date;
}

export type ReplayCase =
  | {
      ok: true;
      number: number;
      /** What actually happened to the PR. */
      state: "OPEN" | "CLOSED" | "MERGED";
      /** The owner named this PR as a known regression. */
      regression: boolean;
      input: AssessmentInput;
      assessment: SafetyAssessment;
    }
  | { ok: false; number: number; error: string };

const REPLAY = "historical replay";

/**
 * Assesses a repository's past dependency-bot PRs in observation mode, newest first, across every
 * bot the host trusts. Live merge state can't be replayed, so the PR is assessed as open, unchanged,
 * and mergeable, with review rules taken from its review state; every such assumption is labeled in
 * the evidence source. It runs no PR code, so local tests are not collected. Release maturity is
 * judged at the time the PR merged, or now for PRs that never merged; advisories are today's, so a
 * release found bad later shows up.
 */
export async function* replayHistory(
  deps: ReplayDeps,
  repo: RepoRef,
  limit: number,
  regressions: ReadonlySet<number>,
): AsyncGenerator<ReplayCase> {
  const refs: PrRef[] = [];

  for (const bot of deps.forge.dependencyBots(repo))
    refs.push(...(await deps.forge.listPullRequests(repo, bot, limit)));

  const newest = refs.toSorted((a, b) => b.number - a.number).slice(0, limit);

  for (const ref of newest) {
    try {
      yield { ok: true, ...(await replayOne(deps, ref)), regression: regressions.has(ref.number) };
    } catch (error) {
      yield {
        ok: false,
        number: ref.number,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

type Replayed = Omit<Extract<ReplayCase, { ok: true }>, "ok" | "regression">;

async function replayOne(deps: ReplayDeps, ref: PrRef): Promise<Replayed> {
  const pullRequest = await deps.forge.getPullRequest(ref);
  const policy: Policy = { ...deps.policy(ref), mode: "observe" };
  const workDir = join(deps.workRoot, `${prSlug(ref).replaceAll(/[^\w.-]+/g, "-")}-replay`);

  const collected = asReplayed(
    await collectEvidence({ ...deps, workDir }, ref, pullRequest, policy, deps.now),
  );

  const now = deps.now().toISOString();
  const sha = pullRequest.headSha;
  const notRun = "historical replay runs no PR code";
  const checks = await deps.forge.getChecks(ref, sha);
  const bump = collected.pullRequest.data.bump;
  const notes = collected.releaseNotes;
  const meta = (id: string, source: string) => ({ id, source, collectedAt: now, sha });

  let analysis: EvidenceBundle["analysis"] = {
    ...meta("analysis", `model ${deps.decider.model}`),
    status: "not-collected",
    reason: "no release notes to read",
  };

  if (notes.status === "ok" && bump !== null) {
    try {
      const result = await analyzeReleaseNotes(deps.decider, {
        package: bump.package,
        from: bump.from,
        to: bump.to,
        notes: notes.data,
        notesId: notes.id,
      });

      analysis = {
        ...meta("analysis", `model ${deps.decider.model}`),
        status: "ok",
        data: result.evidence,
      };
    } catch (error) {
      analysis = {
        ...meta("analysis", `model ${deps.decider.model}`),
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const evidence: EvidenceBundle = {
    ...collected,
    localTests: { ...meta("local-tests", REPLAY), status: "not-collected", reason: notRun },
    artifacts: { ...meta("artifacts", REPLAY), status: "not-collected", reason: notRun },
    checks: {
      ...meta("checks", `${ref.host} checks`),
      status: "ok",
      data: {
        sha,
        status: checks.some((check) => check.state === "pending") ? "timed-out" : "settled",
        checks,
      },
    },
    analysis,
    headCheck: {
      ...meta("head-check", `${REPLAY}: assumed unchanged and open`),
      status: "ok",
      data: { headSha: sha, baseRef: pullRequest.baseRef, state: "OPEN" },
    },
  };

  const input: AssessmentInput = {
    evidence,
    policy,
    evaluatedAt: pullRequest.mergedAt ?? deps.now().toISOString(),
  };

  return { number: ref.number, state: pullRequest.state, input, assessment: assess(input) };
}

/** Rewrites the live-state evidence a past PR can't provide, labeling each assumption. */
function asReplayed(collected: CollectedEvidence): CollectedEvidence {
  const pr = collected.pullRequest;
  const policy = collected.repoPolicy;
  const replayed = { ...collected };

  replayed.pullRequest = {
    ...pr,
    source: `${pr.source} (${REPLAY}: assessed as open)`,
    data: { ...pr.data, state: "OPEN", isDraft: false },
  };

  if (policy.status === "ok") {
    const decision = policy.data.reviewDecision;

    replayed.repoPolicy = {
      ...policy,
      source: `${policy.source} (${REPLAY}: assumed mergeable; any review state means reviews are required)`,
      data: {
        ...policy.data,
        mergeStateStatus: "CLEAN",
        reviewDecision: decision === null || decision === "NONE" ? decision : "REVIEW_REQUIRED",
      },
    };
  }

  return replayed;
}

const DECISIONS = [
  "AUTO_MERGE",
  "INVESTIGATE",
  "HUMAN_REVIEW",
  "DEFER",
  "BLOCK",
  "INSUFFICIENT_EVIDENCE",
] as const satisfies readonly Decision[];

const STATES = ["MERGED", "CLOSED", "OPEN"] as const;

export const REPLAY_HEADER = "PR      state   decision               grade  update";

export function formatReplayCase(replayCase: ReplayCase): string {
  if (!replayCase.ok) return `#${replayCase.number}`.padEnd(8) + `error: ${replayCase.error}`;

  const { assessment } = replayCase;
  const grade = assessment.grade === null ? "-" : `${assessment.grade} ${assessment.score ?? ""}`;

  const update =
    assessment.dependency === null
      ? replayCase.input.evidence.pullRequest.data.title
      : `${assessment.dependency} ${assessment.previousVersion ?? "?"} → ${assessment.proposedVersion ?? "?"}`;

  return [
    `#${replayCase.number}`.padEnd(7),
    replayCase.state.padEnd(7),
    assessment.decision.padEnd(22),
    grade.padEnd(6),
    `${update}${replayCase.regression ? "  [known regression]" : ""}`,
  ].join(" ");
}

/** Why an assessment didn't reach AUTO_MERGE, one key per cause, for counting. */
export function holdReasons(assessment: SafetyAssessment): string[] {
  if (!assessment.eligible)
    return assessment.eligibilityReasons.map((reason) => `ineligible: ${reason}`);

  const gates = assessment.gates.flatMap((gate) =>
    gate.status === "PASS" || gate.status === "NOT_APPLICABLE"
      ? []
      : [`gate ${gate.gate}: ${gate.status}`],
  );

  if (gates.length > 0) return gates;

  if (assessment.missingEvidence.length > 0)
    return assessment.missingEvidence.map((missing) => `missing: ${missing}`);

  return assessment.deductions.flatMap((deduction) =>
    deduction.points > 0 ? [`deduction ${deduction.criterion} (−${deduction.points})`] : [],
  );
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

function count(keys: Iterable<string>): [string, number][] {
  const counts = new Map<string, number>();

  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);

  return [...counts.entries()].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * The replay's metrics. Merged PRs are ones a human accepted, which is not proof they were safe;
 * known regressions are only the ones the owner named. Suggestions are for the owner to weigh: the
 * kitchen never changes its own policy.
 */
export function formatReplaySummary(cases: readonly ReplayCase[]): string {
  const done = cases.flatMap((c) => (c.ok ? [c] : []));
  const failed = cases.length - done.length;
  const total = done.length;
  const by = (decision: Decision) => done.filter((c) => c.assessment.decision === decision);
  const autoMerge = by("AUTO_MERGE");
  const escalated = [...by("INVESTIGATE"), ...by("HUMAN_REVIEW")];
  const eligible = done.filter((c) => c.assessment.eligible);
  const gradeA = done.filter((c) => c.assessment.grade === "A");
  const insufficient = by("INSUFFICIENT_EVIDENCE");
  const badMerges = autoMerge.filter((c) => c.regression);
  const rejectedByHumans = autoMerge.filter((c) => c.state === "CLOSED");
  const held = done.filter((c) => c.assessment.decision !== "AUTO_MERGE");

  const soleHolds = held.flatMap((c) => {
    const reasons = holdReasons(c.assessment);

    return c.assessment.eligible && reasons.length === 1 ? reasons : [];
  });

  const lines = [
    `Evaluated ${total} PRs${failed === 0 ? "" : ` (${failed} could not be assessed)`}.`,
    `Eligible for autonomous merging: ${eligible.length} (${percent(eligible.length, total)}).`,
    `Grade A: ${gradeA.length} (${percent(gradeA.length, total)}).`,
    `Would merge (AUTO_MERGE): ${autoMerge.length}; estimated developer reviews avoided: ${autoMerge.length}.`,
    `Blocked: ${by("BLOCK").length}. Escalated: ${escalated.length} (investigate ${by("INVESTIGATE").length}, human review ${by("HUMAN_REVIEW").length}). Deferred: ${by("DEFER").length}.`,
    `Incomplete evidence: ${insufficient.length} (${percent(insufficient.length, total)}).`,
    `Known regressions that would have been merged: ${badMerges.length}${badMerges.length === 0 ? "" : ` (${badMerges.map((c) => `#${c.number}`).join(", ")})`}.`,
    `Would merge, but a human closed it: ${rejectedByHumans.length}${rejectedByHumans.length === 0 ? "" : ` (${rejectedByHumans.map((c) => `#${c.number}`).join(", ")}); read these`}.`,
    "",
    `decision               ${STATES.map((state) => state.toLowerCase().padEnd(8)).join("")}`.trimEnd(),
    ...DECISIONS.map((decision) =>
      `${decision.padEnd(23)}${STATES.map((state) => String(by(decision).filter((c) => c.state === state).length).padEnd(8)).join("")}`.trimEnd(),
    ),
    "",
    "Why PRs were held back (a PR can count under several):",
    ...count(held.flatMap((c) => holdReasons(c.assessment))).map(
      ([reason, n]) => `  ${String(n).padStart(4)}  ${reason}`,
    ),
  ];

  const suggestions = count(soleHolds).slice(0, 5);

  if (suggestions.length > 0) {
    lines.push(
      "",
      "Eligible PRs held by exactly one thing; candidates for a rubric or policy review (your call, the kitchen won't change its policy):",
      ...suggestions.map(([reason, n]) => `  ${String(n).padStart(4)}  ${reason}`),
    );
  }

  lines.push("", "Merged PRs were accepted by a human, which is not proof they were safe.");

  return lines.join("\n");
}
