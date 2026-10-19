import { choiceAnswer, noulAnswer, type Decider, type Question } from "../../decider.ts";

import type { Bump } from "./bump.ts";
import type { Ci, Rating, Tests } from "./schemas.ts";

/** The questions the decision model answers about every bump. Edit these to change what it judges. */
export const BUMP_QUESTIONS = {
  verdict: {
    type: "choice",
    instructions:
      "This is a Dependabot pull request that updates one dependency. Using the version change, " +
      "the local test and CI results, and the release notes, decide whether it can merge without a human reading it.",
    criteria: {
      safe: "Routine update: tests and CI passed and the release notes show nothing a maintainer needs to act on",
      review: "A maintainer should read the release notes or diff before merging",
      unsafe: "Likely to break the project or change behavior it depends on",
    },
  },
  breaking: {
    type: "noul",
    instructions:
      "Do the release notes describe a breaking change, a removal, or a required migration?",
    criteria: {
      false: "No breaking change, removal, or migration is described",
      true: "A breaking change, removal, or migration is described",
    },
  },
} satisfies Record<string, Question>;

/** Characters of release notes sent to the model; System One rejects requests over 64 KiB. */
const NOTES_LIMIT = 6_000;

export interface BumpEvidence {
  bump: Bump;
  tests: Tests;
  ci: Ci;
  /** The PR body, which Dependabot fills with release notes, changelog, and commits. */
  body: string;
}

/** Context assembly for the rating: everything the model sees, as one JSON state. */
export function bumpState(evidence: BumpEvidence): string {
  const notes = evidence.body
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/[ \t]+/g, " ")
    .replaceAll(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, NOTES_LIMIT);

  return JSON.stringify({
    package: evidence.bump.package,
    from: evidence.bump.from,
    to: evidence.bump.to,
    versionChange: evidence.bump.level,
    localTests: evidence.tests.status,
    ci: evidence.ci.status,
    releaseNotes: notes,
  });
}

export async function rateBump(decider: Decider, evidence: BumpEvidence): Promise<Rating> {
  const answers = await decider.ask(bumpState(evidence), BUMP_QUESTIONS);
  const verdict = choiceAnswer(answers, "verdict");
  const choice = verdict.choice;

  if (choice !== "safe" && choice !== "review" && choice !== "unsafe")
    throw new Error(`Unexpected verdict "${choice}"`);

  return {
    model: decider.model,
    verdict: choice,
    probabilities: {
      safe: verdict.probabilities["safe"] ?? 0,
      review: verdict.probabilities["review"] ?? 0,
      unsafe: verdict.probabilities["unsafe"] ?? 0,
    },
    confidence: verdict.confidence,
    breaking: noulAnswer(answers, "breaking"),
  };
}
