import semver from "semver";
import { z } from "zod";

import { runChecked } from "../../exec.ts";
import type { Advisory, AdvisoryEvidence } from "../evidence.ts";
import type { Severity } from "../policy.ts";

import type { FetchFn } from "./registry.ts";

const ADVISORY_TIMEOUT_MS = 30_000;

export interface PackageVersion {
  name: string;
  version: string;
}

/** A database of known-bad package versions. */
export interface AdvisorySource {
  /** Recorded on each advisory, e.g. `npm audit`. */
  name: string;
  /** Advisories affecting any of `packages`. Throws if the source couldn't be asked. */
  check(packages: readonly PackageVersion[]): Promise<Advisory[]>;
}

const SEVERITIES = new Map<string, Severity>([
  ["info", "low"],
  ["low", "low"],
  ["moderate", "moderate"],
  ["medium", "moderate"],
  ["high", "high"],
  ["critical", "critical"],
]);

/** A severity the policy knows; anything unrecognized counts as the worst. */
function severity(value: string | null | undefined): Severity {
  return SEVERITIES.get((value ?? "").toLowerCase()) ?? "critical";
}

const MALWARE = /malware|malicious/i;

const GHSA = /GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/;

const bulkSchema = z.record(
  z.string(),
  z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      url: z.string().nullish(),
      title: z.string(),
      overview: z.string().nullish(),
      severity: z.string().nullish(),
      vulnerable_versions: z.string(),
    }),
  ),
);

/**
 * The registry's bulk advisory endpoint, the one `npm audit` uses. It answers per package name, so
 * each advisory is kept only for versions its range actually covers.
 */
export function npmAuditSource(registryUrl: string, fetchFn: FetchFn = fetch): AdvisorySource {
  const name = "npm audit";
  const endpoint = `${registryUrl.replace(/\/+$/, "")}/-/npm/v1/security/advisories/bulk`;

  return {
    name,

    async check(packages: readonly PackageVersion[]): Promise<Advisory[]> {
      const versions = new Map<string, string[]>();

      for (const pkg of packages)
        versions.set(pkg.name, [...(versions.get(pkg.name) ?? []), pkg.version]);

      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(Object.fromEntries(versions)),
        signal: AbortSignal.timeout(ADVISORY_TIMEOUT_MS),
      });

      if (!response.ok) throw new Error(`${endpoint} answered ${response.status}`);

      const report = bulkSchema.parse(await response.json());
      const advisories: Advisory[] = [];

      for (const pkg of packages) {
        for (const advisory of report[pkg.name] ?? []) {
          if (
            !semver.satisfies(pkg.version, advisory.vulnerable_versions, {
              includePrerelease: true,
            })
          )
            continue;

          const text = `${advisory.title}\n${advisory.overview ?? ""}`;

          advisories.push({
            id: GHSA.exec(advisory.url ?? "")?.[0] ?? String(advisory.id),
            source: name,
            package: pkg.name,
            version: pkg.version,
            severity: severity(advisory.severity),
            kind: MALWARE.test(text) ? "malware" : "vulnerability",
            title: advisory.title,
            url: advisory.url ?? null,
          });
        }
      }

      return advisories;
    },
  };
}

/** Runs `gh` with these arguments and returns its stdout; throws on failure. */
export type RunGh = (args: readonly string[]) => Promise<string>;

const ghMalwareSchema = z.array(
  z.object({
    ghsa_id: z.string(),
    summary: z.string(),
    severity: z.string().nullish(),
    html_url: z.string().nullish(),
  }),
);

function runGh(args: readonly string[]): Promise<string> {
  return runChecked("gh", args, { timeoutMs: ADVISORY_TIMEOUT_MS });
}

/**
 * GitHub's malware advisories (a separate database from vulnerabilities), asked once per package
 * version. Uses the `gh` login for github.com whatever host the PR is on.
 */
export function githubMalwareSource(run: RunGh = runGh): AdvisorySource {
  const name = "github malware";

  return {
    name,

    async check(packages: readonly PackageVersion[]): Promise<Advisory[]> {
      const advisories: Advisory[] = [];

      for (const pkg of packages) {
        const query = new URLSearchParams({
          type: "malware",
          ecosystem: "npm",
          affects: `${pkg.name}@${pkg.version}`,
          per_page: "100",
        });

        const listed = ghMalwareSchema.parse(
          JSON.parse(
            await run(["api", "--hostname", "github.com", `/advisories?${query.toString()}`]),
          ),
        );

        for (const advisory of listed) {
          advisories.push({
            id: advisory.ghsa_id,
            source: name,
            package: pkg.name,
            version: pkg.version,
            severity: severity(advisory.severity),
            kind: "malware",
            title: advisory.summary,
            url: advisory.html_url ?? null,
          });
        }
      }

      return advisories;
    },
  };
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;

  return a < b ? -1 : 1;
}

/**
 * Asks every source about every package version. One failing source fails the whole check: a
 * partial answer would read as "no advisories" for what wasn't asked.
 */
export async function collectAdvisories(
  sources: readonly AdvisorySource[],
  packages: readonly PackageVersion[],
): Promise<AdvisoryEvidence> {
  const unique = new Map(
    packages.map(({ name, version }) => [`${name}@${version}`, { name, version }]),
  );

  const checked = [...unique.keys()].toSorted();
  const asked = checked.flatMap((key) => unique.get(key) ?? []);
  const reports = await Promise.all(sources.map((source) => source.check(asked)));
  const byKey = new Map<string, Advisory>();

  for (const advisory of reports.flat()) {
    byKey.set(
      [advisory.source, advisory.id, advisory.package, advisory.version].join("\0"),
      advisory,
    );
  }

  const advisories = [...byKey.values()].toSorted(
    (a, b) =>
      compareText(a.package, b.package) ||
      compareText(a.version, b.version) ||
      compareText(a.source, b.source) ||
      compareText(a.id, b.id),
  );

  return { checked, advisories };
}
