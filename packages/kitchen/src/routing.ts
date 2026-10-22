import { choiceAnswer, type Decider, type Question } from "./decider.ts";
import { repoSlug, type PrRef, type PullRequest } from "./forge/forge.ts";
import { parseBump, type BumpLevel } from "./recipes/dependabot-bump/bump.ts";

const RISK_BY_LEVEL = {
  patch: "low",
  minor: "medium",
  major: "high",
  prerelease: "high",
  unknown: "high",
} satisfies Record<BumpLevel, string>;

export interface Recipe {
  /** What the triage model reads when choosing between recipes. */
  description: string;
  /** Plain-rule eligibility: a reason the PR doesn't qualify, or null if it does. */
  ineligibility(pr: PullRequest): string | null;
  /** Risk recorded on the WorkItem. */
  risk(pr: PullRequest): string;
}

export const RECIPES = {
  "dependabot-bump": {
    description:
      "A Dependabot or Renovate pull request that bumps a single dependency version: collect evidence, assess it against the safety policy, and report on the PR",
    ineligibility(pr: PullRequest): string | null {
      if (!pr.author.dependencyBot) return `opened by ${pr.author.login}, not a dependency bot`;

      if (pr.state !== "OPEN") return `PR is ${pr.state.toLowerCase()}`;

      if (parseBump(pr.title, pr.body) === null) return "not a single-package bump";

      return null;
    },
    risk(pr: PullRequest): string {
      return RISK_BY_LEVEL[parseBump(pr.title, pr.body)?.level ?? "unknown"];
    },
  },
} satisfies Record<string, Recipe>;

export type RecipeName = keyof typeof RECIPES;

export function isRecipeName(name: string): name is RecipeName {
  return Object.hasOwn(RECIPES, name);
}

const NONE = "none";

/** The triage question: which recipe fits? Built from the recipe descriptions so new recipes join automatically. */
export function triageQuestions() {
  const criteria = {
    [NONE]: "None of the other options fits this input",
    ...Object.fromEntries(
      Object.entries(RECIPES).map(([name, recipe]) => [name, recipe.description]),
    ),
  };

  return {
    recipe: { type: "choice", instructions: "Which recipe should handle this input?", criteria },
  } satisfies Record<string, Question>;
}

/** Context assembly for triage: what the model sees about a pull request. */
export function triageState(ref: PrRef, pr: PullRequest): string {
  return JSON.stringify({
    kind: "pull request",
    repository: repoSlug(ref),
    title: pr.title,
    author: pr.author.login,
    authorIsBot: pr.author.isBot,
    state: pr.state,
    labels: pr.labels,
    body: pr.body.replaceAll(/<[^>]+>/g, " ").slice(0, 1_500),
  });
}

export interface Proposal {
  recipe: RecipeName | typeof NONE;
  confidence: number;
  probabilities: Record<string, number>;
}

/** Triage: the model proposes a recipe. It decides nothing; `route` does. */
export async function triage(decider: Decider, ref: PrRef, pr: PullRequest): Promise<Proposal> {
  const answer = choiceAnswer(await decider.ask(triageState(ref, pr), triageQuestions()), "recipe");
  const recipe = answer.choice === NONE || isRecipeName(answer.choice) ? answer.choice : null;

  if (recipe === null) throw new Error(`Triage chose unknown recipe "${answer.choice}"`);

  return { recipe, confidence: answer.confidence, probabilities: answer.probabilities };
}

export type Route = { recipe: RecipeName; risk: string } | { recipe: null; reason: string };

/** Router: plain rules accept the proposal only if the PR is eligible for that recipe. */
export function route(proposal: Proposal, pr: PullRequest): Route {
  if (proposal.recipe === NONE) return { recipe: null, reason: "triage found no fitting recipe" };

  const recipe: Recipe = RECIPES[proposal.recipe];
  const reason = recipe.ineligibility(pr);

  if (reason !== null)
    return { recipe: null, reason: `${proposal.recipe} proposed, but ${reason}` };

  return { recipe: proposal.recipe, risk: recipe.risk(pr) };
}
