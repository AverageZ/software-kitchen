import { z } from "zod";

import { checkSchema, forgeKindSchema, prCommitSchema, repoPolicySchema } from "../forge/forge.ts";
import { bumpSchema } from "../recipes/dependabot-bump/bump.ts";

import { criterionSchema, dependencyTypeSchema, severitySchema } from "./policy.ts";

const itemMeta = {
  /** Stable id that findings and gates cite, e.g. `registry`. */
  id: z.string(),
  /** Where the data came from, e.g. `github api`, `git`, `https://registry.npmjs.org`. */
  source: z.string(),
  collectedAt: z.string(),
  /** The commit this evidence describes; null when it isn't tied to one (registry data). */
  sha: z.string().nullable(),
};

/**
 * Normalized evidence: everything the deterministic evaluator reads. Each item records where it came
 * from, when, and which commit it describes. An item that couldn't be collected says so; the evaluator
 * treats it as missing, never as a pass.
 */
function item<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("status", [
    z.strictObject({ ...itemMeta, status: z.literal("ok"), data }),
    z.strictObject({
      ...itemMeta,
      /** `not-collected`: the policy didn't ask for it. `unavailable`: the source has none. `error`: collection failed. */
      status: z.enum(["not-collected", "unavailable", "error"]),
      reason: z.string(),
    }),
  ]);
}

/** An item that is always present: without it there is nothing to assess. */
function requiredItem<T extends z.ZodType>(data: T) {
  return z.strictObject({ ...itemMeta, status: z.literal("ok"), data });
}

export const testsSchema = z.object({
  status: z.enum(["passed", "failed", "install-failed", "timed-out", "no-tests", "unsupported"]),
  /** The command whose result `status` reports, e.g. `pnpm test`. */
  command: z.string().nullable(),
  /** Last lines of that command's output. */
  log: z.string(),
});

export type Tests = z.infer<typeof testsSchema>;

export const pullRequestEvidenceSchema = z.strictObject({
  forge: forgeKindSchema,
  host: z.string(),
  project: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  /** The single-package update parsed from title and body; null for groups and anything else. */
  bump: bumpSchema.nullable(),
  /** Rows in Renovate's update table, or 1 for a parsed Dependabot title; 0 if unknown. */
  updateCount: z.number().int().nonnegative(),
  author: z.strictObject({
    login: z.string(),
    isBot: z.boolean(),
    /** Trusted for dependency updates on this host: built in, or listed in `config.json`. */
    trustedBot: z.boolean(),
  }),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headSha: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  commits: z.array(prCommitSchema),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
});

export type PullRequestEvidence = z.infer<typeof pullRequestEvidenceSchema>;

export const lockedPackageSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  integrity: z.string().nullable(),
  /** Tarball URL, when the lockfile records one. */
  resolved: z.string().nullable(),
  /** npm's `hasInstallScript` or pnpm's `requiresBuild`; null when the lockfile doesn't say. */
  hasInstallScript: z.boolean().nullable(),
});

export type LockedPackage = z.infer<typeof lockedPackageSchema>;

export const directDependencySchema = z.strictObject({
  name: z.string(),
  type: dependencyTypeSchema,
  /** The manifest's range, e.g. `^1.2.3`. */
  specifier: z.string(),
  /** The version the lockfile resolves it to; null if the lockfile doesn't list it. */
  version: z.string().nullable(),
});

export type DirectDependency = z.infer<typeof directDependencySchema>;

export const manifestChangeSchema = z.strictObject({
  path: z.string(),
  dependencyChanges: z.array(
    z.strictObject({
      name: z.string(),
      type: dependencyTypeSchema,
      /** Range before; null if added. */
      from: z.string().nullable(),
      /** Range after; null if removed. */
      to: z.string().nullable(),
    }),
  ),
  /** Dotted paths of every other changed field, e.g. `scripts.test` or `engines.node`. */
  otherChanges: z.array(z.string()),
});

export const lockfileChangeSchema = z.strictObject({
  path: z.string(),
  format: z.enum(["npm", "pnpm"]),
  lockfileVersion: z.string(),
  /** Package versions present after but not before. */
  added: z.array(lockedPackageSchema),
  /** Package versions present before but not after. */
  removed: z.array(lockedPackageSchema),
  /** Same name and version, different integrity: the lockfile now trusts different bytes. */
  integrityChanged: z.array(
    z.strictObject({
      name: z.string(),
      version: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
    }),
  ),
});

export type LockfileChange = z.infer<typeof lockfileChangeSchema>;

export const changesEvidenceSchema = z.strictObject({
  mergeBaseSha: z.string(),
  headSha: z.string(),
  files: z.array(
    z.strictObject({
      path: z.string(),
      status: z.enum(["added", "modified", "deleted", "renamed", "other"]),
      /** For renames, where the file came from. */
      previousPath: z.string().nullable(),
    }),
  ),
  manifests: z.array(manifestChangeSchema),
  lockfiles: z.array(lockfileChangeSchema),
  /**
   * Direct dependencies at head, per workspace directory (`.` for the root), with the version each
   * resolves to. Used for peer checks.
   */
  importers: z.array(
    z.strictObject({ path: z.string(), dependencies: z.array(directDependencySchema) }),
  ),
  /** `engines.node` of the root manifest at head. */
  projectNodeEngine: z.string().nullable(),
});

export type ChangesEvidence = z.infer<typeof changesEvidenceSchema>;

export const versionInfoSchema = z.strictObject({
  version: z.string(),
  publishedAt: z.string().nullable(),
  integrity: z.string().nullable(),
  tarball: z.string().nullable(),
  /** `preinstall`, `install`, and `postinstall` scripts, by name. */
  installScripts: z.record(z.string(), z.string()),
  /** Has a `binding.gyp`, so npm runs node-gyp at install even without scripts. */
  gypfile: z.boolean(),
  dependencies: z.record(z.string(), z.string()),
  optionalDependencies: z.record(z.string(), z.string()),
  peerDependencies: z.record(z.string(), z.string()),
  /** Peers marked optional in `peerDependenciesMeta`. */
  optionalPeers: z.array(z.string()),
  engines: z.strictObject({ node: z.string().nullable() }),
  /** Account that published this version. */
  publisher: z.string().nullable(),
  maintainers: z.array(z.string()),
  /** Published with an npm provenance attestation. */
  provenance: z.boolean(),
  deprecated: z.string().nullable(),
});

export type VersionInfo = z.infer<typeof versionInfoSchema>;

export const registryEvidenceSchema = z.strictObject({
  registry: z.string(),
  package: z.string(),
  /** Null when the registry doesn't list the version. */
  from: versionInfoSchema.nullable(),
  to: versionInfoSchema.nullable(),
  /** The newest release published before `to`, in any release line. */
  previousRelease: z.strictObject({ version: z.string(), publishedAt: z.string() }).nullable(),
  /** Registry data for packages the lockfile adds besides the update itself. */
  transitive: z.array(
    z.strictObject({
      name: z.string(),
      version: z.string(),
      installScripts: z.record(z.string(), z.string()),
      gypfile: z.boolean(),
      integrity: z.string().nullable(),
      /** What this version declares, so the evaluator can trace why the lockfile pulled in others. */
      dependencies: z.record(z.string(), z.string()),
      optionalDependencies: z.record(z.string(), z.string()),
    }),
  ),
  /** False when some added packages weren't looked up (too many, or not found). */
  transitiveComplete: z.boolean(),
});

export type RegistryEvidence = z.infer<typeof registryEvidenceSchema>;

export const advisorySchema = z.strictObject({
  id: z.string(),
  /** Which source reported it, e.g. `npm audit` or `github malware`. */
  source: z.string(),
  package: z.string(),
  version: z.string(),
  severity: severitySchema,
  kind: z.enum(["vulnerability", "malware"]),
  title: z.string(),
  url: z.string().nullable(),
});

export type Advisory = z.infer<typeof advisorySchema>;

export const advisoryEvidenceSchema = z.strictObject({
  /** `name@version` of every package version the update adds, the updated package included. */
  checked: z.array(z.string()),
  /** Advisories affecting a checked version. All of them are newly introduced by the update. */
  advisories: z.array(advisorySchema),
});

export type AdvisoryEvidence = z.infer<typeof advisoryEvidenceSchema>;

export const checksEvidenceSchema = z.strictObject({
  sha: z.string(),
  /** `settled`: nothing pending. `timed-out`: still pending at the wait limit. */
  status: z.enum(["settled", "timed-out"]),
  checks: z.array(checkSchema),
});

export type ChecksEvidence = z.infer<typeof checksEvidenceSchema>;

export const releaseNotesEvidenceSchema = z.strictObject({
  /** Where the text came from, e.g. `pr body`. */
  origin: z.string(),
  /** sha256 of `text`, so a finding can be tied to exactly what the model read. */
  digest: z.string(),
  text: z.string(),
});

export type ReleaseNotesEvidence = z.infer<typeof releaseNotesEvidenceSchema>;

export const artifactsEvidenceSchema = z.strictObject({
  command: z.array(z.string()),
  /** Output paths whose content differs between base and head builds. */
  differing: z.array(z.string()),
});

/**
 * A qualitative finding from the model. It names a rubric criterion and the evidence it read; the
 * evaluator decides whether to accept it and what it costs. It carries no points.
 */
export const modelFindingSchema = z.strictObject({
  category: z.enum(["release-behavior", "compatibility"]),
  component: z.string(),
  /** A rubric criterion, or `inconclusive` when the model couldn't tell. */
  criterion: z.union([criterionSchema, z.literal("inconclusive")]),
  /** Id of the evidence item the finding rests on. */
  evidenceRef: z.string(),
  explanation: z.string(),
});

export type ModelFinding = z.infer<typeof modelFindingSchema>;

export const analysisEvidenceSchema = z.strictObject({
  model: z.string(),
  findings: z.array(modelFindingSchema),
});

export type AnalysisEvidence = z.infer<typeof analysisEvidenceSchema>;

export const headCheckEvidenceSchema = z.strictObject({
  headSha: z.string(),
  baseRef: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
});

export const evidenceBundleSchema = z.strictObject({
  pullRequest: requiredItem(pullRequestEvidenceSchema),
  changes: item(changesEvidenceSchema),
  registry: item(registryEvidenceSchema),
  advisories: item(advisoryEvidenceSchema),
  repoPolicy: item(repoPolicySchema),
  checks: item(checksEvidenceSchema),
  localTests: item(testsSchema),
  artifacts: item(artifactsEvidenceSchema),
  releaseNotes: item(releaseNotesEvidenceSchema),
  analysis: item(analysisEvidenceSchema),
  /** The PR re-read just before assessing, to catch a head that moved during collection. */
  headCheck: item(headCheckEvidenceSchema),
});

export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

export type EvidenceKey = keyof EvidenceBundle;

/** An evidence item as the evaluator sees it: collected data, or why there is none. */
export type Collected<D> =
  | { status: "ok"; data: D }
  | { status: "not-collected" | "unavailable" | "error"; reason: string };

/** The `data` of an item if it was collected, else null. */
export function collected<D>(evidence: Collected<D>): D | null {
  return evidence.status === "ok" ? evidence.data : null;
}
