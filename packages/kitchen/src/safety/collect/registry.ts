import semver from "semver";
import { z } from "zod";

import type { LockedPackage, RegistryEvidence, VersionInfo } from "../evidence.ts";

const REGISTRY_TIMEOUT_MS = 30_000;

/** Added packages looked up per update; beyond this the transitive data is marked incomplete. */
export const TRANSITIVE_LIMIT = 50;

export type FetchFn = typeof fetch;

const stringsSchema = z.record(z.string(), z.string()).catch({});

const accountsSchema = z.array(z.object({ name: z.string() })).catch([]);

// Packuments are decoded loosely: decade-old releases carry `engines` arrays, string maintainers,
// and other oddities. A malformed field reads as absent instead of failing the whole lookup.
const manifestSchema = z.object({
  version: z.string(),
  dependencies: stringsSchema.optional(),
  optionalDependencies: stringsSchema.optional(),
  peerDependencies: stringsSchema.optional(),
  peerDependenciesMeta: z
    .record(z.string(), z.object({ optional: z.boolean().optional() }).catch({}))
    .catch({})
    .optional(),
  scripts: stringsSchema.optional(),
  gypfile: z.boolean().optional().catch(undefined),
  engines: z
    .object({ node: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  _npmUser: z.object({ name: z.string() }).optional().catch(undefined),
  maintainers: accountsSchema.optional(),
  deprecated: z.string().optional().catch(undefined),
  dist: z
    .object({
      integrity: z.string().optional(),
      tarball: z.string().optional(),
      attestations: z.json().optional(),
    })
    .catch({}),
});

export const packumentSchema = z.object({
  name: z.string(),
  versions: z.record(z.string(), manifestSchema).catch({}),
  time: stringsSchema.optional(),
  maintainers: accountsSchema.optional(),
});

/** A package's full registry document: every version's manifest and publish time. */
export type Packument = z.infer<typeof packumentSchema>;

/** An npm-compatible registry. */
export interface Registry {
  /** Base URL, recorded as the evidence's source. */
  readonly url: string;
  /** The package's packument, or null if the registry doesn't have the package. */
  packument(name: string): Promise<Packument | null>;
}

/** A registry over HTTP. Unauthenticated: public metadata is all the assessment needs. */
export function createNpmRegistry(baseUrl: string, fetchFn: FetchFn = fetch): Registry {
  const url = baseUrl.replace(/\/+$/, "");

  return {
    url,

    async packument(name: string): Promise<Packument | null> {
      // `@scope/name` → `@scope%2fname`, the form registries expect in the path.
      const path = name.startsWith("@")
        ? `@${encodeURIComponent(name.slice(1))}`
        : encodeURIComponent(name);

      const response = await fetchFn(`${url}/${path}`, {
        // The full document, not the abbreviated one: only it has publish times and maintainers.
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });

      if (response.status === 404) return null;

      if (!response.ok) throw new Error(`${url} answered ${response.status} for ${name}`);

      return packumentSchema.parse(await response.json());
    },
  };
}

/** A package version the lockfile adds, with whatever the registry knows about its package. */
export interface TransitiveLookup {
  name: string;
  version: string;
  /** Null when the registry doesn't have the package. */
  packument: Packument | null;
  /** Versions of the same package the lockfile removes. */
  replaces: readonly string[];
}

/** The scripts npm runs when installing a package. */
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

/** What the registry says about one version; null if it doesn't list it. */
export function versionInfo(packument: Packument | null, version: string): VersionInfo | null {
  const manifest = packument?.versions[version];

  if (packument === null || manifest === undefined) return null;

  const meta = manifest.peerDependenciesMeta ?? {};

  const scripts = Object.entries(manifest.scripts ?? {}).flatMap(([name, script]) =>
    INSTALL_SCRIPTS.includes(name) ? [[name, script] as const] : [],
  );

  return {
    version,
    publishedAt: packument.time?.[version] ?? null,
    integrity: manifest.dist.integrity ?? null,
    tarball: manifest.dist.tarball ?? null,
    installScripts: Object.fromEntries(scripts),
    gypfile: manifest.gypfile ?? false,
    dependencies: manifest.dependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {},
    peerDependencies: manifest.peerDependencies ?? {},
    optionalPeers: Object.keys(meta)
      .flatMap((name) => (meta[name]?.optional === true ? [name] : []))
      .toSorted(),
    engines: { node: manifest.engines?.node ?? null },
    publisher: manifest._npmUser?.name ?? null,
    maintainers: (manifest.maintainers ?? packument.maintainers ?? [])
      .map((account) => account.name)
      .toSorted(),
    provenance: manifest.dist.attestations !== undefined,
    deprecated: manifest.deprecated ?? null,
  };
}

/**
 * The newest stable release published before `version`, in any release line, so the evaluator can
 * tell a routine patch from a release after years of silence.
 */
export function previousRelease(
  packument: Packument | null,
  version: string,
): RegistryEvidence["previousRelease"] {
  const times = packument?.time ?? {};
  const published = times[version];

  if (published === undefined) return null;

  let previous: RegistryEvidence["previousRelease"] = null;

  for (const [candidate, publishedAt] of Object.entries(times)) {
    if (semver.valid(candidate) === null || semver.prerelease(candidate) !== null) continue;

    if (Date.parse(publishedAt) >= Date.parse(published)) continue;

    if (previous === null || Date.parse(publishedAt) > Date.parse(previous.publishedAt))
      previous = { version: candidate, publishedAt };
  }

  return previous;
}

/** Arguments of `registryEvidence`: the update and what was looked up for it. */
export interface RegistryFacts {
  registry: string;
  packument: Packument | null;
  package: string;
  from: string;
  to: string;
  transitive: readonly TransitiveLookup[];
  /** False when some added packages weren't looked up. */
  transitiveComplete: boolean;
}

/** Registry evidence for an update, from packuments already fetched. Pure. */
export function registryEvidence(facts: RegistryFacts): RegistryEvidence {
  const transitive: RegistryEvidence["transitive"] = [];
  let complete = facts.transitiveComplete;

  for (const lookup of facts.transitive) {
    const info = versionInfo(lookup.packument, lookup.version);

    if (info === null) {
      complete = false;
      continue;
    }

    transitive.push({
      name: lookup.name,
      version: lookup.version,
      installScripts: info.installScripts,
      gypfile: info.gypfile,
      integrity: info.integrity,
      dependencies: info.dependencies,
      optionalDependencies: info.optionalDependencies,
      replaced: lookup.replaces.flatMap((version) => {
        const previous = versionInfo(lookup.packument, version);

        return previous === null
          ? []
          : [{ version, installScripts: previous.installScripts, gypfile: previous.gypfile }];
      }),
    });
  }

  return {
    registry: facts.registry,
    package: facts.package,
    from: versionInfo(facts.packument, facts.from),
    to: versionInfo(facts.packument, facts.to),
    previousRelease: previousRelease(facts.packument, facts.to),
    transitive,
    transitiveComplete: complete,
  };
}

/** The update being looked up: package and versions from the PR, lockfile changes from its lockfiles. */
export interface RegistryQuery {
  package: string;
  from: string;
  to: string;
  added: readonly LockedPackage[];
  removed: readonly LockedPackage[];
}

/**
 * Fetches the updated package and up to `TRANSITIVE_LIMIT` other packages the lockfiles add. A
 * registry failure throws; a package the registry doesn't have is recorded as missing.
 */
export async function collectRegistry(
  registry: Registry,
  query: RegistryQuery,
): Promise<RegistryEvidence> {
  const others = new Map<string, LockedPackage>();

  for (const locked of query.added) {
    if (locked.name === query.package && locked.version === query.to) continue;

    others.set(`${locked.name}@${locked.version}`, locked);
  }

  const sorted = [...others.keys()].toSorted();
  const wanted = sorted.slice(0, TRANSITIVE_LIMIT).flatMap((key) => others.get(key) ?? []);
  const names = [...new Set([query.package, ...wanted.map((locked) => locked.name)])];

  const packuments = new Map(
    await Promise.all(names.map(async (name) => [name, await registry.packument(name)] as const)),
  );

  return registryEvidence({
    registry: registry.url,
    packument: packuments.get(query.package) ?? null,
    package: query.package,
    from: query.from,
    to: query.to,
    transitive: wanted.map((locked) => ({
      name: locked.name,
      version: locked.version,
      packument: packuments.get(locked.name) ?? null,
      replaces: [
        ...new Set(
          query.removed.flatMap((removed) =>
            removed.name === locked.name ? [removed.version] : [],
          ),
        ),
      ],
    })),
    transitiveComplete: sorted.length <= TRANSITIVE_LIMIT,
  });
}
