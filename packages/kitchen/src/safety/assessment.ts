import { z } from "zod";

import { forgeKindSchema } from "../forge/forge.ts";

import { evidenceBundleSchema, modelFindingSchema } from "./evidence.ts";
import { criterionSchema, dependencyTypeSchema, ecosystemSchema, policySchema } from "./policy.ts";

export const GATES = [
  "identity",
  "change-scope",
  "dependency-integrity",
  "security",
  "install-behavior",
  "release-maturity",
  "compatibility",
  "ci",
  "repository-policy",
  "evidence-currency",
] as const;

export const gateIdSchema = z.enum(GATES);

export type GateId = z.infer<typeof gateIdSchema>;

export const gateResultSchema = z.strictObject({
  gate: gateIdSchema,
  status: z.enum(["PASS", "FAIL", "INCONCLUSIVE", "NOT_APPLICABLE"]),
  /**
   * What a FAIL or INCONCLUSIVE does to the decision. `block`: never merge this update. `escalate`: a
   * human must look. `defer`: a temporary condition, retry at `retryAt`. `insufficient-evidence`: the
   * gate couldn't be checked. Null for PASS and NOT_APPLICABLE.
   */
  disposition: z.enum(["block", "escalate", "defer", "insufficient-evidence"]).nullable(),
  reasons: z.array(z.string()),
  /** Ids of the evidence items the gate read. */
  evidence: z.array(z.string()),
  /** For `defer`: the earliest time the condition can clear, if known. */
  retryAt: z.string().nullable(),
});

export type GateResult = z.infer<typeof gateResultSchema>;

export const updateClassificationSchema = z.strictObject({
  forge: forgeKindSchema,
  bot: z.string(),
  /** From the lockfiles the update changes; null if it changes none. */
  ecosystem: ecosystemSchema.nullable(),
  /** The manifest section the dependency is in; null if not found. */
  dependencyType: dependencyTypeSchema.nullable(),
  /** Plain semver distance, without caret semantics: 0.3.1 → 0.3.2 is a patch. */
  updateType: z.enum(["patch", "minor", "major", "downgrade", "unknown"]),
  /** Either version is `0.x`. */
  zeroMajor: z.boolean(),
  prerelease: z.boolean(),
  /** The PR updates more than one dependency. */
  grouped: z.boolean(),
});

export type UpdateClassification = z.infer<typeof updateClassificationSchema>;

export const DIMENSIONS = [
  "impact",
  "graph",
  "release",
  "compatibility",
  "verification",
  "history",
] as const;

export const findingSchema = z.strictObject({
  /** `f1`, `f2`, …, in the order the evaluator produced them. */
  id: z.string(),
  dimension: z.enum(DIMENSIONS),
  criterion: criterionSchema,
  /** What the finding is about, e.g. the package or a transitive package. */
  component: z.string(),
  /** Evidence item ids that support it. */
  evidence: z.array(z.string()),
  explanation: z.string(),
  /** `evaluator` for deterministic findings, `model:<name>` for accepted model findings. */
  source: z.string(),
  /** Findings sharing a root are one underlying observation and deduct at most once. */
  root: z.string(),
});

export type Finding = z.infer<typeof findingSchema>;

export const deductionSchema = z.strictObject({
  criterion: criterionSchema,
  points: z.number().int().nonnegative(),
  root: z.string(),
  /** Every finding with this root; only the costliest criterion among them deducts. */
  findings: z.array(z.string()),
});

export type Deduction = z.infer<typeof deductionSchema>;

export const decisionSchema = z.enum([
  "AUTO_MERGE",
  "INVESTIGATE",
  "HUMAN_REVIEW",
  "DEFER",
  "BLOCK",
  "INSUFFICIENT_EVIDENCE",
]);

export type Decision = z.infer<typeof decisionSchema>;

export const gradeSchema = z.enum(["A", "B", "C", "D", "F"]);

export type Grade = z.infer<typeof gradeSchema>;

export const STAGES = ["classify", "eligibility", "gates", "rubric", "decision"] as const;

export const stageResultSchema = z.strictObject({
  stage: z.enum(STAGES),
  status: z.enum(["completed", "skipped"]),
  summary: z.string(),
});

export const safetyAssessmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** `host/project`, e.g. `github.com/octo/app`. */
  repository: z.string(),
  pullRequestNumber: z.number().int(),
  pullRequestUrl: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  /** The merge base the diff was taken from; null if the changes weren't collected. */
  mergeBaseSha: z.string().nullable(),
  headSha: z.string(),
  dependency: z.string().nullable(),
  previousVersion: z.string().nullable(),
  proposedVersion: z.string().nullable(),
  updateClassification: updateClassificationSchema,
  eligible: z.boolean(),
  /** Why the update is out of scope; empty when eligible. */
  eligibilityReasons: z.array(z.string()),
  stages: z.array(stageResultSchema),
  gates: z.array(gateResultSchema),
  /** Summary of every evidence item: what was collected, from where, for which commit. */
  evidence: z.array(
    z.strictObject({
      id: z.string(),
      source: z.string(),
      collectedAt: z.string(),
      sha: z.string().nullable(),
      status: z.enum(["ok", "not-collected", "unavailable", "error"]),
      reason: z.string().nullable(),
    }),
  ),
  findings: z.array(findingSchema),
  /** Model findings the evaluator refused, with why. They deduct nothing. */
  rejectedFindings: z.array(z.strictObject({ finding: modelFindingSchema, reason: z.string() })),
  deductions: z.array(deductionSchema),
  /** Evidence a grade needs that is missing; a grade is given only when this is empty. */
  missingEvidence: z.array(z.string()),
  score: z.number().int().nullable(),
  grade: gradeSchema.nullable(),
  decision: decisionSchema,
  /** For DEFER: when to evaluate again, if known. */
  retryAt: z.string().nullable(),
  /** One line per reason, most decisive first. */
  explanation: z.array(z.string()),
  /** Whether the policy would let the kitchen act on this assessment, before live revalidation. */
  authorization: z.strictObject({
    mode: z.enum(["observe", "autonomous"]),
    /** Every static condition holds: an AUTO_MERGE decision and a policy that allows merging. */
    permitted: z.boolean(),
    approve: z.boolean(),
    reasons: z.array(z.string()),
  }),
  policyVersion: z.string(),
  rubricVersion: z.string(),
  evaluatedAt: z.string(),
});

export type SafetyAssessment = z.infer<typeof safetyAssessmentSchema>;

/**
 * Everything needed to reproduce an assessment: the normalized evidence, the resolved policy, and
 * the evaluation time. `assess(record)` must return the same assessment every time.
 */
export const assessmentInputSchema = z.strictObject({
  evidence: evidenceBundleSchema,
  policy: policySchema,
  evaluatedAt: z.string(),
});

export type AssessmentInput = z.infer<typeof assessmentInputSchema>;
