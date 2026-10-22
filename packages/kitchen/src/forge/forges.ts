import type { KitchenConfig } from "../config.ts";

import type { Forge, ForgeKind, RepoRef } from "./forge.ts";
import { createGitHub } from "./github.ts";
import { createGitLab } from "./gitlab.ts";

/** One Forge over every supported host: each call goes to the adapter for the ref's forge kind. */
export function createForges(config: KitchenConfig): Forge {
  const adapters = {
    github: createGitHub(config),
    gitlab: createGitLab(config),
  } satisfies Record<ForgeKind, Forge>;

  function adapter(repo: RepoRef): Forge {
    return adapters[repo.forge];
  }

  return {
    getPullRequest: (ref) => adapter(ref).getPullRequest(ref),
    listPullRequests: (repo, author, limit) => adapter(repo).listPullRequests(repo, author, limit),
    dependencyBots: (repo) => adapter(repo).dependencyBots(repo),
    getCommits: (ref) => adapter(ref).getCommits(ref),
    getRepoPolicy: (ref, baseRef) => adapter(ref).getRepoPolicy(ref, baseRef),
    getChecks: (ref, sha) => adapter(ref).getChecks(ref, sha),
    checkout: (ref) => adapter(ref).checkout(ref),
    upsertComment: (ref, marker, body) => adapter(ref).upsertComment(ref, marker, body),
  };
}
