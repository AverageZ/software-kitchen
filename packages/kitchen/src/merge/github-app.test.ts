import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";

import type { PrRef } from "../forge/forge.ts";

import {
  createAppJwt,
  createGitHubAppClient,
  type GitHubAppCredentials,
  HeadMovedError,
  MergeRefusedError,
} from "./github-app.ts";

const KEYS = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const CREDENTIALS: GitHubAppCredentials = { appId: "4242", privateKeyPem: KEYS.privateKey };

const NOW = new Date("2026-10-22T12:00:00.000Z");

const REF: PrRef = { forge: "github", host: "github.com", project: "octo/app", number: 12 };

const SHA = "a".repeat(40);

const MERGE = { sha: SHA, method: "squash", title: "chore: bump x", message: "safe" } as const;

interface Recorded {
  method: string;
  url: string;
  authorization: string;
  body: unknown;
}

interface Reply {
  status: number;
  body: unknown;
}

interface FakeGitHub {
  fetchFn: typeof fetch;
  calls: Recorded[];
}

/** Routes `METHOD url` to a reply; unrouted requests fail the test. Records every request. */
function fakeGitHub(routes: Record<string, Reply>): FakeGitHub {
  const calls: Recorded[] = [];

  const fetchFn: typeof fetch = async (input, init) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body;

    calls.push({
      method,
      url,
      authorization: headers.get("authorization") ?? "",
      body: body === undefined || body === null ? null : JSON.parse(String(body)),
    });

    const reply = routes[`${method} ${url}`];

    assert.ok(reply !== undefined, `unexpected request ${method} ${url}`);

    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };

  return { fetchFn, calls };
}

const TOKEN_ROUTES = {
  "GET https://api.github.com/repos/octo/app/installation": { status: 200, body: { id: 77 } },
  "POST https://api.github.com/app/installations/77/access_tokens": {
    status: 201,
    body: { token: "ghs_installation", expires_at: "2026-10-22T13:00:00Z" },
  },
} satisfies Record<string, Reply>;

const MERGE_URL = "PUT https://api.github.com/repos/octo/app/pulls/12/merge";

const REVIEW_URL = "POST https://api.github.com/repos/octo/app/pulls/12/reviews";

test("the App JWT is RS256-signed with the App's key and carries the right claims", () => {
  const jwt = createAppJwt(CREDENTIALS, NOW);
  const [header, payload, signature] = jwt.split(".");
  const seconds = NOW.getTime() / 1000;

  assert.deepEqual(JSON.parse(Buffer.from(header ?? "", "base64url").toString()), {
    alg: "RS256",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload ?? "", "base64url").toString()), {
    iat: seconds - 60,
    exp: seconds + 540,
    iss: "4242",
  });

  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      KEYS.publicKey,
      Buffer.from(signature ?? "", "base64url"),
    ),
  );
});

test("the installation token asks for exactly four permissions on the one repository", async () => {
  const { fetchFn, calls } = fakeGitHub({
    ...TOKEN_ROUTES,
    [MERGE_URL]: { status: 200, body: { merged: true, message: "merged", sha: "m" } },
  });

  const client = createGitHubAppClient("github.com", CREDENTIALS, fetchFn, () => NOW);

  await client.merge(REF, MERGE);
  await client.merge(REF, MERGE);

  const tokenCalls = calls.filter((call) => call.url.endsWith("/access_tokens"));

  assert.equal(tokenCalls.length, 1, "the token is cached until close to expiry");
  assert.deepEqual(tokenCalls[0]?.body, {
    repositories: ["app"],
    permissions: { contents: "write", pull_requests: "write", checks: "read", statuses: "read" },
  });
  assert.match(calls[0]?.authorization ?? "", /^Bearer ey/);
  assert.equal(calls.at(-1)?.authorization, "Bearer ghs_installation");
});

test("a 403 on token creation is a MergePermissionError", async () => {
  const { fetchFn } = fakeGitHub({
    ...TOKEN_ROUTES,
    "POST https://api.github.com/app/installations/77/access_tokens": {
      status: 403,
      body: { message: "Resource not accessible by integration" },
    },
  });

  const client = createGitHubAppClient("github.com", CREDENTIALS, fetchFn, () => NOW);

  await assert.rejects(client.merge(REF, MERGE), {
    name: "MergePermissionError",
    message: /^merge permissions unavailable: .*Resource not accessible by integration/,
  });
});

test("merge sends the assessed sha and no bypass parameters", async () => {
  const { fetchFn, calls } = fakeGitHub({
    ...TOKEN_ROUTES,
    [MERGE_URL]: { status: 200, body: { merged: true, message: "merged", sha: "m" } },
  });

  const client = createGitHubAppClient("github.com", CREDENTIALS, fetchFn, () => NOW);

  await client.merge(REF, MERGE);

  assert.deepEqual(calls.at(-1)?.body, {
    sha: SHA,
    merge_method: "squash",
    commit_title: "chore: bump x",
    commit_message: "safe",
  });
});

test("a 405 on merge is a MergeRefusedError that won't bypass the rules", async () => {
  const { fetchFn } = fakeGitHub({
    ...TOKEN_ROUTES,
    [MERGE_URL]: { status: 405, body: { message: "Required status check is expected" } },
  });

  const client = createGitHubAppClient("github.com", CREDENTIALS, fetchFn, () => NOW);

  await assert.rejects(client.merge(REF, MERGE), {
    name: "MergeRefusedError",
    message: /won't bypass/,
  });
});

test("a 409, or GitHub's head-modified message, is a HeadMovedError", async () => {
  for (const reply of [
    { status: 409, body: { message: "Head branch was modified. Review and try the merge again." } },
    { status: 405, body: { message: "Head branch was modified. Review and try the merge again." } },
  ]) {
    const { fetchFn } = fakeGitHub({ ...TOKEN_ROUTES, [MERGE_URL]: reply });
    const client = createGitHubAppClient("github.com", CREDENTIALS, fetchFn, () => NOW);

    await assert.rejects(client.merge(REF, MERGE), HeadMovedError);
  }
});

test("approve reviews the assessed commit", async () => {
  const { fetchFn, calls } = fakeGitHub({
    ...TOKEN_ROUTES,
    [REVIEW_URL]: { status: 200, body: { id: 5, state: "APPROVED" } },
  });

  const client = createGitHubAppClient("github.com", CREDENTIALS, fetchFn, () => NOW);

  await client.approve(REF, SHA, "safe to merge");

  assert.deepEqual(calls.at(-1)?.body, { commit_id: SHA, event: "APPROVE", body: "safe to merge" });
});

test("a 422 on approve is a MergeRefusedError", async () => {
  const { fetchFn } = fakeGitHub({
    ...TOKEN_ROUTES,
    [REVIEW_URL]: { status: 422, body: { message: "Can not approve your own pull request" } },
  });

  const client = createGitHubAppClient("github.com", CREDENTIALS, fetchFn, () => NOW);

  await assert.rejects(client.approve(REF, SHA, "ok"), MergeRefusedError);
});

test("the live PR maps the bot author, merge state, and head checks", async () => {
  const commit = `https://ghe.acme.dev/api/v3/repos/octo/app/commits/${SHA}`;

  const { fetchFn } = fakeGitHub({
    "GET https://ghe.acme.dev/api/v3/repos/octo/app/installation": { status: 200, body: { id: 9 } },
    "POST https://ghe.acme.dev/api/v3/app/installations/9/access_tokens": {
      status: 201,
      body: { token: "ghs_x", expires_at: "2026-10-22T13:00:00Z" },
    },
    "POST https://ghe.acme.dev/api/graphql": {
      status: 200,
      body: {
        data: {
          repository: {
            pullRequest: {
              headRefOid: SHA,
              baseRefName: "main",
              state: "OPEN",
              isDraft: false,
              mergeStateStatus: "BLOCKED",
              reviewDecision: "REVIEW_REQUIRED",
              author: { __typename: "Bot", login: "renovate" },
            },
          },
        },
      },
    },
    [`GET ${commit}/check-runs?per_page=100`]: {
      status: 200,
      body: {
        check_runs: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "e2e", status: "in_progress", conclusion: null },
        ],
      },
    },
    [`GET ${commit}/status`]: {
      status: 200,
      body: { statuses: [{ context: "ci/legacy", state: "failure" }] },
    },
  });

  const client = createGitHubAppClient("ghe.acme.dev", CREDENTIALS, fetchFn, () => NOW);

  assert.deepEqual(await client.livePullRequest({ ...REF, host: "ghe.acme.dev" }), {
    headSha: SHA,
    baseRef: "main",
    state: "OPEN",
    isDraft: false,
    authorLogin: "renovate[bot]",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    checks: [
      { name: "build", state: "pass" },
      { name: "e2e", state: "pending" },
      { name: "ci/legacy", state: "fail" },
    ],
  });
});

test("the App identity is its slug as a bot login", async () => {
  const { fetchFn } = fakeGitHub({
    "GET https://api.github.com/app": { status: 200, body: { slug: "kitchen-merge" } },
  });

  const client = createGitHubAppClient("github.com", CREDENTIALS, fetchFn, () => NOW);

  assert.equal(await client.identity(REF), "kitchen-merge[bot]");
});
