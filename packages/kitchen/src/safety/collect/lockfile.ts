import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { DependencyType } from "../policy.ts";
import type { DirectDependency, LockedPackage, LockfileChange } from "../evidence.ts";

/** Lockfile names the collector reads, by basename. */
export const LOCKFILE_NAMES = ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json"];

export type LockfileFormat = LockfileChange["format"];

/** Direct dependencies of one workspace directory (`.` for the root). */
export interface Importer {
  path: string;
  dependencies: DirectDependency[];
}

export interface ParsedLockfile {
  format: LockfileFormat;
  lockfileVersion: string;
  /** Every locked package version, once each. */
  packages: LockedPackage[];
  importers: Importer[];
}

/** Manifest sections whose entries are dependencies, and the type each declares. */
export const DEPENDENCY_SECTIONS = [
  ["dependencies", "dependency"],
  ["devDependencies", "devDependency"],
  ["optionalDependencies", "optionalDependency"],
  ["peerDependencies", "peerDependency"],
] as const satisfies readonly (readonly [string, DependencyType])[];

const pnpmDependenciesSchema = z
  .record(z.string(), z.object({ specifier: z.string(), version: z.string() }))
  .optional();

const pnpmImporterSchema = z.object({
  dependencies: pnpmDependenciesSchema,
  devDependencies: pnpmDependenciesSchema,
  optionalDependencies: pnpmDependenciesSchema,
});

type PnpmImporter = z.infer<typeof pnpmImporterSchema>;

// A v6 lockfile for a single project lists its dependencies at the top level, like an importer.
const pnpmLockSchema = pnpmImporterSchema.extend({
  lockfileVersion: z.union([z.string(), z.number()]),
  importers: z.record(z.string(), pnpmImporterSchema).optional(),
  packages: z
    .record(
      z.string(),
      z.object({
        resolution: z.object({
          integrity: z.string().optional(),
          tarball: z.string().optional(),
        }),
        name: z.string().optional(),
        version: z.string().optional(),
        requiresBuild: z.boolean().optional(),
      }),
    )
    .nullish(),
});

const npmDependenciesSchema = z.record(z.string(), z.string()).optional();

const npmEntrySchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  resolved: z.string().optional(),
  integrity: z.string().optional(),
  link: z.boolean().optional(),
  hasInstallScript: z.boolean().optional(),
  dependencies: npmDependenciesSchema,
  devDependencies: npmDependenciesSchema,
  optionalDependencies: npmDependenciesSchema,
  peerDependencies: npmDependenciesSchema,
});

type NpmEntry = z.infer<typeof npmEntrySchema>;

const npmLockSchema = z.object({
  lockfileVersion: z.number(),
  packages: z.record(z.string(), npmEntrySchema),
});

/**
 * Reads a pnpm (v6–v9) or npm (v2, v3) lockfile, chosen by file name. Throws for other files and
 * older lockfile versions: what they lock can't be read reliably, so it isn't evidence.
 */
export function parseLockfile(path: string, text: string): ParsedLockfile {
  const name = basename(path);

  if (name === "pnpm-lock.yaml") return parsePnpm(text);

  if (name === "package-lock.json" || name === "npm-shrinkwrap.json") return parseNpm(text);

  throw new Error(`${path} is not a pnpm or npm lockfile`);
}

/** Splits `name@version`, where a scoped name starts with `@`. */
function splitAt(spec: string): { name: string; version: string } | null {
  const at = spec.lastIndexOf("@");

  if (at <= 0) return null;

  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/** `1.2.3(react@18.0.0)` → `1.2.3`: pnpm appends the peers a package was resolved against. */
function withoutPeers(version: string): string {
  const paren = version.indexOf("(");

  return paren === -1 ? version : version.slice(0, paren);
}

function parsePnpm(text: string): ParsedLockfile {
  const lock = pnpmLockSchema.parse(parseYaml(text));
  const lockfileVersion = String(lock.lockfileVersion);
  const major = Number.parseInt(lockfileVersion, 10);

  if (!(major >= 6)) throw new Error(`pnpm lockfile version ${lockfileVersion} is not supported`);

  const packages: LockedPackage[] = [];

  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    // v6 keys are `/name@version(peers)`; v9 keys are `name@version` and keep peers in `snapshots`.
    const spec = splitAt(withoutPeers(key.replace(/^\//, "")));
    const name = entry.name ?? spec?.name;
    const version = entry.version ?? spec?.version;

    if (name === undefined || version === undefined) continue;

    packages.push({
      name,
      version,
      integrity: entry.resolution.integrity ?? null,
      resolved: entry.resolution.tarball ?? null,
      hasInstallScript: entry.requiresBuild ?? null,
    });
  }

  const importers = Object.entries(lock.importers ?? { ".": lock }).map(([path, importer]) => ({
    path,
    dependencies: pnpmDirectDependencies(importer),
  }));

  return { format: "pnpm", lockfileVersion, packages: dedupe(packages), importers };
}

function pnpmDirectDependencies(importer: PnpmImporter): DirectDependency[] {
  const dependencies: DirectDependency[] = [];

  for (const [section, type] of DEPENDENCY_SECTIONS) {
    if (section === "peerDependencies") continue;

    for (const [name, entry] of Object.entries(importer[section] ?? {})) {
      // Workspace packages aren't from the registry.
      if (entry.version.startsWith("link:") || entry.version.startsWith("workspace:")) continue;

      dependencies.push({
        name,
        type,
        specifier: entry.specifier,
        version: withoutPeers(entry.version),
      });
    }
  }

  return dependencies;
}

const NODE_MODULES = "node_modules/";

function parseNpm(text: string): ParsedLockfile {
  const lock = npmLockSchema.parse(JSON.parse(text));

  if (lock.lockfileVersion < 2)
    throw new Error(`npm lockfile version ${lock.lockfileVersion} is not supported`);

  const packages: LockedPackage[] = [];
  const importers: Importer[] = [];

  for (const [key, entry] of Object.entries(lock.packages)) {
    const at = key.lastIndexOf(NODE_MODULES);

    // Keys outside node_modules are the root (`""`) and workspace directories.
    if (at === -1) {
      importers.push({
        path: key === "" ? "." : key,
        dependencies: npmDirectDependencies(lock.packages, key, entry),
      });
      continue;
    }

    if (entry.link === true || entry.version === undefined) continue;

    packages.push({
      // `name` is set for aliases (`"foo": "npm:bar@1"`): the package that's actually installed.
      name: entry.name ?? key.slice(at + NODE_MODULES.length),
      version: entry.version,
      integrity: entry.integrity ?? null,
      resolved: entry.resolved ?? null,
      hasInstallScript: entry.hasInstallScript ?? false,
    });
  }

  return {
    format: "npm",
    lockfileVersion: String(lock.lockfileVersion),
    packages: dedupe(packages),
    importers,
  };
}

/** An importer's declared dependencies, resolved the way node does: nearest node_modules first. */
function npmDirectDependencies(
  entries: Readonly<Record<string, NpmEntry>>,
  importerKey: string,
  importer: NpmEntry,
): DirectDependency[] {
  const dependencies: DirectDependency[] = [];

  for (const [section, type] of DEPENDENCY_SECTIONS) {
    for (const [name, specifier] of Object.entries(importer[section] ?? {})) {
      const nested =
        importerKey === "" ? undefined : entries[`${importerKey}/${NODE_MODULES}${name}`];

      const installed = nested ?? entries[`${NODE_MODULES}${name}`];

      if (installed?.link === true) continue;

      dependencies.push({ name, type, specifier, version: installed?.version ?? null });
    }
  }

  return dependencies;
}

function packageKey(locked: LockedPackage): string {
  return `${locked.name}@${locked.version}`;
}

/** One entry per name@version; the first one listed wins. */
function dedupe(packages: readonly LockedPackage[]): LockedPackage[] {
  const byKey = new Map<string, LockedPackage>();

  for (const locked of packages) {
    if (!byKey.has(packageKey(locked))) byKey.set(packageKey(locked), locked);
  }

  return [...byKey.values()].toSorted(comparePackages);
}

function comparePackages(a: LockedPackage, b: LockedPackage): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;

  if (a.version === b.version) return 0;

  return a.version < b.version ? -1 : 1;
}

/**
 * What a lockfile change adds, removes, and re-pins. `before` is null for a new lockfile. A package
 * whose integrity changed without a version change is the strongest sign of a tampered lockfile.
 */
export function diffLockfiles(
  path: string,
  before: ParsedLockfile | null,
  after: ParsedLockfile,
): LockfileChange {
  const old = new Map((before?.packages ?? []).map((locked) => [packageKey(locked), locked]));
  const current = new Map(after.packages.map((locked) => [packageKey(locked), locked]));
  const added: LockedPackage[] = [];
  const integrityChanged: LockfileChange["integrityChanged"] = [];

  for (const [key, locked] of current) {
    const previous = old.get(key);

    if (previous === undefined) added.push(locked);
    else if (previous.integrity !== locked.integrity) {
      integrityChanged.push({
        name: locked.name,
        version: locked.version,
        before: previous.integrity,
        after: locked.integrity,
      });
    }
  }

  const removed = [...old].flatMap(([key, locked]) => (current.has(key) ? [] : [locked]));

  return {
    path,
    format: after.format,
    lockfileVersion: after.lockfileVersion,
    added,
    removed,
    integrityChanged,
  };
}
