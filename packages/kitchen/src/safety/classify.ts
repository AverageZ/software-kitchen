import semver from "semver";
import type { SemVer } from "semver";

import type { UpdateClassification } from "./assessment.ts";
import {
  collected,
  type ChangesEvidence,
  type EvidenceBundle,
  type EvidenceKey,
} from "./evidence.ts";
import type { DependencyType, Policy } from "./policy.ts";

/** Every evidence item, in bundle order, so summaries and lookups never depend on key order in the input. */
export const EVIDENCE_KEYS = [
  "pullRequest",
  "changes",
  "registry",
  "advisories",
  "repoPolicy",
  "checks",
  "localTests",
  "artifacts",
  "releaseNotes",
  "analysis",
  "headCheck",
] as const satisfies readonly EvidenceKey[];

/** The single-package update every gate and rubric check is about. */
export interface Update {
  package: string;
  from: string;
  to: string;
}

/** What the gates and the rubric read: the evidence, the policy, the clock, and the update under test. */
export interface EvaluationContext {
  evidence: EvidenceBundle;
  policy: Policy;
  evaluatedAt: string;
  update: Update;
  headSha: string;
}

/**
 * Riskiest first. A package listed in several sections (say a dependency in one workspace and a
 * devDependency in another) is classified by the riskiest, so eligibility can't be won by the
 * harmless copy.
 */
const DEPENDENCY_TYPE_RISK: readonly DependencyType[] = [
  "dependency",
  "peerDependency",
  "optionalDependency",
  "devDependency",
];

interface VersionDistance {
  updateType: UpdateClassification["updateType"];
  zeroMajor: boolean;
  prerelease: boolean;
}

const UNKNOWN_DISTANCE: VersionDistance = {
  updateType: "unknown",
  zeroMajor: false,
  prerelease: false,
};

/**
 * What kind of update the PR is, from the PR and the diff. Versions come from the parsed bump, and
 * the distance is plain semver without caret rules, so a 0.x patch is a patch flagged `zeroMajor`
 * rather than silently promoted to a major.
 */
export function classifyUpdate(evidence: EvidenceBundle): UpdateClassification {
  const pullRequest = evidence.pullRequest.data;
  const changes = collected(evidence.changes);
  const bump = pullRequest.bump;
  const distance = bump === null ? UNKNOWN_DISTANCE : versionDistance(bump.from, bump.to);

  return {
    forge: pullRequest.forge,
    bot: pullRequest.author.login,
    ecosystem: changes === null ? null : lockfileEcosystem(changes),
    dependencyType:
      changes === null || bump === null ? null : dependencyTypeOf(changes, bump.package),
    ...distance,
    grouped: pullRequest.updateCount !== 1 || changedDependencyCount(changes) > 1,
  };
}

function versionDistance(from: string, to: string): VersionDistance {
  const before = semver.parse(from);
  const after = semver.parse(to);

  if (before === null || after === null) return UNKNOWN_DISTANCE;

  return {
    updateType: distanceBetween(before, after),
    zeroMajor: before.major === 0 || after.major === 0,
    prerelease: before.prerelease.length > 0 || after.prerelease.length > 0,
  };
}

function distanceBetween(before: SemVer, after: SemVer): VersionDistance["updateType"] {
  const order = semver.compare(after, before);

  if (order < 0) return "downgrade";

  if (order === 0) return "unknown";

  if (after.major !== before.major) return "major";

  return after.minor === before.minor ? "patch" : "minor";
}

function lockfileEcosystem(changes: ChangesEvidence): UpdateClassification["ecosystem"] {
  const formats = new Set(changes.lockfiles.map((lockfile) => lockfile.format));

  if (formats.has("pnpm")) return "pnpm";

  return formats.has("npm") ? "npm" : null;
}

/**
 * The section the package sits in: the changed manifests first, then the head's direct dependencies,
 * for lockfile-only updates whose manifest range already allowed the new version.
 */
function dependencyTypeOf(changes: ChangesEvidence, name: string): DependencyType | null {
  const types = new Set<DependencyType>();

  for (const manifest of changes.manifests)
    for (const change of manifest.dependencyChanges)
      if (change.name === name) types.add(change.type);

  if (types.size === 0)
    for (const importer of changes.importers)
      for (const dependency of importer.dependencies)
        if (dependency.name === name) types.add(dependency.type);

  return DEPENDENCY_TYPE_RISK.find((type) => types.has(type)) ?? null;
}

/** Distinct dependency names the manifests change: one package bumped in two workspaces is one update. */
function changedDependencyCount(changes: ChangesEvidence | null): number {
  if (changes === null) return 0;

  const names = new Set<string>();

  for (const manifest of changes.manifests)
    for (const change of manifest.dependencyChanges) names.add(change.name);

  return names.size;
}

/**
 * Why the update is outside what the policy lets the kitchen judge; empty when it's in scope.
 * Out of scope means a human decides, not that the update is unsafe.
 */
export function eligibilityReasons(
  classification: UpdateClassification,
  evidence: EvidenceBundle,
  policy: Policy,
): string[] {
  const { eligibility } = policy;
  const pullRequest = evidence.pullRequest.data;
  const reasons: string[] = [];

  if (!policy.enabled) reasons.push("safety assessment is disabled for this repository");

  if (!eligibility.forges.includes(classification.forge))
    reasons.push(`forge ${classification.forge} is not eligible`);

  if (!eligibility.bots.includes(classification.bot))
    reasons.push(`author ${classification.bot} is not an eligible bot`);

  if (pullRequest.bump === null) reasons.push("no single-package update was parsed from the PR");

  if (evidence.changes.status !== "ok")
    reasons.push(
      `the diff could not be read (${evidence.changes.status}: ${evidence.changes.reason})`,
    );

  if (classification.ecosystem === null) reasons.push("no npm or pnpm lockfile changed");
  else if (!eligibility.ecosystems.includes(classification.ecosystem))
    reasons.push(`ecosystem ${classification.ecosystem} is not eligible`);

  if (classification.dependencyType === null)
    reasons.push("the updated package was not found in any manifest");
  else if (!eligibility.dependencyTypes.includes(classification.dependencyType))
    reasons.push(`${classification.dependencyType} updates are not eligible`);

  reasons.push(...versionReasons(classification, policy));

  if (pullRequest.state !== "OPEN") reasons.push(`the PR is ${pullRequest.state.toLowerCase()}`);

  if (pullRequest.isDraft) reasons.push("the PR is a draft");

  return reasons;
}

function versionReasons(classification: UpdateClassification, policy: Policy): string[] {
  const { eligibility } = policy;
  const { updateType } = classification;
  const reasons: string[] = [];

  if (updateType === "unknown" || updateType === "downgrade")
    reasons.push(
      `the version change is ${updateType === "unknown" ? "not a semver upgrade" : "a downgrade"}`,
    );
  else if (!eligibility.updateTypes.includes(updateType))
    reasons.push(`${updateType} updates are not eligible`);

  if (classification.zeroMajor && !eligibility.allowZeroMajor)
    reasons.push("0.x versions are not eligible");

  if (classification.prerelease && !eligibility.allowPrerelease)
    reasons.push("prerelease versions are not eligible");

  if (classification.grouped && !eligibility.allowGroupedUpdates)
    reasons.push("grouped updates are not eligible");

  return reasons;
}
