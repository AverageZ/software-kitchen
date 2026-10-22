import {
  safetyAssessmentSchema,
  type AssessmentInput,
  type Decision,
  type GateResult,
  type Grade,
  type SafetyAssessment,
  type UpdateClassification,
} from "./assessment.ts";
import {
  classifyUpdate,
  eligibilityReasons,
  EVIDENCE_KEYS,
  type EvaluationContext,
} from "./classify.ts";
import { collected } from "./evidence.ts";
import { DISPOSITION_SEVERITY, evaluateGates, latest, type Disposition } from "./gates.ts";
import { policyVersion, type Policy } from "./policy.ts";
import { evaluateRubric, type RubricResult } from "./rubric.ts";

interface Verdict {
  decision: Decision;
  retryAt: string | null;
  grade: Grade | null;
}

type Stage = SafetyAssessment["stages"][number];

/**
 * The deterministic safety assessment of a dependency-update PR: classify, check eligibility, run
 * the hard gates, grade with the rubric, decide. Pure: the same input always yields a deep-equal
 * assessment, so `kitchen merge` can prove a stored decision reproduces before acting on it. The
 * result is validated against the contract, so drift fails here rather than downstream.
 */
export function assess(input: AssessmentInput): SafetyAssessment {
  const { evidence, policy, evaluatedAt } = input;
  const pullRequest = evidence.pullRequest.data;
  const changes = collected(evidence.changes);
  const bump = pullRequest.bump;
  const classification = classifyUpdate(evidence);
  const ineligibility = eligibilityReasons(classification, evidence, policy);

  const context: EvaluationContext | null =
    ineligibility.length === 0 && bump !== null
      ? {
          evidence,
          policy,
          evaluatedAt,
          update: { package: bump.package, from: bump.from, to: bump.to },
          headSha: pullRequest.headSha,
        }
      : null;

  const gates = context === null ? [] : evaluateGates(context);
  const rubric = context === null ? null : evaluateRubric(context);
  const missingEvidence = [...new Set(rubric?.missing.map((entry) => entry.id) ?? [])].toSorted();

  const verdict =
    context === null
      ? { decision: "HUMAN_REVIEW" as const, retryAt: null, grade: null }
      : decide(gates, rubric, policy);

  const repoPolicy = collected(evidence.repoPolicy);

  const permitted =
    verdict.decision === "AUTO_MERGE" && policy.mode === "autonomous" && policy.automation.merge;

  return safetyAssessmentSchema.parse({
    schemaVersion: 1,
    repository: `${pullRequest.host}/${pullRequest.project}`,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.url,
    baseRef: pullRequest.baseRef,
    baseSha: pullRequest.baseSha,
    mergeBaseSha: changes?.mergeBaseSha ?? null,
    headSha: pullRequest.headSha,
    dependency: bump?.package ?? null,
    previousVersion: bump?.from ?? null,
    proposedVersion: bump?.to ?? null,
    updateClassification: classification,
    eligible: context !== null,
    eligibilityReasons: ineligibility,
    stages: stages(classification, ineligibility, gates, rubric, verdict),
    gates,
    evidence: EVIDENCE_KEYS.map((key) => {
      const item = evidence[key];

      return {
        id: item.id,
        source: item.source,
        collectedAt: item.collectedAt,
        sha: item.sha,
        status: item.status,
        reason: item.status === "ok" ? null : item.reason,
      };
    }),
    findings: rubric?.findings ?? [],
    rejectedFindings: rubric?.rejectedFindings ?? [],
    deductions: rubric?.deductions ?? [],
    missingEvidence,
    score: rubric?.score ?? null,
    grade: verdict.grade,
    decision: verdict.decision,
    retryAt: verdict.retryAt,
    explanation: explain(ineligibility, gates, rubric, verdict, policy),
    authorization: {
      mode: policy.mode,
      permitted,
      approve:
        permitted && policy.automation.approve && repoPolicy?.reviewDecision === "REVIEW_REQUIRED",
      reasons: authorizationReasons(verdict.decision, policy),
    },
    policyVersion: policyVersion(policy),
    rubricVersion: policy.grading.rubricVersion,
    evaluatedAt,
  });
}

/** The worst disposition across the gates, or null when every gate passed or didn't apply. */
function worstDisposition(gates: readonly GateResult[]): Disposition | null {
  let worst: Disposition | null = null;

  for (const gate of gates)
    if (
      gate.disposition !== null &&
      (worst === null || DISPOSITION_SEVERITY[gate.disposition] > DISPOSITION_SEVERITY[worst])
    )
      worst = gate.disposition;

  return worst;
}

const DECISION_BY_DISPOSITION: Record<Disposition, Decision> = {
  block: "BLOCK",
  escalate: "HUMAN_REVIEW",
  defer: "DEFER",
  "insufficient-evidence": "INSUFFICIENT_EVIDENCE",
};

/**
 * Gates first, in precedence order, then evidence completeness, then the grade. No score can lift
 * a failed gate: the grade only decides among updates every gate let through.
 */
function decide(
  gates: readonly GateResult[],
  rubric: RubricResult | null,
  policy: Policy,
): Verdict {
  const score = rubric?.score ?? null;
  const grade = score === null ? null : gradeFor(score, policy);
  const worst = worstDisposition(gates);

  if (worst !== null) {
    const retryAt =
      worst === "defer"
        ? latest(gates.map((gate) => (gate.disposition === "defer" ? gate.retryAt : null)))
        : null;

    return { decision: DECISION_BY_DISPOSITION[worst], retryAt, grade };
  }

  if (score === null || grade === null)
    return { decision: "INSUFFICIENT_EVIDENCE", retryAt: null, grade: null };

  if (grade === "A" && score >= policy.grading.autonomousMergeMinimumScore)
    return { decision: "AUTO_MERGE", retryAt: null, grade };

  return {
    decision: grade === "D" || grade === "F" ? "HUMAN_REVIEW" : "INVESTIGATE",
    retryAt: null,
    grade,
  };
}

function gradeFor(score: number, policy: Policy): Grade {
  const floors = policy.grading.grades;

  if (score >= floors.A) return "A";

  if (score >= floors.B) return "B";

  if (score >= floors.C) return "C";

  return score >= floors.D ? "D" : "F";
}

function authorizationReasons(decision: Decision, policy: Policy): string[] {
  const reasons: string[] = [];

  if (decision !== "AUTO_MERGE") reasons.push(`decision is ${decision}, not AUTO_MERGE`);

  if (policy.mode === "observe")
    reasons.push(
      decision === "AUTO_MERGE"
        ? "observation mode: would merge"
        : "observation mode: records only",
    );

  if (!policy.automation.merge) reasons.push("automation.merge is off");

  return reasons;
}

function stages(
  classification: UpdateClassification,
  ineligibility: readonly string[],
  gates: readonly GateResult[],
  rubric: RubricResult | null,
  verdict: Verdict,
): Stage[] {
  const dependencyType = classification.dependencyType ?? "unknown section";
  const ecosystem = classification.ecosystem ?? "no lockfile";
  const skipped = "skipped: the update is not eligible";

  return [
    {
      stage: "classify",
      status: "completed",
      summary: `${classification.updateType} update of a ${dependencyType} (${ecosystem}) by ${classification.bot}`,
    },
    {
      stage: "eligibility",
      status: "completed",
      summary: ineligibility.length === 0 ? "eligible" : `ineligible: ${ineligibility.join("; ")}`,
    },
    rubric === null
      ? { stage: "gates", status: "skipped", summary: skipped }
      : { stage: "gates", status: "completed", summary: gateSummary(gates) },
    rubric === null
      ? { stage: "rubric", status: "skipped", summary: skipped }
      : { stage: "rubric", status: "completed", summary: rubricSummary(rubric) },
    { stage: "decision", status: "completed", summary: verdict.decision },
  ];
}

function gateSummary(gates: readonly GateResult[]): string {
  const counts = new Map<GateResult["status"], number>();

  for (const gate of gates) counts.set(gate.status, (counts.get(gate.status) ?? 0) + 1);

  const parts = [...counts].map(([status, count]) => `${count} ${status}`);

  return `${gates.length} gates: ${parts.join(", ")}`;
}

function rubricSummary(rubric: RubricResult): string {
  if (rubric.score === null)
    return `no score: missing ${[...new Set(rubric.missing.map((entry) => entry.id))].toSorted().join(", ")}`;

  return `score ${rubric.score} from ${rubric.findings.length} findings and ${rubric.deductions.length} deductions`;
}

/** Human lines, most decisive first: the decision and its cause, then every other problem. */
function explain(
  ineligibility: readonly string[],
  gates: readonly GateResult[],
  rubric: RubricResult | null,
  verdict: Verdict,
  policy: Policy,
): string[] {
  if (rubric === null)
    return [
      "HUMAN_REVIEW: out of scope for unattended merge (ineligible, not unsafe)",
      ...ineligibility.map((reason) => `ineligible: ${reason}`),
    ];

  const troubled = gates
    .flatMap((gate) =>
      gate.disposition === null ? [] : [{ gate, severity: DISPOSITION_SEVERITY[gate.disposition] }],
    )
    .toSorted((a, b) => b.severity - a.severity);

  const gateLines = troubled.flatMap(({ gate }) =>
    gate.reasons.map(
      (reason) =>
        `${gate.gate} gate ${gate.status === "FAIL" ? "failed" : "inconclusive"}: ${reason}`,
    ),
  );

  const missingLines = rubric.missing.map(
    (entry) => `missing evidence ${entry.id}: ${entry.reason}`,
  );

  const deductionLines = rubric.deductions.map((deduction) => {
    const cause = rubric.findings.find(
      (entry) => entry.root === deduction.root && entry.criterion === deduction.criterion,
    );

    return `-${deduction.points} ${deduction.criterion}: ${cause?.explanation ?? deduction.root}`;
  });

  const rejectedLines = rubric.rejectedFindings.map(
    (rejected) => `rejected model finding ${rejected.finding.criterion}: ${rejected.reason}`,
  );

  return [
    headline(verdict, gateLines, rubric, policy),
    ...gateLines,
    ...missingLines,
    ...deductionLines,
    ...rejectedLines,
  ];
}

function headline(
  verdict: Verdict,
  gateLines: readonly string[],
  rubric: RubricResult,
  policy: Policy,
): string {
  const { decision } = verdict;
  const first = gateLines[0];
  const retry = verdict.retryAt === null ? "" : ` (retry at ${verdict.retryAt})`;

  if (first !== undefined) return `${decision}: ${first}${retry}`;

  if (rubric.score === null)
    return `${decision}: no grade without ${[...new Set(rubric.missing.map((entry) => entry.id))].toSorted().join(", ")}`;

  const graded = `score ${rubric.score} (${verdict.grade ?? "ungraded"})`;
  const minimum = policy.grading.autonomousMergeMinimumScore;

  if (decision === "AUTO_MERGE")
    return `AUTO_MERGE: every gate passed and ${graded} meets the minimum ${minimum}`;

  return `${decision}: every gate passed but ${graded} is below the minimum ${minimum} for unattended merge`;
}
