import type { Check } from "../forge/forge.ts";
import { GATES, type SafetyAssessment } from "../safety/assessment.ts";
import { type Policy, policyVersion } from "../safety/policy.ts";

/**
 * The pull request as the merge identity sees it right before acting. The stored assessment is about
 * one head commit on one base branch; this is what proves the PR is still that commit and that the
 * host would accept the merge without anyone bypassing its rules.
 */
export interface LivePullRequest {
  headSha: string;
  baseRef: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  /** REST form: apps are `<slug>[bot]`. */
  authorLogin: string;
  /** GitHub's `mergeStateStatus`, e.g. `CLEAN`, `BLOCKED`, `BEHIND`; null if GitHub hasn't computed it. */
  mergeStateStatus: string | null;
  /** `NONE`: no review rule applies. Null: unknown. */
  reviewDecision: "APPROVED" | "REVIEW_REQUIRED" | "CHANGES_REQUESTED" | "NONE" | null;
  /** Checks reported for `headSha`. */
  checks: Check[];
}

export interface AuthorizationRequest {
  assessment: SafetyAssessment;
  /** The policy in force now, which must be the one the assessment ran under. */
  policy: Policy;
  live: LivePullRequest;
  /** Login of the identity that would approve and merge. */
  approver: string;
  /** Checks the base branch requires, on top of `policy.safety.requiredChecks`. */
  requiredChecks: readonly string[];
}

export interface MergeAuthorization {
  authorized: boolean;
  /** Approve with the merge identity before merging: the host requires a review and policy allows it. */
  approve: boolean;
  /** Every unmet condition; empty when authorized. */
  reasons: string[];
}

/** Merge states in which GitHub merges without further action. */
const MERGEABLE_STATES: readonly string[] = ["CLEAN", "HAS_HOOKS"];

function assessmentReasons(assessment: SafetyAssessment, policy: Policy): string[] {
  const reasons: string[] = [];

  if (!assessment.eligible) reasons.push("update is not eligible for unattended merge");

  if (assessment.eligible) {
    for (const gate of GATES) {
      const result = assessment.gates.find((candidate) => candidate.gate === gate);

      if (result === undefined) reasons.push(`${gate} gate missing from the assessment`);
      else if (result.status !== "PASS" && result.status !== "NOT_APPLICABLE") {
        reasons.push(`${gate} gate is ${result.status}`);
      }
    }
  }

  if (assessment.missingEvidence.length > 0) {
    reasons.push(`missing evidence: ${assessment.missingEvidence.join(", ")}`);
  }

  const minimum = policy.grading.autonomousMergeMinimumScore;

  if (assessment.grade !== "A" || assessment.score === null || assessment.score < minimum) {
    reasons.push(
      `grade ${assessment.grade ?? "none"} with score ${assessment.score ?? "none"}; needs A and at least ${minimum}`,
    );
  }

  if (assessment.decision !== "AUTO_MERGE") {
    reasons.push(`decision is ${assessment.decision}, not AUTO_MERGE`);
  }

  return reasons;
}

function policyReasons(assessment: SafetyAssessment, policy: Policy): string[] {
  const reasons: string[] = [];

  if (!policy.enabled) reasons.push("safety policy is disabled for this repository");

  if (policy.mode !== "autonomous") reasons.push("observation mode: would merge");

  if (!policy.automation.merge) reasons.push("automation.merge is off");

  if (policyVersion(policy) !== assessment.policyVersion) {
    reasons.push("policy changed since evaluation; re-evaluate");
  }

  return reasons;
}

function identityReasons(request: AuthorizationRequest): string[] {
  const { assessment, live, approver } = request;
  const reasons: string[] = [];

  if (live.headSha !== assessment.headSha) {
    reasons.push(
      `PR head changed after evaluation: evaluated ${assessment.headSha}, now ${live.headSha}`,
    );
  }

  if (live.baseRef !== assessment.baseRef) {
    reasons.push(`base branch changed: evaluated ${assessment.baseRef}, now ${live.baseRef}`);
  }

  if (live.state !== "OPEN") reasons.push(`PR is ${live.state}`);

  if (live.isDraft) reasons.push("PR is a draft");

  const bot = assessment.updateClassification.bot;

  if (live.authorLogin !== bot) {
    reasons.push(`PR author is ${live.authorLogin}, but the assessment was for ${bot}`);
  }

  if (approver === live.authorLogin) {
    reasons.push("approving identity must differ from the PR author");
  }

  return reasons;
}

function checkReasons(request: AuthorizationRequest): string[] {
  const { live, policy } = request;
  const reasons: string[] = [];
  const required = new Set([...request.requiredChecks, ...policy.safety.requiredChecks]);

  for (const name of [...required].toSorted()) {
    const reported = live.checks.filter((check) => check.name === name);

    if (reported.length === 0) reasons.push(`required check ${name} missing on the live head`);
    else if (reported.some((check) => check.state !== "pass")) {
      reasons.push(`required check ${name} has not passed on the live head`);
    }
  }

  for (const check of live.checks) {
    if (check.state === "fail") reasons.push(`check ${check.name} failed on the live head`);

    if (check.state === "pending") reasons.push(`check ${check.name} is still pending`);
  }

  return reasons;
}

function reviewReasons(live: LivePullRequest, policy: Policy): string[] {
  const reasons: string[] = [];

  if (live.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes were requested");

  if (live.reviewDecision === null) reasons.push("review state is unknown");

  const canApprove = live.reviewDecision === "REVIEW_REQUIRED" && policy.automation.approve;

  if (live.reviewDecision === "REVIEW_REQUIRED" && !policy.automation.approve) {
    reasons.push("needs an approving review and automation.approve is off");
  }

  const status = live.mergeStateStatus;
  const blockedOnlyByReview = status === "BLOCKED" && canApprove;

  if (status === null || (!MERGEABLE_STATES.includes(status) && !blockedOnlyByReview)) {
    reasons.push(`merge state is ${status ?? "unknown"}; GitHub would not merge it as is`);
  }

  return reasons;
}

/**
 * Whether the merge identity may approve and merge this PR now. Pure: the stored assessment must
 * still say AUTO_MERGE under the policy in force, and the live PR must be exactly what was assessed
 * and mergeable without bypassing any repository rule. Every unmet condition is reported, so a refusal
 * explains itself in one pass.
 */
export function authorizeMerge(request: AuthorizationRequest): MergeAuthorization {
  const { assessment, policy, live } = request;

  const reasons = [
    ...assessmentReasons(assessment, policy),
    ...policyReasons(assessment, policy),
    ...identityReasons(request),
    ...checkReasons(request),
    ...reviewReasons(live, policy),
  ];

  const authorized = reasons.length === 0;

  return {
    authorized,
    approve: authorized && live.reviewDecision === "REVIEW_REQUIRED",
    reasons,
  };
}
