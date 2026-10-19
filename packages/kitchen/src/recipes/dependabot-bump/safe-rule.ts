import { isDependabot, type PullRequest } from "../../github/pull-request.ts";

import type { Bump } from "./bump.ts";
import type { Ci, Rating, RuleResult, Tests } from "./schemas.ts";

/** Minimum probability the model must give `safe`. */
export const SAFE_PROBABILITY = 0.8;

/** Maximum probability the model may give a breaking change. */
export const BREAKING_PROBABILITY = 0.2;

export interface RuleEvidence {
  pullRequest: PullRequest;
  bump: Bump;
  tests: Tests;
  ci: Ci;
  rating: Rating | null;
}

/**
 * The draft "safe to merge unattended" rule from ARCHITECTURE.md. Every clause must hold.
 * Keep the two in sync: the document is the contract, this is its enforcement.
 */
export function evaluateSafeRule(evidence: RuleEvidence): RuleResult {
  const { pullRequest, bump, tests, ci, rating } = evidence;
  const failures: string[] = [];

  if (!isDependabot(pullRequest)) failures.push("not opened by Dependabot");

  if (pullRequest.state !== "OPEN" || pullRequest.isDraft)
    failures.push("PR is not open and ready");

  if (bump.level !== "patch" && bump.level !== "minor")
    failures.push(`${bump.level} version change`);

  if (tests.status !== "passed") failures.push(`local tests ${tests.status}`);

  if (ci.status !== "passed") failures.push(`CI ${ci.status}`);

  if (rating === null) {
    failures.push("no model rating");
  } else {
    if (rating.verdict !== "safe" || rating.probabilities.safe < SAFE_PROBABILITY) {
      failures.push(
        `model says ${rating.verdict} (safe ${percent(rating.probabilities.safe)} < ${percent(SAFE_PROBABILITY)})`,
      );
    }

    if (rating.breaking >= BREAKING_PROBABILITY) {
      failures.push(`breaking change likely (${percent(rating.breaking)})`);
    }
  }

  return { safe: failures.length === 0, failures };
}

export function percent(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}
