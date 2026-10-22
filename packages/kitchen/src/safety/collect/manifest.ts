import { z } from "zod";

import type { manifestChangeSchema } from "../evidence.ts";

import { DEPENDENCY_SECTIONS } from "./lockfile.ts";

export type ManifestChange = z.infer<typeof manifestChangeSchema>;

const SECTION_NAMES = new Set<string>(DEPENDENCY_SECTIONS.map(([section]) => section));

const manifestSchema = z.record(z.string(), z.json());

const dependencySectionSchema = z.record(z.string(), z.string());

/**
 * How a `package.json` changed: dependency ranges per section, and the dotted path of every other
 * field that differs (`scripts.test`, `engines.node`, …). Null text means the file didn't exist.
 * Anything besides a dependency range is something a dependency update has no business changing.
 */
export function diffManifest(
  path: string,
  beforeText: string | null,
  afterText: string | null,
): ManifestChange {
  const before = beforeText === null ? {} : manifestSchema.parse(JSON.parse(beforeText));
  const after = afterText === null ? {} : manifestSchema.parse(JSON.parse(afterText));
  const dependencyChanges: ManifestChange["dependencyChanges"] = [];
  const otherBefore = new Map<string, string>();
  const otherAfter = new Map<string, string>();

  for (const [section, type] of DEPENDENCY_SECTIONS) {
    const old = dependencySectionSchema.parse(before[section] ?? {});
    const current = dependencySectionSchema.parse(after[section] ?? {});
    const names = new Set([...Object.keys(old), ...Object.keys(current)]);

    for (const name of [...names].toSorted()) {
      const from = old[name] ?? null;
      const to = current[name] ?? null;

      if (from !== to) dependencyChanges.push({ name, type, from, to });
    }
  }

  for (const [key, value] of Object.entries(before)) {
    if (!SECTION_NAMES.has(key)) flatten(key, value, otherBefore);
  }

  for (const [key, value] of Object.entries(after)) {
    if (!SECTION_NAMES.has(key)) flatten(key, value, otherAfter);
  }

  const leaves = new Set([...otherBefore.keys(), ...otherAfter.keys()]);

  const otherChanges = [...leaves].flatMap((leaf) =>
    otherBefore.get(leaf) === otherAfter.get(leaf) ? [] : [leaf],
  );

  return { path, dependencyChanges, otherChanges: otherChanges.toSorted() };
}

/** Records every leaf under `prefix` as its serialized value. Arrays are compared whole. */
function flatten(prefix: string, value: z.JSONType, leaves: Map<string, string>): void {
  if (value !== null && !Array.isArray(value) && value instanceof Object) {
    const entries = Object.entries(value);

    // An empty object is still a value: adding `"scripts": {}` is a change.
    if (entries.length === 0) leaves.set(prefix, "{}");

    for (const [key, child] of entries) flatten(`${prefix}.${key}`, child, leaves);

    return;
  }

  leaves.set(prefix, JSON.stringify(value));
}
