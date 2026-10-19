import type { Bump } from "./bump.ts";
import { percent } from "./safe-rule.ts";
import type { Ci, Rating, RuleResult, Tests } from "./schemas.ts";

/** First line of the kitchen's comment; reruns edit the comment that starts with it. */
export const COMMENT_MARKER = "<!-- software-kitchen:dependabot-bump -->";

export interface CommentFacts {
  bump: Bump;
  headSha: string;
  tests: Tests;
  ci: Ci;
  rating: Rating | null;
  rule: RuleResult;
  merge: "merged" | "not-allowed" | "rule-failed" | "parked";
  parked: { reason: string; nextAction: string } | null;
}

export function renderComment(facts: CommentFacts): string {
  const { bump, tests, ci, rating, rule } = facts;
  const command = tests.command === null ? "" : `: \`${tests.command}\``;
  const failedChecks = ci.checks.flatMap((check) => (check.state === "pass" ? [] : [check.name]));

  const ciDetail =
    failedChecks.length === 0
      ? `${ci.checks.length} checks`
      : `not passing: ${failedChecks.join(", ")}`;

  const ratingText =
    rating === null
      ? "skipped"
      : `${rating.verdict} (safe ${percent(rating.probabilities.safe)}, review ${percent(rating.probabilities.review)}, ` +
        `unsafe ${percent(rating.probabilities.unsafe)}); breaking change ${percent(rating.breaking)}`;

  const mergeText = {
    merged: "merged",
    "not-allowed": "not attempted: auto-merge is off for this run",
    "rule-failed": "not attempted: safe rule failed",
    parked: "not attempted: run parked",
  }[facts.merge];

  const lines = [
    COMMENT_MARKER,
    `### Software Kitchen: \`${bump.package}\` ${bump.from} → ${bump.to} (${bump.level})`,
    "",
    `Checked commit \`${facts.headSha.slice(0, 7)}\`.`,
    "",
    "| Stage | Result |",
    "| --- | --- |",
    `| Local tests | ${tests.status}${command} |`,
    `| CI | ${ci.status === "skipped" ? "skipped" : `${ci.status} (${ciDetail})`} |`,
    `| Model${rating === null ? "" : ` (\`${rating.model}\`)`} | ${ratingText} |`,
    `| Safe rule | ${rule.safe ? "passes" : `fails: ${rule.failures.join("; ")}`} |`,
    `| Merge | ${mergeText} |`,
  ];

  if (facts.parked !== null) {
    lines.push("", `**Parked:** ${facts.parked.reason}. **Next:** ${facts.parked.nextAction}`);
  }

  if (tests.log.trim() !== "") {
    lines.push(
      "",
      "<details><summary>Test log (tail)</summary>",
      "",
      "````text",
      tests.log.trimEnd(),
      "````",
      "",
      "</details>",
    );
  }

  return lines.join("\n");
}
