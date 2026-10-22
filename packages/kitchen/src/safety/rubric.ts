import semver from "semver";

import type { Deduction, Finding, SafetyAssessment } from "./assessment.ts";
import { EVIDENCE_KEYS, type EvaluationContext, type Update } from "./classify.ts";
import {
  collected,
  type EvidenceKey,
  type LockedPackage,
  type ModelFinding,
  type RegistryEvidence,
  type VersionInfo,
} from "./evidence.ts";
import { matchesPackage, type Criterion, type Policy } from "./policy.ts";

/** A finding before the evaluator numbers it. */
type DraftFinding = Omit<Finding, "id">;

type RejectedFinding = SafetyAssessment["rejectedFindings"][number];

/** Evidence a grade needs and doesn't have, with why. */
export interface MissingEvidence {
  id: string;
  reason: string;
}

export interface RubricResult {
  findings: Finding[];
  rejectedFindings: RejectedFinding[];
  deductions: Deduction[];
  missing: MissingEvidence[];
  /** Null when evidence a grade needs is missing. */
  score: number | null;
}

interface DimensionResult {
  findings: DraftFinding[];
  missing: MissingEvidence[];
}

/** Criteria a model may cite for each category; anything else is refused, never mapped. */
const MODEL_CRITERIA: Record<ModelFinding["category"], readonly Criterion[]> = {
  "release-behavior": [
    "release.no-relevant-change",
    "release.behavior-change",
    "release.explicit-incompatibility",
  ],
  compatibility: ["compatibility.compatible", "compatibility.api-or-config"],
};

const DAY_MS = 86_400_000;

/**
 * Findings for every rubric dimension, deterministic and accepted model findings alike, and the
 * deductions they cost. Findings sharing a root are one observation: only the costliest deducts.
 */
export function evaluateRubric(context: EvaluationContext): RubricResult {
  const model = reviewModelFindings(context);

  const dimensions: DimensionResult[] = [
    { findings: [impactFinding(context)], missing: [] },
    graphFindings(context),
    releaseFindings(context, model.release),
    compatibilityFindings(context, model.compatibility),
    { findings: verificationFindings(context), missing: [] },
    historyFindings(context),
  ];

  const missing = [
    ...requiredEvidence(context),
    ...model.missing,
    ...dimensions.flatMap((dimension) => dimension.missing),
  ];

  const findings = dimensions
    .flatMap((dimension) => dimension.findings)
    .map((draft, index): Finding => ({ id: `f${index + 1}`, ...draft }));

  const deductions = deductionsFor(findings, context.policy);
  const total = deductions.reduce((sum, deduction) => sum + deduction.points, 0);

  return {
    findings,
    rejectedFindings: model.rejected,
    deductions,
    missing,
    score: missing.length === 0 ? Math.max(0, 100 - total) : null,
  };
}

function finding(update: Update, draft: Omit<DraftFinding, "component" | "source">): DraftFinding {
  return { ...draft, component: update.package, source: "evaluator" };
}

/** Evidence every grade rests on, whatever the findings say. */
function requiredEvidence(context: EvaluationContext): MissingEvidence[] {
  const { evidence, policy } = context;
  const required: EvidenceKey[] = ["changes", "registry", "checks"];

  if (policy.safety.requireSecurityAssessment) required.push("advisories");

  if (policy.verification.artifacts !== null) required.push("artifacts");

  const missing: MissingEvidence[] = [];

  for (const key of required) {
    const item = evidence[key];

    if (item.status !== "ok")
      missing.push({ id: item.id, reason: `${item.status}: ${item.reason}` });
  }

  const notes = evidence.releaseNotes;

  if (notes.status === "ok" && evidence.analysis.status !== "ok")
    missing.push({
      id: evidence.analysis.id,
      reason: `release notes exist but weren't analyzed (${evidence.analysis.status}: ${evidence.analysis.reason})`,
    });

  if (notes.status === "error" || notes.status === "not-collected")
    missing.push({ id: notes.id, reason: `${notes.status}: ${notes.reason}` });

  return missing;
}

function impactFinding(context: EvaluationContext): DraftFinding {
  const { update, policy } = context;
  const evidence = [context.evidence.pullRequest.id];

  if (matchesPackage(update.package, policy.impact.isolated))
    return finding(update, {
      dimension: "impact",
      criterion: "impact.isolated",
      evidence,
      explanation: `${update.package} is listed as isolated tooling`,
      root: "impact",
    });

  if (matchesPackage(update.package, policy.impact.buildCritical))
    return finding(update, {
      dimension: "impact",
      criterion: "impact.build-critical",
      evidence,
      explanation: `${update.package} is build-critical: it shapes what the project ships`,
      root: "impact",
    });

  return finding(update, {
    dimension: "impact",
    criterion: "impact.production-runtime",
    evidence,
    explanation: `${update.package} is not established as isolated, so it may reach production`,
    root: "impact",
  });
}

/** Own-property lookup: registry dependency maps are data, and `constructor` is a valid package name. */
function rangeIn(map: Record<string, string>, name: string): string | undefined {
  return Object.hasOwn(map, name) ? map[name] : undefined;
}

/** Packages the new version newly declares or re-ranges: lockfile additions they can explain. */
function redeclared(from: VersionInfo, to: VersionInfo): Set<string> {
  const names = new Set<string>();

  for (const declared of [to.dependencies, to.optionalDependencies])
    for (const [name, range] of Object.entries(declared))
      if ((rangeIn(from.dependencies, name) ?? rangeIn(from.optionalDependencies, name)) !== range)
        names.add(name);

  return names;
}

/**
 * Lockfile additions the update accounts for: what the new version re-declares, then, transitively,
 * what each explained addition declares in a range its added version satisfies. A new rolldown
 * pulled in by a new vite explains rolldown's new platform bindings; an addition nothing in that
 * chain declares stays unexplained. Additions the registry wasn't asked about can't explain others.
 */
function explainedAdditions(
  roots: ReadonlySet<string>,
  added: readonly LockedPackage[],
  registry: RegistryEvidence,
): Set<string> {
  const explainedNames = new Set(roots);
  const explained = new Set<string>();
  let grew = true;

  while (grew) {
    grew = false;

    for (const entry of added) {
      const key = `${entry.name}@${entry.version}`;

      if (explained.has(key) || !explainedNames.has(entry.name)) continue;

      explained.add(key);
      grew = true;

      const declarer = registry.transitive.find(
        (lookup) => lookup.name === entry.name && lookup.version === entry.version,
      );

      if (declarer === undefined) continue;

      for (const declared of [declarer.dependencies, declarer.optionalDependencies])
        for (const [name, range] of Object.entries(declared))
          if (added.some((other) => other.name === name && satisfiesRange(other.version, range)))
            explainedNames.add(name);
    }
  }

  return explained;
}

/** Whether `version` falls in `range`; ranges semver can't read (tags, URLs, aliases) never do. */
function satisfiesRange(version: string, range: string): boolean {
  return semver.validRange(range) !== null && semver.satisfies(version, range);
}

function graphFindings(context: EvaluationContext): DimensionResult {
  const { update, policy } = context;
  const changes = collected(context.evidence.changes);
  const item = context.evidence.registry;
  const registry = collected(item);

  if (changes === null || registry === null) return { findings: [], missing: [] };

  if (registry.from === null || registry.to === null)
    return {
      findings: [],
      missing: [
        {
          id: item.id,
          reason:
            "the registry doesn't list both versions, so lockfile additions can't be explained",
        },
      ],
    };

  const added = changes.lockfiles.flatMap((lockfile) =>
    lockfile.added.filter(
      (entry) => !(entry.name === update.package && entry.version === update.to),
    ),
  );

  const explained = explainedAdditions(redeclared(registry.from, registry.to), added, registry);
  const unexplained = new Set<string>();

  for (const entry of added) {
    const key = `${entry.name}@${entry.version}`;

    if (!explained.has(key)) unexplained.add(key);
  }

  const listed = [...unexplained].toSorted();
  const evidence = [context.evidence.changes.id, item.id];

  if (listed.length === 0)
    return {
      findings: [
        finding(update, {
          dimension: "graph",
          criterion: "graph.expected",
          evidence,
          explanation: `every lockfile addition is ${update.package} or something its new version's dependency chain declares`,
          root: "graph",
        }),
      ],
      missing: [],
    };

  const significant = listed.length >= policy.grading.significantGraphChanges;

  return {
    findings: [
      finding(update, {
        dimension: "graph",
        criterion: significant ? "graph.significant-expansion" : "graph.unexplained-transitive",
        evidence,
        explanation: `${listed.length} lockfile additions not explained by ${update.package}'s dependency chain: ${listed.join(", ")}`,
        root: "graph",
      }),
    ],
    missing: [],
  };
}

interface ModelReview {
  release: DraftFinding[];
  compatibility: DraftFinding[];
  rejected: RejectedFinding[];
  missing: MissingEvidence[];
}

/**
 * The model's findings, each accepted only if it cites a criterion of its category, the dependency
 * under review, and evidence that was actually collected. Identical duplicates collapse to one.
 */
function reviewModelFindings(context: EvaluationContext): ModelReview {
  const review: ModelReview = { release: [], compatibility: [], rejected: [], missing: [] };
  const item = context.evidence.analysis;

  if (item.status !== "ok") return review;

  const available = new Set<string>();

  for (const key of EVIDENCE_KEYS)
    if (context.evidence[key].status === "ok") available.add(context.evidence[key].id);

  const seen = new Set<string>();

  for (const modelFinding of item.data.findings) {
    const key = JSON.stringify([
      modelFinding.category,
      modelFinding.criterion,
      modelFinding.component,
      modelFinding.evidenceRef,
      modelFinding.explanation,
    ]);

    if (seen.has(key)) continue;

    seen.add(key);

    const rejection = rejectionReason(modelFinding, context.update, available);

    if (rejection !== null) {
      review.rejected.push({ finding: modelFinding, reason: rejection });
      continue;
    }

    const { criterion } = modelFinding;

    // `rejectionReason` already refused `inconclusive`; this only narrows the type.
    if (criterion === "inconclusive") continue;

    const accepted: DraftFinding = {
      dimension: modelFinding.category === "release-behavior" ? "release" : "compatibility",
      criterion,
      component: modelFinding.component,
      evidence: [modelFinding.evidenceRef],
      explanation: modelFinding.explanation,
      source: `model:${item.data.model}`,
      root: `model:${modelFinding.evidenceRef}`,
    };

    if (modelFinding.category === "release-behavior") review.release.push(accepted);
    else review.compatibility.push(accepted);
  }

  if (item.data.findings.some((modelFinding) => modelFinding.criterion === "inconclusive"))
    review.missing.push({ id: item.id, reason: "the model's release analysis was inconclusive" });

  return review;
}

function rejectionReason(
  modelFinding: ModelFinding,
  update: Update,
  available: Set<string>,
): string | null {
  const { criterion, category } = modelFinding;

  if (criterion === "inconclusive") return `the model could not tell: ${modelFinding.explanation}`;

  if (!MODEL_CRITERIA[category].includes(criterion))
    return `${criterion} is not a ${category} criterion`;

  if (modelFinding.component !== update.package)
    return `it is about ${modelFinding.component}, not ${update.package}`;

  if (!available.has(modelFinding.evidenceRef))
    return `it cites ${modelFinding.evidenceRef}, which is not collected evidence`;

  return null;
}

function releaseFindings(context: EvaluationContext, accepted: DraftFinding[]): DimensionResult {
  const { releaseNotes, analysis } = context.evidence;

  if (releaseNotes.status === "unavailable")
    return {
      findings: [
        finding(context.update, {
          dimension: "release",
          criterion: "release.notes-unavailable",
          evidence: [releaseNotes.id],
          explanation: `no release notes found: ${releaseNotes.reason}`,
          root: "release-notes",
        }),
        ...accepted,
      ],
      missing: [],
    };

  const unassessed =
    releaseNotes.status === "ok" && analysis.status === "ok" && accepted.length === 0;

  return {
    findings: accepted,
    missing: unassessed
      ? [{ id: analysis.id, reason: "the model gave no acceptable release-behavior finding" }]
      : [],
  };
}

function compatibilityFindings(
  context: EvaluationContext,
  accepted: DraftFinding[],
): DimensionResult {
  const { update } = context;
  const item = context.evidence.registry;
  const registry = collected(item);

  if (registry === null || registry.from === null || registry.to === null)
    return { findings: accepted, missing: [] };

  const { from, to } = registry;

  const added = Object.entries(to.peerDependencies).flatMap(([name, range]) =>
    rangeIn(from.peerDependencies, name) === undefined && !to.optionalPeers.includes(name)
      ? [`${name} ${range}`]
      : [],
  );

  const deterministic =
    added.length === 0
      ? finding(update, {
          dimension: "compatibility",
          criterion: "compatibility.compatible",
          evidence: [item.id],
          explanation: `${update.package}@${update.to} adds no required peer`,
          root: "peers",
        })
      : finding(update, {
          dimension: "compatibility",
          criterion: "compatibility.new-peer-requirement",
          evidence: [item.id],
          explanation: `${update.package}@${update.to} adds required peers: ${added.toSorted().join(", ")}`,
          root: "peers",
        });

  return { findings: [deterministic, ...accepted], missing: [] };
}

function verificationFindings(context: EvaluationContext): DraftFinding[] {
  const { update } = context;
  const { localTests, artifacts, checks } = context.evidence;
  const findings: DraftFinding[] = [];

  if (localTests.status === "ok" && localTests.data.status === "no-tests")
    findings.push(
      finding(update, {
        dimension: "verification",
        criterion: "verification.inadequately-tested",
        evidence: [localTests.id],
        explanation: "the project has no test script, so only CI exercises the update",
        root: "tests",
      }),
    );

  if (artifacts.status === "ok" && artifacts.data.differing.length > 0)
    findings.push(
      finding(update, {
        dimension: "verification",
        criterion: "verification.artifact-difference",
        evidence: [artifacts.id],
        explanation: `build outputs differ between base and head: ${artifacts.data.differing.toSorted().join(", ")}`,
        root: "artifacts",
      }),
    );

  if (findings.length === 0)
    findings.push(
      finding(update, {
        dimension: "verification",
        criterion: "verification.checks-pass",
        evidence: [checks.id],
        explanation: "no verification gap beyond what the ci gate checks",
        root: "checks",
      }),
    );

  return findings;
}

function historyFindings(context: EvaluationContext): DimensionResult {
  const { update, policy } = context;
  const item = context.evidence.registry;
  const registry = collected(item);

  if (registry === null || registry.from === null || registry.to === null)
    return { findings: [], missing: [] };

  const { from, to, previousRelease } = registry;
  const evidence = [item.id];
  const findings: DraftFinding[] = [];
  const missing: MissingEvidence[] = [];

  if (to.publisher === null)
    missing.push({
      id: item.id,
      reason: `the publisher of ${update.package}@${update.to} is unknown`,
    });
  else if (to.publisher !== from.publisher && !from.maintainers.includes(to.publisher))
    findings.push(
      finding(update, {
        dimension: "history",
        criterion: "history.maintainer-change",
        evidence,
        explanation: `${update.package}@${update.to} was published by ${to.publisher}, who neither published nor maintained ${update.from}`,
        root: "history:distribution",
      }),
    );

  if (from.provenance && !to.provenance)
    findings.push(
      finding(update, {
        dimension: "history",
        criterion: "history.maintainer-change",
        evidence,
        explanation: `${update.from} was published with provenance and ${update.to} wasn't`,
        root: "history:distribution",
      }),
    );

  if (to.publishedAt === null)
    missing.push({
      id: item.id,
      reason: `the publish time of ${update.package}@${update.to} is unknown`,
    });
  else if (previousRelease !== null) {
    const quietDays =
      (Date.parse(to.publishedAt) - Date.parse(previousRelease.publishedAt)) / DAY_MS;

    if (quietDays > policy.grading.dormantReleaseDays)
      findings.push(
        finding(update, {
          dimension: "history",
          criterion: "history.unusual-release",
          evidence,
          explanation: `${update.to} came ${Math.floor(quietDays)} days after ${previousRelease.version}, the previous release`,
          root: "history:cadence",
        }),
      );
  }

  if (findings.length === 0 && missing.length === 0)
    findings.push(
      finding(update, {
        dimension: "history",
        criterion: "history.established",
        evidence,
        explanation: `${update.package}@${update.to} comes from an existing maintainer on the usual cadence`,
        root: "history",
      }),
    );

  return { findings, missing };
}

/** Points the policy charges for a criterion. The policy schema requires every criterion. */
export function pointsFor(policy: Policy, criterion: Criterion): number {
  const points = policy.grading.deductions[criterion];

  if (points === undefined) throw new Error(`The safety policy has no deduction for ${criterion}`);

  return points;
}

/** One deduction per root that costs anything: the costliest criterion among its findings, once. */
function deductionsFor(findings: readonly Finding[], policy: Policy): Deduction[] {
  const byRoot = new Map<string, Finding[]>();

  for (const entry of findings) {
    const group = byRoot.get(entry.root);

    if (group === undefined) byRoot.set(entry.root, [entry]);
    else group.push(entry);
  }

  const deductions: Deduction[] = [];

  for (const [root, group] of byRoot) {
    let costliest: Criterion | null = null;

    for (const entry of group)
      if (costliest === null || pointsFor(policy, entry.criterion) > pointsFor(policy, costliest))
        costliest = entry.criterion;

    if (costliest === null) continue;

    const points = pointsFor(policy, costliest);

    if (points > 0)
      deductions.push({
        criterion: costliest,
        points,
        root,
        findings: group.map((entry) => entry.id),
      });
  }

  return deductions;
}
