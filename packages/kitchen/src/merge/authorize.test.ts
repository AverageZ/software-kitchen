import assert from "node:assert/strict";
import { test } from "node:test";

import { GATES, type SafetyAssessment, safetyAssessmentSchema } from "../safety/assessment.ts";
import { type Policy, policyVersion, resolvePolicy } from "../safety/policy.ts";

import { type AuthorizationRequest, authorizeMerge, type LivePullRequest } from "./authorize.ts";

const HEAD = "a".repeat(40);

const POLICY: Policy = resolvePolicy([
  { mode: "autonomous", automation: { merge: true, approve: true } },
]);

const ASSESSMENT: SafetyAssessment = safetyAssessmentSchema.parse({
  schemaVersion: 1,
  repository: "github.com/octo/app",
  pullRequestNumber: 12,
  pullRequestUrl: "https://github.com/octo/app/pull/12",
  baseRef: "main",
  baseSha: "b".repeat(40),
  mergeBaseSha: "b".repeat(40),
  headSha: HEAD,
  dependency: "@types/node",
  previousVersion: "22.1.0",
  proposedVersion: "22.1.1",
  updateClassification: {
    forge: "github",
    bot: "renovate[bot]",
    ecosystem: "pnpm",
    dependencyType: "devDependency",
    updateType: "patch",
    zeroMajor: false,
    prerelease: false,
    grouped: false,
  },
  eligible: true,
  eligibilityReasons: [],
  stages: [
    { stage: "classify", status: "completed", summary: "patch devDependency update" },
    { stage: "eligibility", status: "completed", summary: "eligible" },
    { stage: "gates", status: "completed", summary: "all gates pass" },
    { stage: "rubric", status: "completed", summary: "score 100" },
    { stage: "decision", status: "completed", summary: "AUTO_MERGE" },
  ],
  gates: GATES.map((gate) => ({
    gate,
    status: "PASS",
    disposition: null,
    reasons: [],
    evidence: ["pull-request"],
    retryAt: null,
  })),
  evidence: [
    {
      id: "pull-request",
      source: "github",
      collectedAt: "2026-10-22T12:00:00.000Z",
      sha: HEAD,
      status: "ok",
      reason: null,
    },
  ],
  findings: [
    {
      id: "f1",
      dimension: "impact",
      criterion: "impact.isolated",
      component: "@types/node",
      evidence: ["pull-request"],
      explanation: "type definitions only",
      source: "evaluator",
      root: "impact",
    },
  ],
  rejectedFindings: [],
  deductions: [{ criterion: "impact.isolated", points: 0, root: "impact", findings: ["f1"] }],
  missingEvidence: [],
  score: 100,
  grade: "A",
  decision: "AUTO_MERGE",
  retryAt: null,
  explanation: ["AUTO_MERGE: every gate passed with score 100"],
  authorization: { mode: "autonomous", permitted: true, approve: true, reasons: [] },
  policyVersion: policyVersion(POLICY),
  rubricVersion: POLICY.grading.rubricVersion,
  evaluatedAt: "2026-10-22T12:00:00.000Z",
});

const LIVE: LivePullRequest = {
  headSha: HEAD,
  baseRef: "main",
  state: "OPEN",
  isDraft: false,
  authorLogin: "renovate[bot]",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "REVIEW_REQUIRED",
  checks: [
    { name: "build", state: "pass" },
    { name: "lint", state: "pass" },
  ],
};

interface Overrides {
  assessment?: Partial<SafetyAssessment>;
  policy?: Policy;
  live?: Partial<LivePullRequest>;
  approver?: string;
}

function request(overrides: Overrides = {}): AuthorizationRequest {
  return {
    assessment: { ...ASSESSMENT, ...overrides.assessment },
    policy: overrides.policy ?? POLICY,
    live: { ...LIVE, ...overrides.live },
    approver: overrides.approver ?? "kitchen-merge[bot]",
    requiredChecks: ["build"],
  };
}

function reasonsFor(overrides: Overrides): string[] {
  const result = authorizeMerge(request(overrides));

  assert.equal(result.authorized, false);
  assert.equal(result.approve, false);

  return result.reasons;
}

test("a matching AUTO_MERGE assessment on an unchanged PR is authorized, approving first", () => {
  assert.deepEqual(authorizeMerge(request()), { authorized: true, approve: true, reasons: [] });
});

test("a clean PR that needs no review merges without approving", () => {
  const result = authorizeMerge(
    request({ live: { mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" } }),
  );

  assert.deepEqual(result, { authorized: true, approve: false, reasons: [] });
});

test("no review rule (NONE) merges without approving; an unknown review state refuses", () => {
  assert.deepEqual(
    authorizeMerge(request({ live: { mergeStateStatus: "CLEAN", reviewDecision: "NONE" } })),
    { authorized: true, approve: false, reasons: [] },
  );

  assert.deepEqual(reasonsFor({ live: { mergeStateStatus: "CLEAN", reviewDecision: null } }), [
    "review state is unknown",
  ]);
});

test("observation mode refuses, and the changed policy forces re-evaluation", () => {
  const reasons = reasonsFor({
    policy: resolvePolicy([{ automation: { merge: true, approve: true } }]),
  });

  assert.ok(reasons.includes("observation mode: would merge"));
  assert.ok(reasons.includes("policy changed since evaluation; re-evaluate"));
});

test("a policy changed since evaluation refuses even when it still allows merging", () => {
  const reasons = reasonsFor({
    policy: resolvePolicy([
      { mode: "autonomous", automation: { merge: true, approve: true } },
      { safety: { minimumReleaseAgeHours: 24 } },
    ]),
  });

  assert.deepEqual(reasons, ["policy changed since evaluation; re-evaluate"]);
});

test("a PR head that moved after evaluation refuses", () => {
  const reasons = reasonsFor({ live: { headSha: "c".repeat(40) } });

  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? "", /PR head changed after evaluation/);
});

test("the approving identity must differ from the PR author", () => {
  const reasons = reasonsFor({ approver: "renovate[bot]" });

  assert.deepEqual(reasons, ["approving identity must differ from the PR author"]);
});

test("a required review with automation.approve off refuses, naming both conditions", () => {
  const policy = resolvePolicy([
    { mode: "autonomous", automation: { merge: true, approve: false } },
  ]);

  const reasons = reasonsFor({
    policy,
    assessment: { policyVersion: policyVersion(policy) },
  });

  assert.deepEqual(reasons, [
    "needs an approving review and automation.approve is off",
    "merge state is BLOCKED; GitHub would not merge it as is",
  ]);
});

test("a failing, pending, or missing required check refuses", () => {
  assert.deepEqual(reasonsFor({ live: { checks: [{ name: "build", state: "fail" }] } }), [
    "required check build has not passed on the live head",
    "check build failed on the live head",
  ]);

  assert.deepEqual(reasonsFor({ live: { checks: [{ name: "build", state: "pending" }] } }), [
    "required check build has not passed on the live head",
    "check build is still pending",
  ]);

  assert.deepEqual(reasonsFor({ live: { checks: [{ name: "lint", state: "pass" }] } }), [
    "required check build missing on the live head",
  ]);

  assert.deepEqual(
    reasonsFor({
      live: {
        checks: [
          { name: "build", state: "pass" },
          { name: "e2e", state: "fail" },
        ],
      },
    }),
    ["check e2e failed on the live head"],
  );
});

test("a branch that is behind or conflicting refuses with the status named", () => {
  assert.deepEqual(reasonsFor({ live: { mergeStateStatus: "BEHIND" } }), [
    "merge state is BEHIND; GitHub would not merge it as is",
  ]);

  assert.deepEqual(reasonsFor({ live: { mergeStateStatus: "DIRTY" } }), [
    "merge state is DIRTY; GitHub would not merge it as is",
  ]);

  assert.deepEqual(reasonsFor({ live: { mergeStateStatus: null } }), [
    "merge state is unknown; GitHub would not merge it as is",
  ]);
});

test("BLOCKED is accepted only when the missing review is the one the kitchen will give", () => {
  assert.deepEqual(
    reasonsFor({ live: { mergeStateStatus: "BLOCKED", reviewDecision: "APPROVED" } }),
    ["merge state is BLOCKED; GitHub would not merge it as is"],
  );
});

test("requested changes refuse", () => {
  const reasons = reasonsFor({
    live: { reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "CLEAN" },
  });

  assert.deepEqual(reasons, ["changes were requested"]);
});

test("a decision other than AUTO_MERGE refuses", () => {
  const reasons = reasonsFor({ assessment: { decision: "INVESTIGATE", score: 90, grade: "B" } });

  assert.deepEqual(reasons, [
    "grade B with score 90; needs A and at least 95",
    "decision is INVESTIGATE, not AUTO_MERGE",
  ]);
});

test("a gate that did not pass refuses, as do missing evidence and ineligibility", () => {
  const gates = ASSESSMENT.gates.map((gate) =>
    gate.gate === "ci"
      ? { ...gate, status: "INCONCLUSIVE" as const, disposition: "defer" as const }
      : gate,
  );

  assert.deepEqual(reasonsFor({ assessment: { gates } }), ["ci gate is INCONCLUSIVE"]);

  assert.deepEqual(reasonsFor({ assessment: { missingEvidence: ["checks"] } }), [
    "missing evidence: checks",
  ]);

  assert.deepEqual(reasonsFor({ assessment: { eligible: false, gates: [] } }), [
    "update is not eligible for unattended merge",
  ]);
});

test("a closed draft PR by another author refuses on every count", () => {
  const reasons = reasonsFor({
    live: { state: "CLOSED", isDraft: true, authorLogin: "mallory", baseRef: "release" },
  });

  assert.deepEqual(reasons, [
    "base branch changed: evaluated main, now release",
    "PR is CLOSED",
    "PR is a draft",
    "PR author is mallory, but the assessment was for renovate[bot]",
  ]);
});
