import { z } from "zod";

const NAME = /^[\w.-]+$/;

export const prRefSchema = z.object({
  owner: z.string().regex(NAME),
  repo: z.string().regex(NAME),
  number: z.number().int().positive(),
});

export type PrRef = z.infer<typeof prRefSchema>;

/** A repository, e.g. `octo/app`. */
export type RepoRef = Pick<PrRef, "owner" | "repo">;

const REPO = /^([\w.-]+)\/([\w.-]+)$/;

/** Parses `owner/repo`. */
export function parseRepo(text: string): RepoRef | null {
  const match = REPO.exec(text.trim());

  if (match === null) return null;

  const [, owner, repo] = match;

  if (owner === undefined || repo === undefined) return null;

  return { owner, repo };
}

const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** A pull request URL such as `https://github.com/octo/app/pull/12`; `parsePrUrl` accepts anything this does. */
export const prUrlSchema = z
  .string()
  .trim()
  .regex(PR_URL, "Expected a GitHub pull request URL, e.g. https://github.com/OWNER/REPO/pull/12");

/** Parses a GitHub pull request URL, tolerating tab suffixes such as `/files`, queries, and fragments. */
export function parsePrUrl(text: string): PrRef | null {
  const match = PR_URL.exec(text.trim());

  if (match === null) return null;

  const [, owner, repo, number] = match;

  if (owner === undefined || repo === undefined || number === undefined) return null;

  return { owner, repo, number: Number(number) };
}

/** Stable identity of a pull request, e.g. `octo/repo#12`. Used for deduplication and display. */
export function prSlug(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export const pullRequestSchema = z.object({
  url: z.string(),
  title: z.string(),
  body: z.string(),
  author: z.object({ login: z.string(), isBot: z.boolean() }),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headSha: z.string(),
  labels: z.array(z.string()),
});

export type PullRequest = z.infer<typeof pullRequestSchema>;

export const checkSchema = z.object({
  name: z.string(),
  state: z.enum(["pass", "fail", "pending"]),
});

export type Check = z.infer<typeof checkSchema>;

/** Everything the kitchen does to GitHub. One interface so recipes can run against a fake in tests. */
export interface GitHub {
  getPullRequest(ref: PrRef): Promise<PullRequest>;
  /** Up to `limit` pull requests opened by `author`, in any state, newest first. */
  listPullRequests(repo: RepoRef, author: string, limit: number): Promise<PrRef[]>;
  /** Checks and commit statuses reported for one commit. */
  getChecks(ref: PrRef, sha: string): Promise<Check[]>;
  /** Git URL to clone; the PR head is fetched from `refs/pull/<n>/head`. */
  cloneUrl(ref: PrRef): string;
  /** Creates the comment that starts with `marker`, or edits it if present. Returns its URL. */
  upsertComment(ref: PrRef, marker: string, body: string): Promise<string>;
  /** Squash-merges only if the head is still `sha`. */
  merge(ref: PrRef, sha: string): Promise<void>;
}

/** True for Dependabot, whose login differs between the GraphQL and REST APIs. */
export function isDependabot(pr: PullRequest): boolean {
  return (
    pr.author.isBot && ["app/dependabot", "dependabot[bot]", "dependabot"].includes(pr.author.login)
  );
}
