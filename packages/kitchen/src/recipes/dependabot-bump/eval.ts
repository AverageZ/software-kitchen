import type { Decider } from "../../decider.ts";
import type { GitHub, PullRequest, RepoRef } from "../../github/pull-request.ts";

import { parseBumpTitle, type Bump } from "./bump.ts";
import { rateBump } from "./rate.ts";
import { modelFailures, percent, SAFE_PROBABILITY } from "./safe-rule.ts";
import type { Rating } from "./schemas.ts";

/** Dependabot's login as `gh pr list --author` expects it. */
const DEPENDABOT = "app/dependabot";

/** Safe-probability thresholds the summary compares, alongside the rule's own. */
const THRESHOLDS = [0.9, 0.8, 0.7, 0.6, 0.5];

const STATES = ["MERGED", "CLOSED", "OPEN"] as const satisfies readonly PullRequest["state"][];

export interface EvalCase {
  number: number;
  state: PullRequest["state"];
  bump: Bump;
  rating: Rating;
}

/**
 * Replays a repository's past single-package Dependabot bumps through the decision model, newest first.
 * Each is rated as if local tests and CI passed: the recipe only asks the model then.
 */
export async function* replayBumps(
  github: GitHub,
  decider: Decider,
  repo: RepoRef,
  limit: number,
): AsyncGenerator<EvalCase> {
  for (const ref of await github.listPullRequests(repo, DEPENDABOT, limit)) {
    const pullRequest = await github.getPullRequest(ref);
    const bump = parseBumpTitle(pullRequest.title);

    if (bump === null) continue;

    const rating = await rateBump(decider, {
      bump,
      tests: { status: "passed", command: null, log: "" },
      ci: { status: "passed", checks: [] },
      body: pullRequest.body,
    });

    yield { number: ref.number, state: pullRequest.state, bump, rating };
  }
}

export const EVAL_HEADER = "PR     state   level    safe review unsafe breaking  model  bump";

/** One table row; `model` is whether the rule's model clauses pass at today's thresholds. */
export function formatCase(evalCase: EvalCase): string {
  const { number, state, bump, rating } = evalCase;
  const { safe, review, unsafe } = rating.probabilities;
  const passes = modelFailures(rating).length === 0;

  return [
    `#${number}`.padEnd(6),
    state.padEnd(7),
    bump.level.padEnd(7),
    percent(safe).padStart(5),
    percent(review).padStart(6),
    percent(unsafe).padStart(6),
    percent(rating.breaking).padStart(8),
    (passes ? "pass" : "fail").padEnd(6),
    `${bump.package} ${bump.from} → ${bump.to}`,
  ].join(" ");
}

/**
 * How many bumps per PR state pass the model clauses at each safe threshold. Only patch and minor
 * bumps count; the rule's semver clause fails the rest whatever the model says.
 */
export function formatSummary(cases: readonly EvalCase[]): string {
  const eligible = cases.filter((c) => c.bump.level === "patch" || c.bump.level === "minor");
  const thresholds = [...new Set([...THRESHOLDS, SAFE_PROBABILITY])].toSorted((a, b) => b - a);

  const rows = thresholds.map((threshold) => {
    const label = `${percent(threshold)}${threshold === SAFE_PROBABILITY ? " (rule)" : ""}`;

    const counts = STATES.map((state) => {
      const inState = eligible.filter((c) => c.state === state);
      const passing = inState.filter((c) => modelFailures(c.rating, threshold).length === 0);

      return `${passing.length}/${inState.length}`.padEnd(8);
    });

    return `${label.padEnd(12)}${counts.join("")}`.trimEnd();
  });

  return [
    `Passing the model clauses, patch and minor bumps only (${eligible.length} of ${cases.length}).`,
    "Merged bumps are ones you accepted; closed ones are usually superseded.",
    "",
    "safe ≥      merged  closed  open",
    ...rows,
  ].join("\n");
}
