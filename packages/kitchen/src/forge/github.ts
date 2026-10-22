import { z } from "zod";

import { dependencyBots, type KitchenConfig } from "../config.ts";
import { lastLines, runChecked, runCommand } from "../exec.ts";

import type {
  Check,
  Checkout,
  Forge,
  PrCommit,
  PrRef,
  PullRequest,
  RepoPolicy,
  RepoRef,
} from "./forge.ts";

const GH_TIMEOUT_MS = 30_000;

const prViewSchema = z.object({
  url: z.string(),
  title: z.string(),
  body: z.string(),
  author: z.object({ login: z.string(), is_bot: z.boolean() }),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  baseRefOid: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  createdAt: z.string(),
  mergedAt: z.string().nullable(),
});

const accountSchema = z.object({ login: z.string() }).nullable();

const commitPagesSchema = z.array(
  z.array(
    z.object({
      sha: z.string(),
      author: accountSchema,
      committer: accountSchema,
      commit: z.object({
        verification: z.object({ verified: z.boolean() }).nullable().optional(),
      }),
    }),
  ),
);

const reviewStateSchema = z.object({ reviewDecision: z.string(), mergeStateStatus: z.string() });

const REVIEW_DECISIONS = ["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED"] as const;

/** A rule from `GET /repos/{p}/rules/branches/{branch}`: rulesets that apply to the branch. */
export const branchRuleSchema = z.object({
  type: z.string(),
  parameters: z
    .object({
      required_status_checks: z.array(z.object({ context: z.string() })).optional(),
    })
    .nullish(),
});

export type BranchRule = z.infer<typeof branchRuleSchema>;

/** `GET /repos/{p}/branches/{branch}`: classic branch protection, as far as a read token sees it. */
export const branchSchema = z.object({
  protection: z
    .object({
      required_status_checks: z
        .object({
          contexts: z.array(z.string()).optional(),
          checks: z.array(z.object({ context: z.string() })).optional(),
        })
        .nullish(),
    })
    .nullish(),
});

export type Branch = z.infer<typeof branchSchema>;

/** Merge rules derived from the branch's rulesets and its classic protection. */
export interface BranchRules {
  mergeQueueRequired: boolean | null;
  requiredChecks: string[];
}

/**
 * What a branch's rulesets and classic protection require. `rules` is null when the token can't read
 * rulesets, so whether a merge queue applies is unknown; an empty list means no ruleset applies.
 */
export function branchRules(rules: readonly BranchRule[] | null, branch: Branch): BranchRules {
  const required = new Set<string>();
  const classic = branch.protection?.required_status_checks;

  for (const context of classic?.contexts ?? []) required.add(context);

  for (const check of classic?.checks ?? []) required.add(check.context);

  for (const rule of rules ?? []) {
    if (rule.type !== "required_status_checks") continue;

    for (const check of rule.parameters?.required_status_checks ?? []) required.add(check.context);
  }

  return {
    mergeQueueRequired: rules === null ? null : rules.some((rule) => rule.type === "merge_queue"),
    requiredChecks: [...required].toSorted(),
  };
}

/**
 * gh reports an empty review decision when no review rule applies to the PR; that is `NONE`.
 * Anything outside the known states is unknown.
 */
export function reviewDecision(value: string): RepoPolicy["reviewDecision"] {
  if (value === "") return "NONE";

  return REVIEW_DECISIONS.find((decision) => decision === value) ?? null;
}

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }),
  ),
});

const statusesSchema = z.object({
  statuses: z.array(
    z.object({ context: z.string(), state: z.enum(["error", "failure", "pending", "success"]) }),
  ),
});

const commentIdSchema = z.object({ id: z.number(), html_url: z.string() });

const PASSING_CONCLUSIONS = ["success", "neutral", "skipped"];

const STATUS_STATES = {
  success: "pass",
  pending: "pending",
  failure: "fail",
  error: "fail",
} as const satisfies Record<string, Check["state"]>;

async function gh(args: readonly string[], stdin?: string): Promise<string> {
  return runChecked(
    "gh",
    args,
    stdin === undefined ? { timeoutMs: GH_TIMEOUT_MS } : { timeoutMs: GH_TIMEOUT_MS, stdin },
  );
}

async function ghJson<T>(
  schema: z.ZodType<T>,
  args: readonly string[],
  stdin?: string,
): Promise<T> {
  return schema.parse(JSON.parse(await gh(args, stdin)));
}

/**
 * `gh api` for an endpoint a read-only token may be refused: null on 403 (can't tell), the parsed
 * `missing` value on 404 (nothing configured). Any other failure throws.
 */
async function ghOptional<T>(
  schema: z.ZodType<T>,
  args: readonly string[],
  missing: T,
): Promise<T | null> {
  const result = await runCommand("gh", args, { timeoutMs: GH_TIMEOUT_MS });

  if (result.timedOut) throw new Error(`gh ${args.join(" ")} timed out after ${GH_TIMEOUT_MS}ms`);

  if (result.exitCode === 0) return schema.parse(JSON.parse(result.stdout));

  if (/HTTP 404/.test(result.output)) return missing;

  if (/HTTP 403/.test(result.output)) return null;

  throw new Error(
    `gh ${args.join(" ")} exited ${result.exitCode}: ${lastLines(result.output, 20)}`,
  );
}

/** `gh pr` commands take `HOST/OWNER/REPO`, which also reaches GitHub Enterprise. */
function repoArg(repo: RepoRef): string {
  return `${repo.host}/${repo.project}`;
}

/** `gh api` against the repository's host. */
function api(repo: RepoRef, ...args: string[]): string[] {
  return ["api", "--hostname", repo.host, ...args];
}

/**
 * `gh pr view` reports an app as `app/<slug>` and the REST API as `<slug>[bot]`; the kitchen uses
 * the REST form everywhere, which no user login can take.
 */
export function canonicalLogin(login: string, isBot: boolean): string {
  if (!isBot) return login;

  return `${login.replace(/^app\//, "").replace(/\[bot\]$/, "")}[bot]`;
}

/** Pages of the repository's PR list `listPullRequests` reads at most, newest first. */
const LIST_PAGES = 20;

const listedSchema = z.array(z.object({ number: z.number(), login: z.string().nullable() }));

/**
 * GitHub and GitHub Enterprise through the `gh` CLI, reusing its authentication. Sign in to an
 * Enterprise host once with `gh auth login --hostname <host>`.
 */
export function createGitHub(config: KitchenConfig): Forge {
  return {
    async getPullRequest(ref: PrRef): Promise<PullRequest> {
      const fields =
        "url,title,body,author,state,isDraft,headRefOid,baseRefName,baseRefOid,labels,createdAt,mergedAt";

      const view = await ghJson(prViewSchema, [
        "pr",
        "view",
        String(ref.number),
        "-R",
        repoArg(ref),
        "--json",
        fields,
      ]);

      const login = canonicalLogin(view.author.login, view.author.is_bot);

      return {
        url: view.url,
        title: view.title,
        body: view.body,
        author: {
          login,
          isBot: view.author.is_bot,
          dependencyBot: dependencyBots(config, ref).includes(login),
        },
        state: view.state,
        isDraft: view.isDraft,
        headSha: view.headRefOid,
        baseRef: view.baseRefName,
        baseSha: view.baseRefOid,
        labels: view.labels.map((label) => label.name),
        createdAt: view.createdAt,
        mergedAt: view.mergedAt === "" ? null : view.mergedAt,
      };
    },

    async listPullRequests(repo: RepoRef, author: string, limit: number): Promise<PrRef[]> {
      // Pages the repository's PR list and filters by author here. `gh pr list --author` goes
      // through search, which under load can answer with nothing at all; a replay must not
      // silently lose a bot's PRs. The REST list names apps `<slug>[bot]`, like `author`.
      const refs: PrRef[] = [];

      for (let page = 1; page <= LIST_PAGES && refs.length < limit; page += 1) {
        const listed = await ghJson(
          listedSchema,
          api(
            repo,
            `repos/${repo.project}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
            "--jq",
            "map({ number, login: .user.login })",
          ),
        );

        for (const pr of listed)
          if (pr.login === author && refs.length < limit) refs.push({ ...repo, number: pr.number });

        if (listed.length < 100) break;
      }

      return refs;
    },

    dependencyBots(repo: RepoRef): readonly string[] {
      return dependencyBots(config, repo);
    },

    async getCommits(ref: PrRef): Promise<PrCommit[]> {
      const pages = await ghJson(
        commitPagesSchema,
        api(
          ref,
          "--paginate",
          "--slurp",
          `repos/${ref.project}/pulls/${ref.number}/commits?per_page=100`,
        ),
      );

      return pages.flat().map((commit) => ({
        sha: commit.sha,
        authorLogin: commit.author?.login ?? null,
        committerLogin: commit.committer?.login ?? null,
        verified: commit.commit.verification?.verified ?? null,
      }));
    },

    async getRepoPolicy(ref: PrRef, baseRef: string): Promise<RepoPolicy> {
      const review = await ghJson(reviewStateSchema, [
        "pr",
        "view",
        String(ref.number),
        "-R",
        repoArg(ref),
        "--json",
        "reviewDecision,mergeStateStatus",
      ]);

      const rules = await ghOptional(
        z.array(branchRuleSchema),
        api(ref, `repos/${ref.project}/rules/branches/${baseRef}?per_page=100`),
        [],
      );

      const branch = await ghJson(
        branchSchema,
        api(ref, `repos/${ref.project}/branches/${baseRef}`),
      );

      return {
        baseRef,
        reviewDecision: reviewDecision(review.reviewDecision),
        mergeStateStatus: review.mergeStateStatus === "" ? null : review.mergeStateStatus,
        ...branchRules(rules, branch),
      };
    },

    async getChecks(ref: PrRef, sha: string): Promise<Check[]> {
      const commit = `repos/${ref.project}/commits/${sha}`;
      const runs = await ghJson(checkRunsSchema, api(ref, `${commit}/check-runs?per_page=100`));
      const statuses = await ghJson(statusesSchema, api(ref, `${commit}/status`));

      const checks: Check[] = runs.check_runs.map((run) => {
        if (run.status !== "completed") return { name: run.name, state: "pending" };

        return {
          name: run.name,
          state: PASSING_CONCLUSIONS.includes(run.conclusion ?? "") ? "pass" : "fail",
        };
      });

      for (const status of statuses.statuses) {
        checks.push({ name: status.context, state: STATUS_STATES[status.state] });
      }

      return checks;
    },

    checkout(ref: PrRef): Checkout {
      return {
        cloneUrl: `https://${ref.host}/${ref.project}.git`,
        headRef: `refs/pull/${ref.number}/head`,
        credentialHelper: "!gh auth git-credential",
      };
    },

    async upsertComment(ref: PrRef, marker: string, body: string): Promise<string> {
      const issue = `repos/${ref.project}/issues/${ref.number}`;

      const existing = await gh(
        api(
          ref,
          "--paginate",
          `${issue}/comments?per_page=100`,
          "--jq",
          `.[] | select(.body | startswith(${JSON.stringify(marker)})) | .id`,
        ),
      );

      const existingId = existing.trim().split("\n")[0];
      const payload = JSON.stringify({ body });

      const comment =
        existingId === undefined || existingId === ""
          ? await ghJson(
              commentIdSchema,
              api(ref, "-X", "POST", `${issue}/comments`, "--input", "-"),
              payload,
            )
          : await ghJson(
              commentIdSchema,
              api(
                ref,
                "-X",
                "PATCH",
                `repos/${ref.project}/issues/comments/${existingId}`,
                "--input",
                "-",
              ),
              payload,
            );

      return comment.html_url;
    },
  };
}
