import { createPrivateKey, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { Check, PrRef, RepoRef } from "../forge/forge.ts";

import type { LivePullRequest } from "./authorize.ts";

/** The merge identity: a GitHub App, separate from the read-only identity the evaluator uses. */
export interface GitHubAppCredentials {
  appId: string;
  privateKeyPem: string;
}

export interface MergeRequest {
  /** The head commit that was assessed; GitHub refuses the merge if the head moved. */
  sha: string;
  method: "squash" | "merge" | "rebase";
  title: string;
  message: string;
}

/**
 * Everything the merge component does on GitHub. Deliberately small: it reads the live PR, approves
 * a specific commit, and merges a specific commit. Nothing here can bypass branch protection.
 */
export interface MergeClient {
  /** The App's own login, `<slug>[bot]`, which approves and merges. */
  identity(repo: RepoRef): Promise<string>;
  livePullRequest(ref: PrRef): Promise<LivePullRequest>;
  approve(ref: PrRef, sha: string, body: string): Promise<void>;
  merge(ref: PrRef, request: MergeRequest): Promise<void>;
}

/** The App lacks an installation, a permission, or access to the repository. */
export class MergePermissionError extends Error {
  override name = "MergePermissionError";
}

/** The repository's rules refuse the approval or merge; the kitchen never bypasses them. */
export class MergeRefusedError extends Error {
  override name = "MergeRefusedError";
}

/** The PR's head is no longer the assessed commit; the assessment no longer applies. */
export class HeadMovedError extends Error {
  override name = "HeadMovedError";
}

/** Reads the App's private key; parses it now so a bad key fails before any request. */
export async function loadAppCredentials(
  appId: string,
  privateKeyPath: string,
): Promise<GitHubAppCredentials> {
  const privateKeyPem = await readFile(privateKeyPath, "utf8");

  createPrivateKey(privateKeyPem);

  return { appId, privateKeyPem };
}

/**
 * The App's own JWT, which can only look up installations and mint installation tokens. `iat` is
 * backdated a minute for clock drift; GitHub rejects lifetimes over ten minutes.
 */
export function createAppJwt(credentials: GitHubAppCredentials, now: Date): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");

  const payload = Buffer.from(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: credentials.appId }),
  ).toString("base64url");

  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), credentials.privateKeyPem);

  return `${header}.${payload}.${signature.toString("base64url")}`;
}

/** The only permissions an installation token is minted with. */
const TOKEN_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
} as const;

/** Refresh an installation token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const installationSchema = z.object({ id: z.number().int() });

const accessTokenSchema = z.object({ token: z.string(), expires_at: z.string() });

const appSchema = z.object({ slug: z.string() });

const errorBodySchema = z.object({ message: z.string() });

const reviewSchema = z.object({ id: z.number(), state: z.string() });

const mergeResultSchema = z.object({ merged: z.boolean(), message: z.string() });

const livePullRequestSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              headRefOid: z.string(),
              baseRefName: z.string(),
              state: z.enum(["OPEN", "CLOSED", "MERGED"]),
              isDraft: z.boolean(),
              mergeStateStatus: z.string().nullable(),
              reviewDecision: z
                .enum(["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED"])
                .nullable(),
              author: z.object({ __typename: z.string(), login: z.string() }).nullable(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
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

const PASSING_CONCLUSIONS = ["success", "neutral", "skipped"];

const STATUS_STATES = {
  success: "pass",
  pending: "pending",
  failure: "fail",
  error: "fail",
} as const satisfies Record<string, Check["state"]>;

const LIVE_PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      baseRefName
      state
      isDraft
      mergeStateStatus
      reviewDecision
      author { __typename login }
    }
  }
}`;

/** GitHub's message when the head moved between reading the PR and merging it. */
const HEAD_MODIFIED = /head branch was modified/i;

interface ApiCall {
  method: "GET" | "POST" | "PUT";
  url: string;
  token: string;
  body?: unknown;
}

interface ApiResponse {
  status: number;
  ok: boolean;
  text: string;
  /** GitHub's error `message`, or the HTTP status when the body has none. */
  message: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Every GitHub response is decoded against the schema the caller expects before it is used. */
function decode<T>(schema: z.ZodType<T>, response: ApiResponse): T {
  return schema.parse(JSON.parse(response.text));
}

/** GitHub's error `message`; error pages from proxies may not be JSON at all. */
function errorMessage(status: number, text: string): string {
  try {
    const body = errorBodySchema.safeParse(JSON.parse(text));

    if (body.success) return body.data.message;
  } catch {
    // Not JSON: fall back to the status.
  }

  return `HTTP ${status}`;
}

function permissionError(action: string, response: ApiResponse): MergePermissionError {
  return new MergePermissionError(
    `merge permissions unavailable: ${action} returned ${response.status}: ${response.message}`,
  );
}

function unexpectedError(action: string, response: ApiResponse): Error {
  return new Error(`GitHub ${action} failed with ${response.status}: ${response.message}`);
}

/**
 * The approve/merge failures every write shares: a moved head, missing permissions, or repository
 * rules that refuse. Anything else is unexpected.
 */
function writeError(action: string, response: ApiResponse): Error {
  if (response.status === 409 || HEAD_MODIFIED.test(response.message)) {
    return new HeadMovedError(`PR head moved; ${action} refused: ${response.message}`);
  }

  if (response.status === 401 || response.status === 403) return permissionError(action, response);

  if (response.status === 405 || response.status === 422) {
    return new MergeRefusedError(
      `repository rules refuse to ${action} (${response.status}: ${response.message}); the kitchen won't bypass them`,
    );
  }

  return unexpectedError(action, response);
}

function splitProject(project: string): [string, string] {
  const [owner, name, ...rest] = project.split("/");

  if (owner === undefined || name === undefined || rest.length > 0) {
    throw new Error(`Expected a GitHub repository as owner/repo, got ${project}`);
  }

  return [owner, name];
}

function liveChecks(
  runs: z.infer<typeof checkRunsSchema>,
  statuses: z.infer<typeof statusesSchema>,
): Check[] {
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
}

/**
 * The merge component's GitHub client. Authenticates as the App, then mints an installation token
 * scoped to the one repository and to exactly the permissions approving and merging need. Never sends
 * admin or bypass parameters: if the rules say no, the answer is no.
 */
export function createGitHubAppClient(
  host: string,
  credentials: GitHubAppCredentials,
  fetchFn: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): MergeClient {
  const dotCom = host === "github.com";
  const base = dotCom ? "https://api.github.com" : `https://${host}/api/v3`;
  const graphql = dotCom ? "https://api.github.com/graphql" : `https://${host}/api/graphql`;
  const tokens = new Map<string, CachedToken>();
  let login: string | null = null;

  async function call(request: ApiCall): Promise<ApiResponse> {
    const headers = new Headers({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${request.token}`,
      "user-agent": "software-kitchen",
      "x-github-api-version": "2022-11-28",
    });

    const init: RequestInit = { method: request.method, headers };

    if (request.body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(request.body);
    }

    const response = await fetchFn(request.url, init);
    const text = await response.text();

    return {
      status: response.status,
      ok: response.ok,
      text,
      message: response.ok ? "" : errorMessage(response.status, text),
    };
  }

  function checkHost(repo: RepoRef): void {
    if (repo.host !== host) {
      throw new Error(`This merge client is for ${host}, not ${repo.host}`);
    }
  }

  function jwt(): string {
    return createAppJwt(credentials, now());
  }

  async function installationToken(repo: RepoRef): Promise<string> {
    checkHost(repo);

    const cached = tokens.get(repo.project);

    if (cached !== undefined && now().getTime() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }

    const [, name] = splitProject(repo.project);

    const installation = await call({
      method: "GET",
      url: `${base}/repos/${repo.project}/installation`,
      token: jwt(),
    });

    if ([401, 403, 404].includes(installation.status)) {
      throw permissionError(`installation lookup for ${repo.project}`, installation);
    }

    if (!installation.ok) throw unexpectedError("installation lookup", installation);

    const { id } = decode(installationSchema, installation);

    const minted = await call({
      method: "POST",
      url: `${base}/app/installations/${id}/access_tokens`,
      token: jwt(),
      body: { repositories: [name], permissions: TOKEN_PERMISSIONS },
    });

    // 422: the installation wasn't granted one of the requested permissions.
    if ([401, 403, 404, 422].includes(minted.status)) {
      throw permissionError(`installation token for ${repo.project}`, minted);
    }

    if (!minted.ok) throw unexpectedError("installation token", minted);

    const access = decode(accessTokenSchema, minted);

    tokens.set(repo.project, { token: access.token, expiresAt: Date.parse(access.expires_at) });

    return access.token;
  }

  async function read<T>(schema: z.ZodType<T>, url: string, token: string): Promise<T> {
    const response = await call({ method: "GET", url, token });

    if (response.status === 401 || response.status === 403) throw permissionError(url, response);

    if (!response.ok) throw unexpectedError(`GET ${url}`, response);

    return decode(schema, response);
  }

  return {
    async identity(repo: RepoRef): Promise<string> {
      checkHost(repo);

      if (login === null) {
        const app = await call({ method: "GET", url: `${base}/app`, token: jwt() });

        if (app.status === 401 || app.status === 403) throw permissionError("app lookup", app);

        if (!app.ok) throw unexpectedError("app lookup", app);

        login = `${decode(appSchema, app).slug}[bot]`;
      }

      return login;
    },

    async livePullRequest(ref: PrRef): Promise<LivePullRequest> {
      const token = await installationToken(ref);
      const [owner, name] = splitProject(ref.project);

      const response = await call({
        method: "POST",
        url: graphql,
        token,
        body: { query: LIVE_PULL_REQUEST_QUERY, variables: { owner, name, number: ref.number } },
      });

      if (response.status === 401 || response.status === 403) {
        throw permissionError("pull request lookup", response);
      }

      if (!response.ok) throw unexpectedError("pull request lookup", response);

      const result = decode(livePullRequestSchema, response);

      if (result.errors !== undefined && result.errors.length > 0) {
        const messages = result.errors.map((error) => error.message).join("; ");

        throw new Error(`GitHub pull request lookup failed: ${messages}`);
      }

      const pr = result.data?.repository?.pullRequest;

      if (pr === null || pr === undefined) {
        throw new Error(`Pull request ${ref.project}#${ref.number} not found`);
      }

      const commit = `${base}/repos/${ref.project}/commits/${pr.headRefOid}`;
      const runs = await read(checkRunsSchema, `${commit}/check-runs?per_page=100`, token);
      const statuses = await read(statusesSchema, `${commit}/status`, token);
      const author = pr.author;

      return {
        headSha: pr.headRefOid,
        baseRef: pr.baseRefName,
        state: pr.state,
        isDraft: pr.isDraft,
        // A deleted account shows up as GitHub's placeholder user.
        authorLogin:
          author === null
            ? "ghost"
            : author.__typename === "Bot"
              ? `${author.login}[bot]`
              : author.login,
        mergeStateStatus: pr.mergeStateStatus,
        // GitHub reports no review decision when no review rule applies to the PR.
        reviewDecision: pr.reviewDecision ?? "NONE",
        checks: liveChecks(runs, statuses),
      };
    },

    async approve(ref: PrRef, sha: string, body: string): Promise<void> {
      const token = await installationToken(ref);

      const response = await call({
        method: "POST",
        url: `${base}/repos/${ref.project}/pulls/${ref.number}/reviews`,
        token,
        body: { commit_id: sha, event: "APPROVE", body },
      });

      if (!response.ok) throw writeError("approve", response);

      decode(reviewSchema, response);
    },

    async merge(ref: PrRef, request: MergeRequest): Promise<void> {
      const token = await installationToken(ref);

      const response = await call({
        method: "PUT",
        url: `${base}/repos/${ref.project}/pulls/${ref.number}/merge`,
        token,
        body: {
          sha: request.sha,
          merge_method: request.method,
          commit_title: request.title,
          commit_message: request.message,
        },
      });

      if (!response.ok) throw writeError("merge", response);

      const result = decode(mergeResultSchema, response);

      if (!result.merged) {
        throw new MergeRefusedError(
          `repository rules refuse to merge (${result.message}); the kitchen won't bypass them`,
        );
      }
    },
  };
}
