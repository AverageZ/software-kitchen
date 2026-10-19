import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BREAKING_PROBABILITY,
  evaluateSafeRule,
  SAFE_PROBABILITY,
  type RuleEvidence,
} from "./safe-rule.ts";

const passing: RuleEvidence = {
  pullRequest: {
    url: "https://github.com/octo/app/pull/1",
    title: "Bump left-pad from 1.3.0 to 1.3.1",
    body: "",
    author: { login: "app/dependabot", isBot: true },
    state: "OPEN",
    isDraft: false,
    headSha: "abc",
    labels: [],
  },
  bump: { package: "left-pad", from: "1.3.0", to: "1.3.1", directory: null, level: "patch" },
  tests: { status: "passed", command: "npm test", log: "" },
  ci: { status: "passed", checks: [{ name: "build", state: "pass" }] },
  rating: {
    model: "m",
    verdict: "safe",
    probabilities: { safe: SAFE_PROBABILITY, review: 0.1, unsafe: 0.1 },
    confidence: 0.8,
    breaking: BREAKING_PROBABILITY - 0.01,
  },
};

test("a bump at every threshold's edge passes", () => {
  assert.deepEqual(evaluateSafeRule(passing), { safe: true, failures: [] });
});

test("each clause can fail the rule on its own", () => {
  const cases: Array<[string, RuleEvidence]> = [
    ["major version change", { ...passing, bump: { ...passing.bump, level: "major" } }],
    ["local tests no-tests", { ...passing, tests: { ...passing.tests, status: "no-tests" } }],
    ["CI none", { ...passing, ci: { status: "none", checks: [] } }],
    ["no model rating", { ...passing, rating: null }],
    [
      "not opened by Dependabot",
      {
        ...passing,
        pullRequest: { ...passing.pullRequest, author: { login: "octocat", isBot: false } },
      },
    ],
  ];

  for (const [failure, evidence] of cases)
    assert.deepEqual(evaluateSafeRule(evidence).failures, [failure]);
});

test("the model must be confident the bump is safe and not breaking", () => {
  const rating = passing.rating;

  assert.ok(rating !== null);

  const unsure = evaluateSafeRule({
    ...passing,
    rating: {
      ...rating,
      probabilities: { ...rating.probabilities, safe: SAFE_PROBABILITY - 0.01 },
    },
  });

  const breaking = evaluateSafeRule({
    ...passing,
    rating: { ...rating, breaking: BREAKING_PROBABILITY },
  });

  assert.equal(unsure.safe, false);
  assert.match(unsure.failures[0] ?? "", /model says safe/);
  assert.deepEqual(breaking.failures, ["breaking change likely (20%)"]);
});
