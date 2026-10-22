import { z } from "zod";

/** Kinds of code host the kitchen can work with. GitHub Enterprise is `github` on another host. */
export const forgeKindSchema = z.enum(["github", "gitlab"]);

export type ForgeKind = z.infer<typeof forgeKindSchema>;

const SEGMENT = /^[\w.-]+$/;

const HOST = /^[\w.-]+(?::\d+)?$/;

/** `owner/repo`, or a GitLab path with subgroups such as `group/sub/project`. */
function isProjectPath(path: string): boolean {
  const segments = path.split("/");

  return segments.length >= 2 && segments.every((segment) => SEGMENT.test(segment));
}

export const repoRefSchema = z.object({
  forge: forgeKindSchema,
  host: z.string().regex(HOST),
  project: z.string().refine(isProjectPath, "Expected a project path such as owner/repo"),
});

/** A repository on a host, e.g. `github.com` + `octo/app`. */
export type RepoRef = z.infer<typeof repoRefSchema>;

export const prRefSchema = repoRefSchema.extend({ number: z.number().int().positive() });

/** A pull request (GitHub) or merge request (GitLab). `number` is the GitLab MR's iid. */
export type PrRef = z.infer<typeof prRefSchema>;

const HOST_PART = String.raw`https?:\/\/([\w.-]+(?::\d+)?)`;

const TAIL = String.raw`(?:[/?#].*)?$`;

// GitHub and GitHub Enterprise: https://host/owner/repo/pull/12
const GITHUB_PR = new RegExp(String.raw`^${HOST_PART}\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)${TAIL}`);

// GitLab.com and self-managed GitLab: https://host/group/sub/project/-/merge_requests/12
const GITLAB_MR = new RegExp(
  String.raw`^${HOST_PART}\/((?:[\w.-]+\/)+[\w.-]+)\/-\/merge_requests\/(\d+)${TAIL}`,
);

const URL_FORMS = [
  { forge: "github", pattern: GITHUB_PR },
  { forge: "gitlab", pattern: GITLAB_MR },
] as const satisfies readonly { forge: ForgeKind; pattern: RegExp }[];

/**
 * Parses a pull or merge request URL on any host, tolerating tab suffixes such as `/files`, queries,
 * and fragments. The URL's shape decides the forge, so self-hosted instances need no configuration.
 */
export function parsePrUrl(text: string): PrRef | null {
  const trimmed = text.trim();

  for (const { forge, pattern } of URL_FORMS) {
    const match = pattern.exec(trimmed);

    if (match === null) continue;

    const [, host, project, number] = match;

    if (host === undefined || project === undefined || number === undefined) return null;

    return {
      forge,
      host: host === "www.github.com" ? "github.com" : host,
      project,
      number: Number(number),
    };
  }

  return null;
}

const PR_URL_HINT =
  "Expected a pull request URL, e.g. https://github.com/OWNER/REPO/pull/12 or https://gitlab.example.com/GROUP/PROJECT/-/merge_requests/12";

/** A URL `parsePrUrl` accepts. */
export const prUrlSchema = z
  .string()
  .trim()
  .refine((text) => parsePrUrl(text) !== null, PR_URL_HINT);

/** Canonical web URL of a pull request. */
export function prUrl(ref: PrRef): string {
  const base = `https://${ref.host}/${ref.project}`;

  return ref.forge === "gitlab"
    ? `${base}/-/merge_requests/${ref.number}`
    : `${base}/pull/${ref.number}`;
}

/** `host/project`, e.g. `github.com/octo/app`. */
export function repoSlug(repo: RepoRef): string {
  return `${repo.host}/${repo.project}`;
}

/** Stable identity of a pull request, e.g. `github.com/octo/app#12` or `gitlab.acme.dev/g/app!12`. */
export function prSlug(ref: PrRef): string {
  return `${repoSlug(ref)}${ref.forge === "gitlab" ? "!" : "#"}${ref.number}`;
}

/** Hosts whose forge is known without asking, for commands that take a repository instead of a PR URL. */
const KNOWN_HOSTS = new Map<string, ForgeKind>([
  ["github.com", "github"],
  ["gitlab.com", "gitlab"],
]);

const OWNER_REPO = /^([\w.-]+\/[\w.-]+)$/;

const REPO_URL = new RegExp(String.raw`^${HOST_PART}\/((?:[\w.-]+\/)+[\w.-]+?)(?:\.git)?\/?$`);

/**
 * Parses `owner/repo` (on github.com) or a repository URL. Self-hosted instances need `forge`,
 * because a repository URL alone doesn't say whether the host runs GitHub or GitLab.
 */
export function parseRepo(text: string, forge: ForgeKind | null): RepoRef {
  // GitLab page URLs such as https://host/group/app/-/merge_requests still name the project.
  const trimmed = text.trim().replace(/\/-\/.*$/, "");
  const shorthand = OWNER_REPO.exec(trimmed)?.[1];
  const url = REPO_URL.exec(trimmed);
  const host = shorthand === undefined ? url?.[1] : "github.com";
  const project = shorthand ?? url?.[2];

  if (host === undefined || project === undefined) {
    throw new Error(
      `Give a repository as owner/repo or a URL, e.g. octo/app or https://gitlab.example.com/group/app; got "${text}"`,
    );
  }

  const kind = forge ?? KNOWN_HOSTS.get(host);

  if (kind === undefined)
    throw new Error(`Say which forge ${host} runs: --forge github or --forge gitlab`);

  return { forge: kind, host, project };
}

export const pullRequestSchema = z.object({
  url: z.string(),
  title: z.string(),
  body: z.string(),
  author: z.object({
    login: z.string(),
    isBot: z.boolean(),
    /** True when the host trusts this login to open dependency updates: built in, or `config.json`. */
    dependencyBot: z.boolean(),
  }),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headSha: z.string(),
  /** Branch the PR merges into, e.g. `main`, and that branch's current tip. */
  baseRef: z.string(),
  baseSha: z.string(),
  labels: z.array(z.string()),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
});

export type PullRequest = z.infer<typeof pullRequestSchema>;

export const checkSchema = z.object({
  name: z.string(),
  state: z.enum(["pass", "fail", "pending"]),
});

export type Check = z.infer<typeof checkSchema>;

export const prCommitSchema = z.strictObject({
  sha: z.string(),
  /** Forge login of the commit's author, or null if the forge couldn't map it to an account. */
  authorLogin: z.string().nullable(),
  committerLogin: z.string().nullable(),
  /** Whether the forge verified the commit's signature; null if it doesn't say. */
  verified: z.boolean().nullable(),
});

export type PrCommit = z.infer<typeof prCommitSchema>;

/** The merge rules that apply to a PR, as far as a read-only token can see them. */
export const repoPolicySchema = z.strictObject({
  baseRef: z.string(),
  /**
   * The host's review state for the PR. `REVIEW_REQUIRED`: a review rule applies and isn't met.
   * `NONE`: no review rule applies (GitHub reports an empty decision). Null if unknown.
   */
  reviewDecision: z.enum(["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED", "NONE"]).nullable(),
  /** GitHub's `mergeStateStatus`, e.g. `CLEAN`, `BLOCKED`, `BEHIND`, `DIRTY`. Null if unknown. */
  mergeStateStatus: z.string().nullable(),
  /** Whether merges to the base branch must go through a merge queue; null if unknown. */
  mergeQueueRequired: z.boolean().nullable(),
  /** Status checks the base branch requires, from branch protection and rulesets. */
  requiredChecks: z.array(z.string()),
});

export type RepoPolicy = z.infer<typeof repoPolicySchema>;

/** Where git fetches a pull request's head from. */
export interface Checkout {
  cloneUrl: string;
  /** Ref holding the head, e.g. `refs/pull/12/head` or `refs/merge-requests/12/head`. */
  headRef: string;
  /** Git credential helper for `cloneUrl`, e.g. `!gh auth git-credential`; empty for none. */
  credentialHelper: string;
}

/**
 * Everything the kitchen reads from or posts to a code host, with the evaluator's own login. One
 * interface so recipes can run against a fake in tests. Merging is not here: it needs the separate
 * merge identity in `src/merge/`.
 */
export interface Forge {
  getPullRequest(ref: PrRef): Promise<PullRequest>;
  /** Up to `limit` pull requests opened by `author`, in any state, newest first. */
  listPullRequests(repo: RepoRef, author: string, limit: number): Promise<PrRef[]>;
  /** Logins trusted to open dependency updates on the repository's host. */
  dependencyBots(repo: RepoRef): readonly string[];
  /** The PR's commits, oldest first. */
  getCommits(ref: PrRef): Promise<PrCommit[]>;
  /** Review and merge rules for the PR and its base branch. */
  getRepoPolicy(ref: PrRef, baseRef: string): Promise<RepoPolicy>;
  /** Checks and commit statuses reported for one commit. */
  getChecks(ref: PrRef, sha: string): Promise<Check[]>;
  checkout(ref: PrRef): Checkout;
  /** Creates the comment that starts with `marker`, or edits it if present. Returns its URL. */
  upsertComment(ref: PrRef, marker: string, body: string): Promise<string>;
}
