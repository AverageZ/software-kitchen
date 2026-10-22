import { choiceAnswer, type Answer, type Decider, type Question } from "../decider.ts";

import type { AnalysisEvidence, ModelFinding, ReleaseNotesEvidence } from "./evidence.ts";

const INCONCLUSIVE = "inconclusive";

/**
 * What the model reads the release notes for. Each option is a rubric criterion, so the model can
 * only pick a finding the rubric defines; the evaluator decides what it costs. `inconclusive` lets
 * the model say the notes don't tell, which the evaluator treats as missing evidence.
 */
export const RELEASE_QUESTIONS = {
  releaseBehavior: {
    type: "choice",
    instructions:
      "These are the release notes for one dependency update. Which statement do the notes support?",
    criteria: {
      "release.no-relevant-change":
        "The notes describe only fixes, internal changes, or documentation: nothing a project using the package must act on",
      "release.behavior-change":
        "The notes describe a change in behavior, defaults, or output that a project using the package may notice",
      "release.explicit-incompatibility":
        "The notes state a breaking change, a removal, or a required migration",
      [INCONCLUSIVE]:
        "The notes don't say what changed: only links, version numbers, or commit hashes",
    },
  },
  compatibility: {
    type: "choice",
    instructions:
      "Do these release notes say that code or configuration using the package has to change?",
    criteria: {
      "compatibility.compatible":
        "No change to the package's API, options, or configuration format is described",
      "compatibility.api-or-config":
        "An API, option, or configuration format changes in a way that may need changes where it is used",
      [INCONCLUSIVE]: "The notes don't say enough to tell",
    },
  },
} satisfies Record<string, Question>;

const QUESTIONS = [
  ["releaseBehavior", "release-behavior"],
  ["compatibility", "compatibility"],
] as const satisfies readonly (readonly [
  keyof typeof RELEASE_QUESTIONS,
  ModelFinding["category"],
])[];

export interface AnalysisSubject {
  package: string;
  from: string;
  to: string;
  notes: ReleaseNotesEvidence;
  /** Id of the release-notes evidence item the findings cite. */
  notesId: string;
}

/** The model call as recorded for the owner to review; never read by the evaluator. */
export interface ModelCall {
  model: string;
  verdict: string;
  confidence: number;
  answers: Record<string, Answer>;
}

export interface Analysis {
  evidence: AnalysisEvidence;
  call: ModelCall;
}

/** Context assembly: the model sees the update and the notes, nothing it could mistake for a verdict. */
export function analysisState(subject: AnalysisSubject): string {
  return JSON.stringify({
    package: subject.package,
    from: subject.from,
    to: subject.to,
    releaseNotes: subject.notes.text,
  });
}

/** Asks the model for one structured finding per question. Throws if the model is unreachable. */
export async function analyzeReleaseNotes(
  decider: Decider,
  subject: AnalysisSubject,
): Promise<Analysis> {
  const answers = await decider.ask(analysisState(subject), RELEASE_QUESTIONS);

  const findings = QUESTIONS.map(([question, category]): ModelFinding => {
    const answer = choiceAnswer(answers, question);
    const criteria: Record<string, string> = RELEASE_QUESTIONS[question].criteria;
    const explanation = criteria[answer.choice];

    if (explanation === undefined)
      throw new Error(`Model chose unknown option "${answer.choice}" for ${question}`);

    return {
      category,
      component: subject.package,
      criterion: toCriterion(answer.choice),
      evidenceRef: subject.notesId,
      explanation: `Release notes (sha256 ${subject.notes.digest.slice(0, 12)}): ${explanation}`,
    };
  });

  const behavior = choiceAnswer(answers, "releaseBehavior");

  return {
    evidence: { model: decider.model, findings },
    call: {
      model: decider.model,
      verdict: behavior.choice,
      confidence: behavior.confidence,
      answers,
    },
  };
}

function toCriterion(choice: string): ModelFinding["criterion"] {
  switch (choice) {
    case "release.no-relevant-change":
    case "release.behavior-change":
    case "release.explicit-incompatibility":
    case "compatibility.compatible":
    case "compatibility.api-or-config":
    case INCONCLUSIVE:
      return choice;
    default:
      throw new Error(`Model chose unknown option "${choice}"`);
  }
}
