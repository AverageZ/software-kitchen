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

/** Parses a single-package Dependabot title; null for groups and anything else. */
export function parseBumpTitle(title: string): Bump | null {
  const match = BUMP_TITLE.exec(title.trim());

  if (match === null) return null;

  const [, name, from, to, directory] = match;

  if (name === undefined || from === undefined || to === undefined) return null;

  return { package: name, from, to, directory: directory ?? null, level: bumpLevel(from, to) };
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
