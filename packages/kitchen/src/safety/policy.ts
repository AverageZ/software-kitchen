import { createHash } from "node:crypto";

import { z } from "zod";

import { forgeKindSchema } from "../forge/forge.ts";

/**
 * Every rubric criterion the deterministic evaluator knows. A finding can only cite one of these; the
 * policy sets how many points each costs but can't add criteria. Zero-point criteria record what was
 * checked and found fine, so an assessment explains itself.
 */
export const CRITERIA = [
  "impact.isolated",
  "impact.build-critical",
  "impact.production-runtime",
  "graph.expected",
  "graph.unexplained-transitive",
  "graph.significant-expansion",
  "release.no-relevant-change",
  "release.notes-unavailable",
  "release.behavior-change",
  "release.explicit-incompatibility",
  "compatibility.compatible",
  "compatibility.new-peer-requirement",
  "compatibility.api-or-config",
  "verification.checks-pass",
  "verification.inadequately-tested",
  "verification.artifact-difference",
  "history.established",
  "history.unusual-release",
  "history.maintainer-change",
] as const;

export const criterionSchema = z.enum(CRITERIA);

export type Criterion = z.infer<typeof criterionSchema>;

export const severitySchema = z.enum(["low", "moderate", "high", "critical"]);

export type Severity = z.infer<typeof severitySchema>;

export const dependencyTypeSchema = z.enum([
  "dependency",
  "devDependency",
  "optionalDependency",
  "peerDependency",
]);

export type DependencyType = z.infer<typeof dependencyTypeSchema>;

export const ecosystemSchema = z.enum(["npm", "pnpm"]);

export type Ecosystem = z.infer<typeof ecosystemSchema>;

const deductionsSchema = z.strictObject(
  Object.fromEntries(CRITERIA.map((criterion) => [criterion, z.number().int().nonnegative()])),
);

/** Lowest score for each grade; anything below `D` is `F`. */
const gradeFloorsSchema = z
  .strictObject({
    A: z.number().int(),
    B: z.number().int(),
    C: z.number().int(),
    D: z.number().int(),
  })
  .refine((floors) => floors.A > floors.B && floors.B > floors.C && floors.C > floors.D, {
    message: "grade floors must descend: A > B > C > D",
  });

export const policySchema = z.strictObject({
  /** False turns the assessment off for the repository: every PR goes to a human. */
  enabled: z.boolean(),
  /** `observe` records what the kitchen would do and never approves or merges. */
  mode: z.enum(["observe", "autonomous"]),
  eligibility: z.strictObject({
    forges: z.array(forgeKindSchema),
    /** Logins whose PRs may be merged unattended, in the form the forge reports them. */
    bots: z.array(z.string()),
    ecosystems: z.array(ecosystemSchema),
    dependencyTypes: z.array(dependencyTypeSchema),
    updateTypes: z.array(z.enum(["patch", "minor", "major"])),
    allowZeroMajor: z.boolean(),
    allowPrerelease: z.boolean(),
    allowGroupedUpdates: z.boolean(),
  }),
  safety: z.strictObject({
    minimumReleaseAgeHours: z.number().nonnegative(),
    requireSecurityAssessment: z.boolean(),
    requireInstallBehaviorAssessment: z.boolean(),
    requireRequiredChecks: z.boolean(),
    /** Checks that must pass, on top of the ones the base branch's protection requires. */
    requiredChecks: z.array(z.string()),
    /** Advisory severities that fail the security gate when the update introduces them. */
    disallowedSeverities: z.array(severitySchema),
    /** File names (in any directory) an update may change. */
    allowedFileNames: z.array(z.string()),
    /** Path prefixes and file names whose change blocks the update outright: CI and executable config. */
    blockedPaths: z.array(z.string()),
    /** npm registry the lockfiles should resolve from. */
    registry: z.url(),
  }),
  /** Package-name patterns; a trailing `*` matches any suffix, e.g. `@types/*` or `eslint-*`. */
  impact: z.strictObject({
    isolated: z.array(z.string()),
    buildCritical: z.array(z.string()),
  }),
  verification: z.strictObject({
    /** Install and run the test script locally. Runs PR code, so never on a host holding merge credentials. */
    localTests: z.boolean(),
    /** Build at base and head and compare these outputs. Null to skip. Needs `localTests`. */
    artifacts: z
      .strictObject({ command: z.array(z.string()).min(1), paths: z.array(z.string()).min(1) })
      .nullable(),
  }),
  grading: z.strictObject({
    rubricVersion: z.string(),
    autonomousMergeMinimumScore: z.number().int(),
    grades: gradeFloorsSchema,
    deductions: deductionsSchema,
    /** Unexplained lockfile additions at which graph growth counts as significant. */
    significantGraphChanges: z.number().int().positive(),
    /** A release after this many days without one counts as unusual. */
    dormantReleaseDays: z.number().positive(),
  }),
  automation: z.strictObject({
    approve: z.boolean(),
    merge: z.boolean(),
    mergeMethod: z.enum(["squash", "merge", "rebase"]),
  }),
});

export type Policy = z.infer<typeof policySchema>;

/** The conservative policy every repository starts from. Overrides in `config.json` adjust it. */
export const DEFAULT_POLICY: Policy = {
  enabled: true,
  mode: "observe",
  eligibility: {
    forges: ["github"],
    bots: ["renovate[bot]"],
    ecosystems: ["npm", "pnpm"],
    dependencyTypes: ["devDependency"],
    updateTypes: ["patch"],
    allowZeroMajor: false,
    allowPrerelease: false,
    allowGroupedUpdates: false,
  },
  safety: {
    minimumReleaseAgeHours: 72,
    requireSecurityAssessment: true,
    requireInstallBehaviorAssessment: true,
    requireRequiredChecks: true,
    requiredChecks: [],
    disallowedSeverities: ["moderate", "high", "critical"],
    allowedFileNames: [
      "package.json",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
    ],
    blockedPaths: [
      ".github/",
      ".npmrc",
      ".pnpmfile.cjs",
      ".yarnrc.yml",
      "pnpm-workspace.yaml",
      ".husky/",
    ],
    registry: "https://registry.npmjs.org",
  },
  impact: {
    isolated: [
      "@types/*",
      "eslint",
      "eslint-*",
      "@eslint/*",
      "typescript-eslint",
      "@typescript-eslint/*",
      "prettier",
      "prettier-plugin-*",
      "oxlint",
      "oxfmt",
      "@biomejs/*",
      "stylelint",
      "stylelint-*",
      "markdownlint-cli*",
      "commitlint",
      "@commitlint/*",
      "husky",
      "lint-staged",
      "vitest",
      "@vitest/*",
      "jest",
      "@jest/*",
      "mocha",
      "chai",
      "c8",
      "nyc",
      "@testing-library/*",
      "@playwright/test",
    ],
    buildCritical: [
      "typescript",
      "vite",
      "@vitejs/*",
      "webpack",
      "webpack-*",
      "rollup",
      "@rollup/*",
      "esbuild",
      "@swc/*",
      "@babel/*",
      "babel-*",
      "tsup",
      "tsx",
      "turbo",
      "postcss",
      "tailwindcss",
      "@tailwindcss/*",
    ],
  },
  verification: { localTests: true, artifacts: null },
  grading: {
    rubricVersion: "1.0",
    autonomousMergeMinimumScore: 95,
    grades: { A: 95, B: 85, C: 70, D: 50 },
    deductions: {
      "impact.isolated": 0,
      "impact.build-critical": 10,
      "impact.production-runtime": 15,
      "graph.expected": 0,
      "graph.unexplained-transitive": 10,
      "graph.significant-expansion": 20,
      "release.no-relevant-change": 0,
      "release.notes-unavailable": 5,
      "release.behavior-change": 15,
      "release.explicit-incompatibility": 30,
      "compatibility.compatible": 0,
      "compatibility.new-peer-requirement": 10,
      "compatibility.api-or-config": 20,
      "verification.checks-pass": 0,
      "verification.inadequately-tested": 10,
      "verification.artifact-difference": 15,
      "history.established": 0,
      "history.unusual-release": 10,
      "history.maintainer-change": 25,
    },
    significantGraphChanges: 5,
    dormantReleaseDays: 365,
  },
  automation: { approve: false, merge: false, mergeMethod: "squash" },
};

/** A partial policy as written in `config.json`: any subset of the fields, nested. */
export const policyOverrideSchema = z.record(z.string(), z.json());

export type PolicyOverride = z.infer<typeof policyOverrideSchema>;

type Json = z.infer<ReturnType<typeof z.json>>;

/** Objects merge key by key; anything else, arrays included, replaces. */
function merge(base: Json, override: Json): Json {
  if (!isJsonObject(base) || !isJsonObject(override)) return override;

  const merged = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];

    merged[key] = current === undefined ? value : merge(current, value);
  }

  return merged;
}

function isJsonObject(value: Json): value is Record<string, Json> {
  return value !== null && !Array.isArray(value) && value instanceof Object;
}

/** The default policy with each override applied in order; throws naming any invalid field. */
export function resolvePolicy(overrides: readonly PolicyOverride[]): Policy {
  const base = policySchema.parse(DEFAULT_POLICY);
  let merged: Json = JSON.parse(JSON.stringify(base));

  for (const override of overrides) merged = merge(merged, override);

  const parsed = policySchema.safeParse(merged);

  if (!parsed.success) throw new Error(`Invalid safety policy: ${z.prettifyError(parsed.error)}`);

  return parsed.data;
}

/** JSON with object keys sorted, so equal values always serialize the same way. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  if (isJsonObject(value)) {
    const entries = Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`);

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * `<rubricVersion>+<digest>`: the declared rubric version plus a digest of every resolved value, so
 * two assessments share a version only if they ran under the same thresholds and deductions.
 */
export function policyVersion(policy: Policy): string {
  const digest = createHash("sha256")
    .update(canonicalJson(JSON.parse(JSON.stringify(policy))))
    .digest("hex")
    .slice(0, 12);

  return `${policy.grading.rubricVersion}+${digest}`;
}

/** Whether `name` matches one of `patterns`, where a trailing `*` matches any suffix. */
export function matchesPackage(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
  );
}
