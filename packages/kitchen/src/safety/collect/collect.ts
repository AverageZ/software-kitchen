import type { Forge, PrRef, PullRequest } from "../../forge/forge.ts";
import { countUpdates, parseBump } from "../../recipes/dependabot-bump/bump.ts";
import type { EvidenceBundle } from "../evidence.ts";
import type { Policy } from "../policy.ts";

import { collectAdvisories, type AdvisorySource } from "./advisories.ts";
import { collectChanges } from "./changes.ts";
import { collectRegistry, type Registry } from "./registry.ts";
import { extractReleaseNotes } from "./release-notes.ts";

/** What evidence collection reads from. Factories take the policy's registry URL. */
export interface CollectDeps {
  forge: Forge;
  registry: (baseUrl: string) => Registry;
  advisories: (registryUrl: string) => AdvisorySource[];
  /** Scratch directory for the git checkout, deleted afterwards. */
  workDir: string;
}

/** The evidence gathered before any PR code runs. */
export type CollectedEvidence = Pick<
  EvidenceBundle,
  "pullRequest" | "changes" | "registry" | "advisories" | "repoPolicy" | "releaseNotes"
>;

interface ItemMeta {
  id: string;
  source: string;
  sha: string | null;
}

type Item<D> = ItemMeta & { collectedAt: string } & (
    | { status: "ok"; data: D }
    | { status: "not-collected" | "unavailable" | "error"; reason: string }
  );

/** Wraps one collector so its failure becomes an `error` item instead of failing collection. */
async function attempt<D>(
  meta: ItemMeta,
  now: () => Date,
  collect: () => Promise<D>,
): Promise<Item<D>> {
  try {
    const data = await collect();

    return { ...meta, collectedAt: now().toISOString(), status: "ok", data };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return { ...meta, collectedAt: now().toISOString(), status: "error", reason };
  }
}

/**
 * Gathers everything the evaluator needs that can be read without running PR code. Each item
 * records its source and commit; one that can't be collected says why rather than failing the
 * rest. Throws only if the PR's commits can't be read, because without them there is no PR evidence.
 */
export async function collectEvidence(
  deps: CollectDeps,
  ref: PrRef,
  pullRequest: PullRequest,
  policy: Policy,
  now: () => Date,
): Promise<CollectedEvidence> {
  const { forge } = deps;
  const { headSha } = pullRequest;
  const forgeSource = `${ref.forge} api`;
  const bump = parseBump(pullRequest.title, pullRequest.body);
  const commits = await forge.getCommits(ref);

  const pullRequestItem: CollectedEvidence["pullRequest"] = {
    id: "pull-request",
    source: forgeSource,
    collectedAt: now().toISOString(),
    sha: headSha,
    status: "ok",
    data: {
      forge: ref.forge,
      host: ref.host,
      project: ref.project,
      number: ref.number,
      url: pullRequest.url,
      title: pullRequest.title,
      bump,
      updateCount: countUpdates(pullRequest.title, pullRequest.body),
      author: {
        login: pullRequest.author.login,
        isBot: pullRequest.author.isBot,
        trustedBot: pullRequest.author.dependencyBot,
      },
      state: pullRequest.state,
      isDraft: pullRequest.isDraft,
      headSha,
      baseRef: pullRequest.baseRef,
      baseSha: pullRequest.baseSha,
      commits,
      createdAt: pullRequest.createdAt,
      mergedAt: pullRequest.mergedAt,
    },
  };

  const [changes, repoPolicy] = await Promise.all([
    attempt({ id: "changes", source: "git", sha: headSha }, now, () =>
      collectChanges({
        checkout: forge.checkout(ref),
        headSha,
        baseRef: pullRequest.baseRef,
        baseSha: pullRequest.baseSha,
        workDir: deps.workDir,
      }),
    ),
    attempt({ id: "repo-policy", source: forgeSource, sha: headSha }, now, () =>
      forge.getRepoPolicy(ref, pullRequest.baseRef),
    ),
  ]);

  const registryUrl = policy.safety.registry;
  const added = changes.status === "ok" ? changes.data.lockfiles.flatMap((lock) => lock.added) : [];
  const sources = deps.advisories(registryUrl);
  const registryMeta = { id: "registry", source: registryUrl, sha: null };

  const advisoriesMeta = {
    id: "advisories",
    source: sources.map((s) => s.name).join(", "),
    sha: null,
  };

  const unavailable = (meta: ItemMeta, reason: string): Item<never> => ({
    ...meta,
    collectedAt: now().toISOString(),
    status: "unavailable",
    reason,
  });

  const noBump = "the PR is not a single-package update";

  const registry: CollectedEvidence["registry"] =
    bump === null
      ? unavailable(registryMeta, noBump)
      : await attempt(registryMeta, now, async () => {
          const evidence = await collectRegistry(deps.registry(registryUrl), {
            package: bump.package,
            from: bump.from,
            to: bump.to,
            added,
          });

          // Without the lockfile changes the added packages are unknown, so none were checked.
          return changes.status === "ok" ? evidence : { ...evidence, transitiveComplete: false };
        });

  let advisories: CollectedEvidence["advisories"];

  if (!policy.safety.requireSecurityAssessment) {
    advisories = {
      ...advisoriesMeta,
      collectedAt: now().toISOString(),
      status: "not-collected",
      reason: "safety.requireSecurityAssessment is off",
    };
  } else if (bump === null) advisories = unavailable(advisoriesMeta, noBump);
  else {
    advisories = await attempt(advisoriesMeta, now, async () => {
      // Checking only the updated package would pass every package the lockfile adds unchecked.
      if (changes.status !== "ok") {
        throw new Error(
          `lockfile changes are unknown (${changes.reason}), so added packages can't be checked`,
        );
      }

      return collectAdvisories(sources, [{ name: bump.package, version: bump.to }, ...added]);
    });
  }

  const notes = extractReleaseNotes(pullRequest.body);
  const notesMeta = { id: "release-notes", source: "pr body", sha: headSha };

  const releaseNotes: CollectedEvidence["releaseNotes"] =
    notes === null
      ? unavailable(notesMeta, "the PR body quotes no release notes")
      : { ...notesMeta, collectedAt: now().toISOString(), status: "ok", data: notes };

  return { pullRequest: pullRequestItem, changes, registry, advisories, repoPolicy, releaseNotes };
}
