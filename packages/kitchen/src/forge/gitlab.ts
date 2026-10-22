import { z } from "zod";

import { dependencyBots, type KitchenConfig } from "../config.ts";
import { runChecked } from "../exec.ts";

import {
  prUrl,
  type Check,
  type Checkout,
  type Forge,
  type PrCommit,
  type PrRef,
  type PullRequest,
  type RepoPolicy,
  type RepoRef,
} from "./forge.ts";

const GLAB_TIMEOUT_MS = 30_000;

/** GitLab's page size limit. */
const PAGE_SIZE = 100;

const mergeRequestSchema = z.object({
  web_url: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  author: z.object({ username: z.string() }),
  state: z.enum(["opened", "closed", "merged", "locked"]),
  draft: z.boolean(),
  sha: z.string(),
  target_branch: z.string(),
  diff_refs: z.object({ base_sha: z.string() }).nullable(),
  labels: z.array(z.string()),
  created_at: z.string(),
  merged_at: z.string().nullable(),
  detailed_merge_status: z.string().nullish(),
});

const branchSchema = z.object({ commit: z.object({ id: z.string() }) });

const commitSchema = z.object({ id: z.string() });

const approvalsSchema = z.object({
  approvals_required: z.number(),
  approvals_left: z.number(),
  approved: z.boolean(),
});

const STATES = {
  opened: "OPEN",
  merged: "MERGED",
  closed: "CLOSED",
  locked: "CLOSED",
} as const satisfies Record<string, PullRequest["state"]>;

const statusSchema = z.object({
  name: z.string(),
  status: z.string(),
  allow_failure: z.boolean(),
});

const noteSchema = z.object({ id: z.number(), body: z.string(), system: z.boolean() });

/**
 * One commit status (a CI job or an external status) as a check. Jobs allowed to fail never block,
 * matching GitLab's own pipeline result; a blocking manual job waits for a person, so it's pending.
 */
export function gitlabCheckState(status: string, allowFailure: boolean): Check["state"] {
  switch (status) {
    case "success":
    case "skipped":
      return "pass";
    case "failed":
    case "canceled":
      return allowFailure ? "pass" : "fail";
    case "manual":
      return allowFailure ? "pass" : "pending";
    default:
      return "pending";
  }
}

/** `glab api` against the repository's host. */
async function glab(repo: RepoRef, args: readonly string[], stdin?: string): Promise<string> {
  const command = ["api", "--hostname", repo.host, ...args];

  return runChecked(
    "glab",
    command,
    stdin === undefined ? { timeoutMs: GLAB_TIMEOUT_MS } : { timeoutMs: GLAB_TIMEOUT_MS, stdin },
  );
}

async function glabJson<T>(
  schema: z.ZodType<T>,
  repo: RepoRef,
  args: readonly string[],
  stdin?: string,
): Promise<T> {
  return schema.parse(JSON.parse(await glab(repo, args, stdin)));
}

/** Every item of a paginated list endpoint. */
async function glabAll<T>(schema: z.ZodType<T>, repo: RepoRef, endpoint: string): Promise<T[]> {
  const output = await glab(repo, ["--paginate", "--output", "ndjson", endpoint]);

  return output
    .split("\n")
    .flatMap((line) => (line.trim() === "" ? [] : [schema.parse(JSON.parse(line))]));
}

function project(repo: RepoRef): string {
  return `projects/${encodeURIComponent(repo.project)}`;
}

function mergeRequest(ref: PrRef): string {
  return `${project(ref)}/merge_requests/${ref.number}`;
}

export type Approvals = z.infer<typeof approvalsSchema>;

/**
 * Approval state as GitHub's review decision: no approval rule is `NONE`, approvals still owed mean
 * a review is required.
 */
export function gitlabReviewDecision(approvals: Approvals): RepoPolicy["reviewDecision"] {
  if (approvals.approvals_required === 0) return "NONE";

  if (approvals.approvals_left > 0) return "REVIEW_REQUIRED";

  return approvals.approved ? "APPROVED" : null;
}

/**
 * GitLab.com and self-managed GitLab through the `glab` CLI, reusing its authentication. Sign in to
 * a host once with `glab auth login --hostname <host>`.
 */
export function createGitLab(config: KitchenConfig): Forge {
  return {
    async getPullRequest(ref: PrRef): Promise<PullRequest> {
      const mr = await glabJson(mergeRequestSchema, ref, [mergeRequest(ref)]);

      // `diff_refs` is null until GitLab has computed the MR's diff; the target's tip stands in.
      const baseSha =
        mr.diff_refs?.base_sha ??
        (
          await glabJson(branchSchema, ref, [
            `${project(ref)}/repository/branches/${encodeURIComponent(mr.target_branch)}`,
          ])
        ).commit.id;

      return {
        url: mr.web_url,
        title: mr.title,
        body: mr.description ?? "",
        author: {
          login: mr.author.username,
          // GitLab's MR author carries no bot flag; Renovate usually runs as an ordinary user anyway.
          isBot: false,
          dependencyBot: dependencyBots(config, ref).includes(mr.author.username),
        },
        state: STATES[mr.state],
        isDraft: mr.draft,
        headSha: mr.sha,
        baseRef: mr.target_branch,
        baseSha,
        labels: mr.labels,
        createdAt: mr.created_at,
        mergedAt: mr.merged_at,
      };
    },

    async listPullRequests(repo: RepoRef, author: string, limit: number): Promise<PrRef[]> {
      const refs: PrRef[] = [];

      for (let page = 1; refs.length < limit; page += 1) {
        const query = new URLSearchParams({
          author_username: author,
          state: "all",
          order_by: "created_at",
          sort: "desc",
          per_page: String(Math.min(PAGE_SIZE, limit)),
          page: String(page),
        });

        const listed = await glabJson(z.array(z.object({ iid: z.number() })), repo, [
          `${project(repo)}/merge_requests?${query.toString()}`,
        ]);

        refs.push(...listed.map(({ iid }) => ({ ...repo, number: iid })));

        if (listed.length < Math.min(PAGE_SIZE, limit)) break;
      }

      return refs.slice(0, limit);
    },

    dependencyBots(repo: RepoRef): readonly string[] {
      return dependencyBots(config, repo);
    },

    async getCommits(ref: PrRef): Promise<PrCommit[]> {
      const commits = await glabAll(
        commitSchema,
        ref,
        `${mergeRequest(ref)}/commits?per_page=${PAGE_SIZE}`,
      );

      // GitLab lists newest first and doesn't map commits to accounts or report signatures here.
      return commits.toReversed().map((commit) => ({
        sha: commit.id,
        authorLogin: null,
        committerLogin: null,
        verified: null,
      }));
    },

    async getRepoPolicy(ref: PrRef, baseRef: string): Promise<RepoPolicy> {
      const mr = await glabJson(mergeRequestSchema, ref, [mergeRequest(ref)]);
      const approvals = await glabJson(approvalsSchema, ref, [`${mergeRequest(ref)}/approvals`]);

      return {
        baseRef,
        reviewDecision: gitlabReviewDecision(approvals),
        mergeStateStatus: mr.detailed_merge_status ?? null,
        mergeQueueRequired: null,
        requiredChecks: [],
      };
    },

    async getChecks(ref: PrRef, sha: string): Promise<Check[]> {
      // Latest status per name: CI jobs of every pipeline on the commit, plus external statuses.
      const statuses = await glabAll(
        statusSchema,
        ref,
        `${project(ref)}/repository/commits/${sha}/statuses?per_page=${PAGE_SIZE}`,
      );

      return statuses.map((status) => ({
        name: status.name,
        state: gitlabCheckState(status.status, status.allow_failure),
      }));
    },

    checkout(ref: PrRef): Checkout {
      return {
        cloneUrl: `https://${ref.host}/${ref.project}.git`,
        headRef: `refs/merge-requests/${ref.number}/head`,
        credentialHelper: "!glab auth git-credential",
      };
    },

    async upsertComment(ref: PrRef, marker: string, body: string): Promise<string> {
      const notes = await glabAll(
        noteSchema,
        ref,
        `${mergeRequest(ref)}/notes?per_page=${PAGE_SIZE}`,
      );

      const existing = notes.find((note) => !note.system && note.body.startsWith(marker));
      const payload = JSON.stringify({ body });

      const note =
        existing === undefined
          ? await glabJson(
              noteSchema,
              ref,
              ["-X", "POST", `${mergeRequest(ref)}/notes`, "--input", "-"],
              payload,
            )
          : await glabJson(
              noteSchema,
              ref,
              ["-X", "PUT", `${mergeRequest(ref)}/notes/${existing.id}`, "--input", "-"],
              payload,
            );

      return `${prUrl(ref)}#note_${note.id}`;
    },
  };
}
