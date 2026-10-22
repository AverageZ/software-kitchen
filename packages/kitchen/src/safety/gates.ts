import { posix } from "node:path";

import semver from "semver";

import type { PrCommit } from "../forge/forge.ts";

import type { GateId, GateResult } from "./assessment.ts";
import { EVIDENCE_KEYS, type EvaluationContext, type Update } from "./classify.ts";
import {
  collected,
  type ChangesEvidence,
  type LockedPackage,
  type LockfileChange,
  type RegistryEvidence,
  type VersionInfo,
} from "./evidence.ts";

export type Disposition = NonNullable<GateResult["disposition"]>;

/** Decision precedence: a gate's worst problem decides its disposition, and the worst gate the decision. */
export const DISPOSITION_SEVERITY: Record<Disposition, number> = {
  block: 3,
  escalate: 2,
  defer: 1,
  "insufficient-evidence": 0,
};

/** One thing a gate found wrong. A gate's status and disposition come from its worst problem. */
interface Problem {
  status: "FAIL" | "INCONCLUSIVE";
  disposition: Disposition;
  reason: string;
  retryAt: string | null;
}

/** The parts of an evidence item a gate reports when the item is missing. */
interface MissingItem {
  id: string;
  status: string;
  reason: string;
}

function fail(disposition: Disposition, reason: string): Problem {
  return { status: "FAIL", disposition, reason, retryAt: null };
}

function inconclusive(disposition: Disposition, reason: string): Problem {
  return { status: "INCONCLUSIVE", disposition, reason, retryAt: null };
}

/** Missing evidence is never a pass: the gate couldn't be checked. */
function missing(item: MissingItem): Problem {
  return inconclusive(
    "insufficient-evidence",
    `${item.id} evidence is missing (${item.status}: ${item.reason})`,
  );
}

function result(
  gate: GateId,
  evidence: readonly string[],
  problems: readonly Problem[],
): GateResult {
  const ids = [...new Set(evidence)].toSorted();
  const ordered = problems.toSorted((a, b) => rank(b) - rank(a));
  const worst = ordered[0];

  if (worst === undefined)
    return { gate, status: "PASS", disposition: null, reasons: [], evidence: ids, retryAt: null };

  const retryAt =
    worst.disposition === "defer" ? latest(ordered.map((problem) => problem.retryAt)) : null;

  return {
    gate,
    status: problems.some((problem) => problem.status === "FAIL") ? "FAIL" : "INCONCLUSIVE",
    disposition: worst.disposition,
    reasons: ordered.map((problem) => problem.reason),
    evidence: ids,
    retryAt,
  };
}

/** FAIL ranks above INCONCLUSIVE at the same disposition, so the stated cause comes first. */
function rank(problem: Problem): number {
  return DISPOSITION_SEVERITY[problem.disposition] * 2 + (problem.status === "FAIL" ? 1 : 0);
}

/** The latest of some ISO timestamps, or null if none is known. */
export function latest(times: readonly (string | null)[]): string | null {
  let found: string | null = null;

  for (const time of times) if (time !== null && (found === null || time > found)) found = time;

  return found;
}

function notApplicable(gate: GateId): GateResult {
  return {
    gate,
    status: "NOT_APPLICABLE",
    disposition: null,
    reasons: [],
    evidence: [],
    retryAt: null,
  };
}

/** All ten gates, in `GATES` order. Each reads only evidence; none can be overridden by the score. */
export function evaluateGates(context: EvaluationContext): GateResult[] {
  return [
    identity(context),
    changeScope(context),
    dependencyIntegrity(context),
    security(context),
    installBehavior(context),
    releaseMaturity(context),
    compatibility(context),
    ci(context),
    repositoryPolicy(context),
    evidenceCurrency(context),
  ];
}

function identity(context: EvaluationContext): GateResult {
  const item = context.evidence.pullRequest;
  const { author, commits, host } = item.data;
  const problems: Problem[] = [];

  if (!author.trustedBot)
    problems.push(fail("escalate", `${author.login} is not a trusted dependency bot on ${host}`));

  if (!author.isBot) problems.push(fail("escalate", `${author.login} is not a bot account`));

  if (!context.policy.eligibility.bots.includes(author.login))
    problems.push(fail("escalate", `${author.login} is not in eligibility.bots`));

  if (commits.length === 0)
    problems.push(inconclusive("insufficient-evidence", "the PR lists no commits"));

  for (const commit of commits) problems.push(...commitProblems(commit, author.login));

  return result("identity", [item.id], problems);
}

/** The bot must author every commit; GitHub's `web-flow` may commit on its behalf. */
function commitProblems(commit: PrCommit, login: string): Problem[] {
  const problems: Problem[] = [];

  if (commit.authorLogin === null)
    problems.push(
      inconclusive("insufficient-evidence", `commit ${commit.sha} has no author login`),
    );
  else if (commit.authorLogin !== login)
    problems.push(
      fail("escalate", `commit ${commit.sha} is authored by ${commit.authorLogin}, not ${login}`),
    );

  if (commit.committerLogin === null)
    problems.push(
      inconclusive("insufficient-evidence", `commit ${commit.sha} has no committer login`),
    );
  else if (commit.committerLogin !== login && commit.committerLogin !== "web-flow")
    problems.push(
      fail(
        "escalate",
        `commit ${commit.sha} is committed by ${commit.committerLogin}, not ${login}`,
      ),
    );

  return problems;
}

function changeScope(context: EvaluationContext): GateResult {
  const item = context.evidence.changes;

  if (item.status !== "ok") return result("change-scope", [item.id], [missing(item)]);

  const { allowedFileNames, blockedPaths } = context.policy.safety;
  const problems: Problem[] = [];

  if (item.data.files.length === 0) problems.push(fail("escalate", "the PR changes no files"));

  for (const file of item.data.files) {
    const paths = file.previousPath === null ? [file.path] : [file.path, file.previousPath];

    for (const path of paths) problems.push(...pathProblems(path, allowedFileNames, blockedPaths));

    if (file.status !== "modified")
      problems.push(
        fail("escalate", `${file.path} is ${file.status}; an update only modifies files`),
      );
  }

  for (const manifest of item.data.manifests)
    for (const field of manifest.otherChanges)
      problems.push(fail("escalate", `${manifest.path} also changes ${field}`));

  return result("change-scope", [item.id], problems);
}

function pathProblems(
  path: string,
  allowed: readonly string[],
  blocked: readonly string[],
): Problem[] {
  if (isBlocked(path, blocked))
    return [
      fail("block", `${path} is CI or executable configuration, which an update must not change`),
    ];

  if (!allowed.includes(posix.basename(path)))
    return [fail("escalate", `${path} is not a manifest or lockfile`)];

  return [];
}

/** An entry ending in `/` blocks everything under that prefix; any other entry, that path or file name. */
function isBlocked(path: string, blocked: readonly string[]): boolean {
  const normalized = path.replace(/^\.\//, "");

  return blocked.some((entry) =>
    entry.endsWith("/")
      ? normalized.startsWith(entry)
      : normalized === entry || posix.basename(normalized) === entry,
  );
}

function dependencyIntegrity(context: EvaluationContext): GateResult {
  const { pullRequest, changes, registry } = context.evidence;
  const evidence = [pullRequest.id, changes.id, registry.id];

  if (changes.status !== "ok" || registry.status !== "ok") {
    const problems: Problem[] = [];

    if (changes.status !== "ok") problems.push(missing(changes));

    if (registry.status !== "ok") problems.push(missing(registry));

    return result("dependency-integrity", evidence, problems);
  }

  const registryHost = new URL(context.policy.safety.registry).host;

  return result("dependency-integrity", evidence, [
    ...manifestProblems(changes.data, context.update),
    ...registryProblems(registry.data, context.update),
    ...changes.data.lockfiles.flatMap((lockfile) =>
      lockfileProblems(lockfile, registry.data, context.update, registryHost),
    ),
    ...(changes.data.lockfiles.length === 0
      ? [fail("escalate", "no lockfile changed, so nothing pins the new version")]
      : []),
  ]);
}

/** Every manifest change must be this package, moving from a range of the old version to one of the new. */
function manifestProblems(changes: ChangesEvidence, update: Update): Problem[] {
  const problems: Problem[] = [];

  for (const manifest of changes.manifests)
    for (const change of manifest.dependencyChanges) {
      if (change.name !== update.package) {
        problems.push(fail("escalate", `${manifest.path} also changes ${change.name}`));
        continue;
      }

      if (change.from === null || change.to === null) {
        const action = change.from === null ? "adds" : "removes";

        problems.push(
          fail("escalate", `${manifest.path} ${action} ${change.name} instead of updating it`),
        );
        continue;
      }

      if (!semver.satisfies(update.from, change.from))
        problems.push(
          fail(
            "escalate",
            `conflicting evidence: ${manifest.path} had ${change.from}, which doesn't allow ${update.from}, the version the PR says it replaces`,
          ),
        );

      if (!semver.satisfies(update.to, change.to))
        problems.push(
          fail(
            "escalate",
            `conflicting evidence: ${manifest.path} now has ${change.to}, which doesn't allow ${update.to}, the version the PR proposes`,
          ),
        );
    }

  return problems;
}

function registryProblems(registry: RegistryEvidence, update: Update): Problem[] {
  if (registry.package !== update.package)
    return [
      fail(
        "escalate",
        `conflicting evidence: registry data is for ${registry.package}, not ${update.package}`,
      ),
    ];

  if (registry.to === null)
    return [
      inconclusive(
        "insufficient-evidence",
        `${registry.registry} doesn't list ${update.package}@${update.to}`,
      ),
    ];

  if (registry.to.version !== update.to)
    return [
      fail(
        "escalate",
        `conflicting evidence: registry data is for ${update.package}@${registry.to.version}, not ${update.to}`,
      ),
    ];

  return [];
}

/** The lockfile must swap exactly the stated versions, trust the registry's bytes, and fetch from it. */
function lockfileProblems(
  lockfile: LockfileChange,
  registry: RegistryEvidence,
  update: Update,
  registryHost: string,
): Problem[] {
  const problems: Problem[] = [];
  const proposed = lockfile.added.find((entry) => isVersion(entry, update.package, update.to));

  if (proposed === undefined) {
    const versions = lockfile.added.flatMap((entry) =>
      entry.name === update.package ? [entry.version] : [],
    );

    const instead = versions.length === 0 ? "" : `; it adds ${versions.join(", ")}`;

    problems.push(
      fail(
        "escalate",
        `conflicting evidence: ${lockfile.path} doesn't add ${update.package}@${update.to} as the PR states${instead}`,
      ),
    );
  } else if (registry.to !== null)
    problems.push(...integrityProblems(lockfile.path, proposed, registry.to.integrity));

  if (!lockfile.removed.some((entry) => isVersion(entry, update.package, update.from)))
    problems.push(
      fail(
        "escalate",
        `conflicting evidence: ${lockfile.path} doesn't remove ${update.package}@${update.from} as the PR states`,
      ),
    );

  for (const changed of lockfile.integrityChanged)
    problems.push(
      fail(
        "block",
        `${lockfile.path} changes the integrity of ${changed.name}@${changed.version}, which it already locked`,
      ),
    );

  for (const entry of lockfile.added) {
    problems.push(...hostProblems(lockfile.path, entry, registryHost));

    if (entry === proposed) continue;

    const known = registry.transitive.find((transitive) =>
      isVersion(transitive, entry.name, entry.version),
    );

    if (
      known !== undefined &&
      known.integrity !== null &&
      entry.integrity !== null &&
      known.integrity !== entry.integrity
    )
      problems.push(integrityMismatch(lockfile.path, entry, known.integrity));
  }

  return problems;
}

interface NamedVersion {
  name: string;
  version: string;
}

function isVersion(entry: NamedVersion, name: string, version: string): boolean {
  return entry.name === name && entry.version === version;
}

function integrityProblems(
  path: string,
  entry: LockedPackage,
  registryIntegrity: string | null,
): Problem[] {
  if (entry.integrity === null || registryIntegrity === null)
    return [
      inconclusive(
        "insufficient-evidence",
        `${entry.name}@${entry.version} has no integrity in ${entry.integrity === null ? path : "the registry"} to compare`,
      ),
    ];

  return entry.integrity === registryIntegrity
    ? []
    : [integrityMismatch(path, entry, registryIntegrity)];
}

function integrityMismatch(path: string, entry: LockedPackage, registryIntegrity: string): Problem {
  return fail(
    "block",
    `conflicting sources: ${path} locks ${entry.name}@${entry.version} to ${entry.integrity ?? "nothing"} but the registry publishes ${registryIntegrity}`,
  );
}

function hostProblems(path: string, entry: LockedPackage, registryHost: string): Problem[] {
  if (entry.resolved === null) return [];

  const host = URL.canParse(entry.resolved) ? new URL(entry.resolved).host : null;

  if (host === registryHost) return [];

  return [
    fail(
      "escalate",
      `${path} resolves ${entry.name}@${entry.version} from ${host ?? entry.resolved}, not ${registryHost}`,
    ),
  ];
}

/** Deprecation text a registry uses for pulled malicious releases. */
const COMPROMISED = /compromis|malicious|malware/i;

function security(context: EvaluationContext): GateResult {
  if (!context.policy.safety.requireSecurityAssessment) return notApplicable("security");

  const { advisories, registry, changes } = context.evidence;
  const evidence = [advisories.id, registry.id];
  const { update } = context;
  const problems: Problem[] = [];

  if (registry.status !== "ok") problems.push(missing(registry));
  else {
    const deprecated = registry.data.to?.deprecated ?? null;

    if (deprecated !== null && COMPROMISED.test(deprecated))
      problems.push(
        fail("block", `${update.package}@${update.to} is deprecated as compromised: ${deprecated}`),
      );
  }

  if (advisories.status !== "ok")
    return result("security", evidence, [...problems, missing(advisories)]);

  for (const advisory of advisories.data.advisories) {
    const subject = `${advisory.id} (${advisory.source}) for ${advisory.package}@${advisory.version}: ${advisory.title}`;

    if (advisory.kind === "malware") problems.push(fail("block", `malware advisory ${subject}`));
    else if (context.policy.safety.disallowedSeverities.includes(advisory.severity))
      problems.push(fail("escalate", `${advisory.severity} advisory ${subject}`));
  }

  const required = new Set([`${update.package}@${update.to}`]);
  const added = collected(changes)?.lockfiles.flatMap((lockfile) => lockfile.added) ?? [];

  for (const entry of added) required.add(`${entry.name}@${entry.version}`);

  for (const subject of [...required].toSorted())
    if (!advisories.data.checked.includes(subject))
      problems.push(
        inconclusive("insufficient-evidence", `${subject} was not checked for advisories`),
      );

  return result("security", evidence, problems);
}

/** Install script text that fetches or runs something beyond the package itself. */
const DOWNLOAD_OR_EXEC =
  /\b(?:curl|wget|powershell|pwsh|eval)\b|https?:\/\/|\bnode\s+(?:-e|--eval|-p|--print)\b|base64/i;

function installBehavior(context: EvaluationContext): GateResult {
  if (!context.policy.safety.requireInstallBehaviorAssessment)
    return notApplicable("install-behavior");

  const { registry, changes } = context.evidence;
  const evidence = [registry.id, changes.id];

  if (registry.status !== "ok" || changes.status !== "ok") {
    const problems: Problem[] = [];

    if (registry.status !== "ok") problems.push(missing(registry));

    if (changes.status !== "ok") problems.push(missing(changes));

    return result("install-behavior", evidence, problems);
  }

  const { from, to } = registry.data;
  const { update } = context;

  if (to === null)
    return result("install-behavior", evidence, [
      inconclusive(
        "insufficient-evidence",
        `the registry doesn't list ${update.package}@${update.to}`,
      ),
    ]);

  return result("install-behavior", evidence, [
    ...scriptProblems(from, to, update),
    ...transitiveInstallProblems(registry.data, changes.data, update),
  ]);
}

function scriptProblems(from: VersionInfo | null, to: VersionInfo, update: Update): Problem[] {
  const runsAtInstall = Object.keys(to.installScripts).length > 0 || to.gypfile;

  if (from === null)
    return runsAtInstall
      ? [
          inconclusive(
            "insufficient-evidence",
            `${update.package}@${update.to} runs code at install and the registry doesn't list ${update.from} to compare`,
          ),
        ]
      : [];

  const problems: Problem[] = [];

  for (const [name, script] of Object.entries(to.installScripts).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const before = Object.hasOwn(from.installScripts, name) ? from.installScripts[name] : undefined;

    if (before === script) continue;

    const change = before === undefined ? "adds" : "changes";
    const reason = `${update.package}@${update.to} ${change} its ${name} script: ${script}`;

    problems.push(
      DOWNLOAD_OR_EXEC.test(script)
        ? fail("block", `${reason} (downloads or executes code)`)
        : fail("escalate", reason),
    );
  }

  if (to.gypfile && !from.gypfile)
    problems.push(
      fail("escalate", `${update.package}@${update.to} adds a native build (binding.gyp)`),
    );

  return problems;
}

function transitiveInstallProblems(
  registry: RegistryEvidence,
  changes: ChangesEvidence,
  update: Update,
): Problem[] {
  const problems: Problem[] = [];

  for (const transitive of registry.transitive) {
    const runsAtInstall = Object.keys(transitive.installScripts).length > 0 || transitive.gypfile;

    const alreadyRan = transitive.replaced.some(
      (previous) =>
        sameScripts(previous.installScripts, transitive.installScripts) &&
        (previous.gypfile || !transitive.gypfile),
    );

    if (runsAtInstall && !alreadyRan)
      problems.push(
        fail(
          "escalate",
          `the update adds ${transitive.name}@${transitive.version}, which runs code at install`,
        ),
      );
  }

  let addsTransitive = false;

  for (const lockfile of changes.lockfiles)
    for (const entry of lockfile.added) {
      if (isVersion(entry, update.package, update.to)) continue;

      addsTransitive = true;

      // A replaced version that also had an install script leaves the comparison to the registry
      // check above, which sees the scripts themselves.
      const replacesInstaller = lockfile.removed.some(
        (removed) => removed.name === entry.name && removed.hasInstallScript === true,
      );

      if (entry.hasInstallScript === true && !replacesInstaller)
        problems.push(
          fail(
            "escalate",
            `${lockfile.path} adds ${entry.name}@${entry.version}, which has an install script`,
          ),
        );
    }

  if (addsTransitive && !registry.transitiveComplete)
    problems.push(
      inconclusive(
        "insufficient-evidence",
        "not every package the lockfile adds was looked up in the registry",
      ),
    );

  return problems;
}

function sameScripts(a: Record<string, string>, b: Record<string, string>): boolean {
  const names = Object.keys(a);

  return (
    names.length === Object.keys(b).length &&
    names.every((name) => Object.hasOwn(b, name) && a[name] === b[name])
  );
}

const HOUR_MS = 3_600_000;

function releaseMaturity(context: EvaluationContext): GateResult {
  const item = context.evidence.registry;

  if (item.status !== "ok") return result("release-maturity", [item.id], [missing(item)]);

  const publishedAt = item.data.to?.publishedAt ?? null;
  const published = publishedAt === null ? Number.NaN : Date.parse(publishedAt);
  const evaluated = Date.parse(context.evaluatedAt);
  const { update } = context;

  if (Number.isNaN(published) || Number.isNaN(evaluated))
    return result(
      "release-maturity",
      [item.id],
      [
        inconclusive(
          "insufficient-evidence",
          `the publish time of ${update.package}@${update.to} is unknown`,
        ),
      ],
    );

  const minimumHours = context.policy.safety.minimumReleaseAgeHours;

  if (evaluated - published >= minimumHours * HOUR_MS)
    return result("release-maturity", [item.id], []);

  const ageHours = Math.floor((evaluated - published) / HOUR_MS);

  return result(
    "release-maturity",
    [item.id],
    [
      {
        status: "FAIL",
        disposition: "defer",
        reason: `${update.package}@${update.to} was published ${ageHours}h ago; the policy waits ${minimumHours}h`,
        retryAt: new Date(published + minimumHours * HOUR_MS).toISOString(),
      },
    ],
  );
}

function compatibility(context: EvaluationContext): GateResult {
  const { registry, changes } = context.evidence;
  const evidence = [registry.id, changes.id];

  if (registry.status !== "ok" || changes.status !== "ok") {
    const problems: Problem[] = [];

    if (registry.status !== "ok") problems.push(missing(registry));

    if (changes.status !== "ok") problems.push(missing(changes));

    return result("compatibility", evidence, problems);
  }

  const { from, to } = registry.data;
  const { update } = context;

  if (to === null)
    return result("compatibility", evidence, [
      inconclusive(
        "insufficient-evidence",
        `the registry doesn't list ${update.package}@${update.to}`,
      ),
    ]);

  return result("compatibility", evidence, [
    ...engineProblems(from, to, changes.data.projectNodeEngine, update),
    ...peerProblems(to, changes.data, update),
  ]);
}

function engineProblems(
  from: VersionInfo | null,
  to: VersionInfo,
  project: string | null,
  update: Update,
): Problem[] {
  const required = to.engines.node;

  if (required === null) return [];

  if (project === null) {
    if (from !== null && from.engines.node === required) return [];

    return [
      inconclusive(
        "insufficient-evidence",
        `${update.package}@${update.to} requires node ${required}, changed from ${from?.engines.node ?? "unknown"}, and the project declares no engines.node to compare`,
      ),
    ];
  }

  if (semver.validRange(required) === null || semver.validRange(project) === null)
    return [
      inconclusive("insufficient-evidence", `can't compare node ranges ${required} and ${project}`),
    ];

  return semver.intersects(required, project)
    ? []
    : [
        fail(
          "escalate",
          `${update.package}@${update.to} requires node ${required}; the project supports ${project}`,
        ),
      ];
}

/** Peers the importers already depend on directly must resolve to a version the new release accepts. */
function peerProblems(to: VersionInfo, changes: ChangesEvidence, update: Update): Problem[] {
  const dependents = changes.importers.filter((importer) =>
    importer.dependencies.some((dependency) => dependency.name === update.package),
  );

  const importers = dependents.length === 0 ? changes.importers : dependents;
  const problems: Problem[] = [];

  for (const [peer, range] of Object.entries(to.peerDependencies).toSorted(([a], [b]) =>
    a.localeCompare(b),
  ))
    for (const importer of importers)
      for (const dependency of importer.dependencies) {
        if (dependency.name !== peer) continue;

        if (dependency.version === null)
          problems.push(
            inconclusive(
              "insufficient-evidence",
              `${importer.path} has no locked version of peer ${peer} to check against ${range}`,
            ),
          );
        else if (!semver.satisfies(dependency.version, range))
          problems.push(
            fail(
              "escalate",
              `${update.package}@${update.to} needs peer ${peer} ${range}; ${importer.path} has ${dependency.version}`,
            ),
          );
      }

  return problems;
}

function ci(context: EvaluationContext): GateResult {
  const { checks, repoPolicy, localTests } = context.evidence;
  const evidence = [checks.id, repoPolicy.id, localTests.id];

  if (checks.status !== "ok") return result("ci", evidence, [missing(checks)]);

  if (checks.data.sha !== context.headSha)
    return result("ci", evidence, [
      inconclusive(
        "insufficient-evidence",
        `CI results are for ${checks.data.sha}, not the head ${context.headSha}`,
      ),
    ]);

  const required = new Set(context.policy.safety.requiredChecks);

  for (const name of collected(repoPolicy)?.requiredChecks ?? []) required.add(name);

  const problems: Problem[] = [];

  for (const check of checks.data.checks)
    if (check.state === "fail") problems.push(fail("escalate", `check ${check.name} failed`));
    else if (check.state === "pending")
      problems.push(inconclusive("defer", `check ${check.name} is pending`));

  if (checks.data.status === "timed-out")
    problems.push(inconclusive("defer", "CI was still running at the wait limit"));

  for (const name of [...required].toSorted())
    if (!checks.data.checks.some((check) => check.name === name))
      problems.push(inconclusive("defer", `required check ${name} has not reported`));

  if (required.size === 0 && context.policy.safety.requireRequiredChecks)
    problems.push(
      inconclusive(
        "insufficient-evidence",
        "the base branch requires no checks; list them in safety.requiredChecks",
      ),
    );

  problems.push(...localTestProblems(context));

  return result("ci", evidence, problems);
}

function localTestProblems(context: EvaluationContext): Problem[] {
  const item = context.evidence.localTests;

  if (item.status !== "ok") return context.policy.verification.localTests ? [missing(item)] : [];

  if (item.data.status === "passed" || item.data.status === "no-tests") return [];

  return [
    fail(
      "escalate",
      `local tests ${item.data.status}${item.data.command === null ? "" : ` (${item.data.command})`}`,
    ),
  ];
}

function repositoryPolicy(context: EvaluationContext): GateResult {
  const item = context.evidence.repoPolicy;

  if (item.status !== "ok") return result("repository-policy", [item.id], [missing(item)]);

  const rules = item.data;
  const problems: Problem[] = [];
  const baseRef = context.evidence.pullRequest.data.baseRef;

  if (rules.baseRef !== baseRef)
    problems.push(
      fail(
        "escalate",
        `conflicting evidence: repository rules are for ${rules.baseRef}, not ${baseRef}`,
      ),
    );

  if (rules.mergeQueueRequired === true)
    problems.push(fail("escalate", "merge queue required; the kitchen does not enqueue"));

  if (rules.reviewDecision === null)
    problems.push(inconclusive("insufficient-evidence", "the PR's review state is unknown"));
  else if (rules.reviewDecision === "CHANGES_REQUESTED")
    problems.push(fail("escalate", "a reviewer requested changes"));
  else if (rules.reviewDecision === "REVIEW_REQUIRED" && !context.policy.automation.approve)
    problems.push(fail("escalate", "needs an approving review and automation.approve is off"));

  if (rules.mergeStateStatus === null)
    problems.push(inconclusive("insufficient-evidence", "the PR's merge state is unknown"));
  else if (rules.mergeStateStatus === "DIRTY")
    problems.push(fail("escalate", "the PR has merge conflicts"));
  else if (rules.mergeStateStatus === "BEHIND")
    problems.push(fail("defer", "the PR is behind its base branch"));

  return result("repository-policy", [item.id], problems);
}

function evidenceCurrency(context: EvaluationContext): GateResult {
  const { evidence, headSha } = context;
  const problems: Problem[] = [];
  const ids: string[] = [];

  for (const key of EVIDENCE_KEYS) {
    const item = evidence[key];

    if (item.status !== "ok" || item.sha === null) continue;

    ids.push(item.id);

    if (item.sha !== headSha)
      problems.push(
        fail(
          "defer",
          `${item.id} evidence describes ${item.sha}, not the head ${headSha}; re-evaluate`,
        ),
      );
  }

  const changes = collected(evidence.changes);

  if (changes !== null && changes.headSha !== headSha)
    problems.push(
      fail(
        "defer",
        `the diff was taken at ${changes.headSha}, not the head ${headSha}; re-evaluate`,
      ),
    );

  const headCheck = evidence.headCheck;

  ids.push(headCheck.id);

  if (headCheck.status !== "ok")
    return result("evidence-currency", ids, [...problems, missing(headCheck)]);

  const pullRequest = evidence.pullRequest.data;

  if (headCheck.data.headSha !== headSha || headCheck.data.baseRef !== pullRequest.baseRef)
    problems.push(fail("defer", "PR changed during evaluation; re-evaluate"));

  if (headCheck.data.state !== "OPEN")
    problems.push(fail("escalate", `the PR is now ${headCheck.data.state.toLowerCase()}`));

  return result("evidence-currency", ids, problems);
}
