import { z } from "zod";

export const bumpLevelSchema = z.enum(["patch", "minor", "major", "prerelease", "unknown"]);

export type BumpLevel = z.infer<typeof bumpLevelSchema>;

export const bumpSchema = z.object({
  package: z.string(),
  from: z.string(),
  to: z.string(),
  directory: z.string().nullable(),
  level: bumpLevelSchema,
});

export type Bump = z.infer<typeof bumpSchema>;

// Dependabot titles, optionally behind a configured commit prefix:
//   "Bump vite from 7.1.0 to 7.1.2", "chore(deps): bump vite from 7.1.0 to 7.1.2 in /web".
// Group updates ("Bump the npm group across 1 directory with 3 updates") deliberately don't match.
const BUMP_TITLE = /^(?:[^:]*:\s*)?bump (\S+) from (\S+) to (\S+?)(?: in (\S+))?$/i;

// Renovate titles, optionally behind a semantic prefix and followed by Renovate's suffixes:
//   "Update dependency vite to v7.1.2", "build(deps): update dependency execa to v10.1.1 (main)",
//   "Update dependency vite to v8 [SECURITY]". Majors name only the major, and the old version is
// only in the body. Groups ("Update all non-major dependencies", "Update vitest monorepo to v3")
// and non-package updates ("Update node.js to v24", "Update actions/checkout action to v5") don't match.
const RENOVATE_TITLE =
  /^(?:[^:]*:\s*)?update dependency (\S+) to v?(\S+?)(?: \[security\])?(?: \([^)]*\))?$/i;

// A row of Renovate's update table: "| [execa](…) | [`10.1.0` → `10.1.1`](…) |". Older Renovate wrote "->".
const RENOVATE_CHANGE = /`([^`]+)` (?:→|->) `([^`]+)`/;

// Dependabot group titles: "Bump the npm_and_yarn group across 1 directory with 3 updates",
// "chore(deps): bump the dev group in /web with 1 update".
const DEPENDABOT_GROUP_TITLE = /^(?:[^:]*:\s*)?bump the \S+ group\b.* with (\d+) updates?$/i;

/** Rows of Renovate's update table: one per dependency the PR changes. */
function renovateRows(body: string): string[] {
  return body.split("\n").filter((line) => line.startsWith("|") && RENOVATE_CHANGE.test(line));
}

/**
 * How many dependency updates a PR says it makes: the rows of Renovate's update table, 1 for a
 * single Dependabot bump, N for a Dependabot group "with N updates", and 0 when it doesn't say.
 * A PR whose title claims one update but whose count isn't 1 is a group in disguise.
 */
export function countUpdates(title: string, body: string): number {
  if (parseDependabot(title) !== null) return 1;

  const group = DEPENDABOT_GROUP_TITLE.exec(title.trim());

  if (group !== null) return Number(group[1]);

  return renovateRows(body).length;
}

/** Parses a single-package Dependabot or Renovate update; null for groups and anything else. */
export function parseBump(title: string, body: string): Bump | null {
  return parseDependabot(title) ?? parseRenovate(title, body);
}

function parseDependabot(title: string): Bump | null {
  const match = BUMP_TITLE.exec(title.trim());

  if (match === null) return null;

  const [, name, from, to, directory] = match;

  if (name === undefined || from === undefined || to === undefined) return null;

  return { package: name, from, to, directory: directory ?? null, level: bumpLevel(from, to) };
}

function parseRenovate(title: string, body: string): Bump | null {
  const match = RENOVATE_TITLE.exec(title.trim());

  if (match === null) return null;

  const [, name, titleVersion] = match;

  if (name === undefined || titleVersion === undefined) return null;

  const rows = renovateRows(body);

  // More than one row is a group the title doesn't admit to; none means the body isn't Renovate's.
  if (rows.length !== 1) return null;

  const row = rows[0] ?? "";
  const packageCell = (row.split("|")[1] ?? "").trim();
  const change = RENOVATE_CHANGE.exec(row);
  const from = change?.[1];
  const to = change?.[2];

  if (from === undefined || to === undefined) return null;

  const names = [name, `\`${name}\``];

  if (!names.includes(packageCell) && !packageCell.startsWith(`[${name}]`)) return null;

  const [plainFrom, plainTo] = [withoutRange(from), withoutRange(to)];

  if (plainTo !== titleVersion && !plainTo.startsWith(`${titleVersion}.`)) return null;

  return {
    package: name,
    from: plainFrom,
    to: plainTo,
    directory: null,
    level: bumpLevel(plainFrom, plainTo),
  };
}

/** `^1.2.3` → `1.2.3`: Renovate shows the manifest's range when it bumps one. */
function withoutRange(version: string): string {
  return version.replace(/^[~^]/, "");
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+\S*)?$/;

/**
 * How big a version change is, with caret semantics: the leftmost non-zero component acts as major.
 * So 0.3.1 → 0.4.0 is major and 0.3.1 → 0.3.2 is minor. Downgrades and non-semver versions are unknown.
 */
export function bumpLevel(from: string, to: string): BumpLevel {
  const before = VERSION.exec(from);
  const after = VERSION.exec(to);

  if (before === null || after === null) return "unknown";

  if (before[4] !== undefined || after[4] !== undefined) return "prerelease";

  const a = [Number(before[1]), Number(before[2]), Number(before[3])];
  const b = [Number(after[1]), Number(after[2]), Number(after[3])];
  const changed = a.findIndex((part, index) => part !== b[index]);

  if (changed === -1 || (b[changed] ?? 0) < (a[changed] ?? 0)) return "unknown";

  const firstNonZero = a.findIndex((part) => part !== 0);
  const leading = firstNonZero === -1 ? 2 : firstNonZero;

  if (changed <= leading) return "major";

  return changed === leading + 1 ? "minor" : "patch";
}
