import { z } from "zod";

import { runChecked } from "../exec.ts";

import type { Check, GitHub, PrRef, PullRequest } from "./pull-request.ts";

const GH_TIMEOUT_MS = 30_000;

const prViewSchema = z.object({
  url: z.string(),
  title: z.string(),
  body: z.string(),
  author: z.object({ login: z.string(), is_bot: z.boolean() }),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headRefOid: z.string(),
  labels: z.array(z.object({ name: z.string() })),
});

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

/** GitHub through the `gh` CLI, reusing its authentication. */
export const ghGitHub: GitHub = {
  async getPullRequest(ref: PrRef): Promise<PullRequest> {
    const fields = "url,title,body,author,state,isDraft,headRefOid,labels";

    const view = await ghJson(prViewSchema, [
      "pr",
      "view",
      String(ref.number),
      "-R",
      `${ref.owner}/${ref.repo}`,
      "--json",
      fields,
    ]);

    return {
      url: view.url,
      title: view.title,
      body: view.body,
      author: { login: view.author.login, isBot: view.author.is_bot },
      state: view.state,
      isDraft: view.isDraft,
      headSha: view.headRefOid,
      labels: view.labels.map((label) => label.name),
    };
  },

  async getChecks(ref: PrRef, sha: string): Promise<Check[]> {
    const commit = `repos/${ref.owner}/${ref.repo}/commits/${sha}`;
    const runs = await ghJson(checkRunsSchema, ["api", `${commit}/check-runs?per_page=100`]);
    const statuses = await ghJson(statusesSchema, ["api", `${commit}/status`]);

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

  cloneUrl(ref: PrRef): string {
    return `https://github.com/${ref.owner}/${ref.repo}.git`;
  },

  async upsertComment(ref: PrRef, marker: string, body: string): Promise<string> {
    const issue = `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;

    const existing = await gh([
      "api",
      "--paginate",
      `${issue}/comments?per_page=100`,
      "--jq",
      `.[] | select(.body | startswith(${JSON.stringify(marker)})) | .id`,
    ]);

    const existingId = existing.trim().split("\n")[0];
    const payload = JSON.stringify({ body });

    const comment =
      existingId === undefined || existingId === ""
        ? await ghJson(
            commentIdSchema,
            ["api", "-X", "POST", `${issue}/comments`, "--input", "-"],
            payload,
          )
        : await ghJson(
            commentIdSchema,
            [
              "api",
              "-X",
              "PATCH",
              `repos/${ref.owner}/${ref.repo}/issues/comments/${existingId}`,
              "--input",
              "-",
            ],
            payload,
          );

    return comment.html_url;
  },

  async merge(ref: PrRef, sha: string): Promise<void> {
    await gh([
      "pr",
      "merge",
      String(ref.number),
      "-R",
      `${ref.owner}/${ref.repo}`,
      "--squash",
      "--match-head-commit",
      sha,
    ]);
  },
};
