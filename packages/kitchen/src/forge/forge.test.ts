import assert from "node:assert/strict";
import { test } from "node:test";

import { dependencyBots, EMPTY_CONFIG } from "../config.ts";

import { parsePrUrl, parseRepo, prSlug, prUrl } from "./forge.ts";
import { branchRules, canonicalLogin, reviewDecision } from "./github.ts";
import { gitlabCheckState, gitlabReviewDecision } from "./gitlab.ts";

test("PR URLs from GitHub, GitHub Enterprise, and GitLab parse by their shape", () => {
  assert.deepEqual(parsePrUrl("https://github.com/octo/app/pull/12/files"), {
    forge: "github",
    host: "github.com",
    project: "octo/app",
    number: 12,
  });
  assert.deepEqual(parsePrUrl("https://www.github.com/octo/app/pull/12"), {
    forge: "github",
    host: "github.com",
    project: "octo/app",
    number: 12,
  });
  assert.deepEqual(parsePrUrl("https://github.acme.dev/octo/app/pull/3#discussion"), {
    forge: "github",
    host: "github.acme.dev",
    project: "octo/app",
    number: 3,
  });
  assert.deepEqual(
    parsePrUrl("https://gitlab.acme.dev:8443/web/sub/app/-/merge_requests/9/diffs"),
    {
      forge: "gitlab",
      host: "gitlab.acme.dev:8443",
      project: "web/sub/app",
      number: 9,
    },
  );
});

test("URLs that aren't a single pull or merge request don't parse", () => {
  for (const url of [
    "https://github.com/octo",
    "https://github.com/octo/app/issues/12",
    "https://github.com/group/sub/app/pull/12",
    "https://gitlab.com/web/app/merge_requests/9",
    "https://gitlab.com/web/app/-/merge_requests/",
  ])
    assert.equal(parsePrUrl(url), null, url);
});

test("a parsed URL round-trips through prUrl, and slugs carry the host", () => {
  for (const url of [
    "https://github.acme.dev/octo/app/pull/3",
    "https://gitlab.acme.dev/web/sub/app/-/merge_requests/9",
  ]) {
    const ref = parsePrUrl(url);

    assert.ok(ref !== null);
    assert.equal(prUrl(ref), url);
  }

  const gitlab = parsePrUrl("https://gitlab.acme.dev/web/app/-/merge_requests/9");

  assert.ok(gitlab !== null);
  assert.equal(prSlug(gitlab), "gitlab.acme.dev/web/app!9");
});

test("repositories: owner/repo means github.com; self-hosted URLs need the forge named", () => {
  assert.deepEqual(parseRepo("octo/app", null), {
    forge: "github",
    host: "github.com",
    project: "octo/app",
  });
  assert.deepEqual(parseRepo("https://gitlab.com/web/sub/app.git", null), {
    forge: "gitlab",
    host: "gitlab.com",
    project: "web/sub/app",
  });
  assert.deepEqual(parseRepo("https://gitlab.acme.dev/web/app/-/merge_requests", "gitlab"), {
    forge: "gitlab",
    host: "gitlab.acme.dev",
    project: "web/app",
  });
  assert.throws(
    () => parseRepo("https://git.acme.dev/web/app", null),
    /--forge github or --forge gitlab/,
  );
});

test("a configured bot is trusted only on the host it's listed under", () => {
  const config = { ...EMPTY_CONFIG, bots: new Map([["gitlab.acme.dev", ["renovate-bot"]]]) };

  const onHost = dependencyBots(config, {
    forge: "gitlab",
    host: "gitlab.acme.dev",
    project: "web/app",
  });

  const elsewhere = dependencyBots(config, {
    forge: "github",
    host: "github.com",
    project: "web/app",
  });

  assert.ok(onHost.includes("renovate-bot"));
  assert.ok(!elsewhere.includes("renovate-bot"));
  assert.ok(elsewhere.includes("dependabot[bot]"));
  assert.deepEqual(
    dependencyBots(EMPTY_CONFIG, { forge: "gitlab", host: "gitlab.com", project: "a/b" }),
    [],
  );
});

test("GitHub app logins take one form whichever API reported them; users keep theirs", () => {
  assert.equal(canonicalLogin("app/dependabot", true), "dependabot[bot]");
  assert.equal(canonicalLogin("dependabot[bot]", true), "dependabot[bot]");
  assert.equal(canonicalLogin("dependabot", true), "dependabot[bot]");
  assert.equal(canonicalLogin("dependabot", false), "dependabot");
});

test("GitLab jobs allowed to fail never block; a blocking manual job is still pending", () => {
  const cases: Array<[string, boolean, string]> = [
    ["success", false, "pass"],
    ["skipped", false, "pass"],
    ["failed", false, "fail"],
    ["failed", true, "pass"],
    ["canceled", false, "fail"],
    ["manual", true, "pass"],
    ["manual", false, "pending"],
    ["running", false, "pending"],
    ["created", false, "pending"],
  ];

  for (const [status, allowFailure, state] of cases)
    assert.equal(
      gitlabCheckState(status, allowFailure),
      state,
      `${status} allow_failure=${allowFailure}`,
    );
});

test("GitHub required checks merge rulesets with classic protection; a merge queue rule is reported", () => {
  const rules = [
    { type: "pull_request", parameters: null },
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "test" }, { context: "lint" }] },
    },
    { type: "merge_queue" },
  ];

  const branch = {
    protection: {
      required_status_checks: { contexts: ["build", "test"], checks: [{ context: "e2e" }] },
    },
  };

  assert.deepEqual(branchRules(rules, branch), {
    mergeQueueRequired: true,
    requiredChecks: ["build", "e2e", "lint", "test"],
  });
});

test("no rulesets means no merge queue; unreadable rulesets leave it unknown", () => {
  assert.deepEqual(branchRules([], {}), { mergeQueueRequired: false, requiredChecks: [] });
  assert.deepEqual(branchRules(null, { protection: { required_status_checks: null } }), {
    mergeQueueRequired: null,
    requiredChecks: [],
  });
});

test("GitLab approvals still owed mean a review is required; no approval rule is NONE", () => {
  const approvals = (required: number, left: number, approved: boolean) => ({
    approvals_required: required,
    approvals_left: left,
    approved,
  });

  assert.equal(gitlabReviewDecision(approvals(1, 1, false)), "REVIEW_REQUIRED");
  assert.equal(gitlabReviewDecision(approvals(1, 0, true)), "APPROVED");
  assert.equal(gitlabReviewDecision(approvals(0, 0, false)), "NONE");
  assert.equal(gitlabReviewDecision(approvals(2, 0, false)), null);
});

test("GitHub's empty review decision means no review rule applies; unknown values are unknown", () => {
  assert.equal(reviewDecision(""), "NONE");
  assert.equal(reviewDecision("REVIEW_REQUIRED"), "REVIEW_REQUIRED");
  assert.equal(reviewDecision("SOMETHING_NEW"), null);
});
