import { z } from "zod";

/**
 * Decision stages use Ollama's System One API: the model answers typed questions about a state
 * with probabilities, so every answer is already structured. https://docs.ollama.com/api/systemone
 */
export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria: { false: string; true: string } };

const answerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({ type: z.literal("noul"), noul: z.number() }),
]);

export type Answer = z.infer<typeof answerSchema>;

const responseSchema = z.object({ answers: z.record(z.string(), answerSchema) });

export interface Decider {
  readonly model: string;
  /** Answers every question about `state` (plain text or JSON text). */
  ask(state: string, questions: Record<string, Question>): Promise<Record<string, Answer>>;
}

const OLLAMA_URL = "http://localhost:11434";
const DECISION_TIMEOUT_MS = 120_000;

export const clefFlash: Decider = {
  model: "clef-flash:9b",

  async ask(state: string, questions: Record<string, Question>): Promise<Record<string, Answer>> {
    const response = await fetch(`${OLLAMA_URL}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, state, questions }),
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    });

    if (!response.ok) throw new Error(`System One ${response.status}: ${await response.text()}`);

    return responseSchema.parse(await response.json()).answers;
  },
};

/** The answer to `name` if it is a choice; throws if the model answered something else. */
export function choiceAnswer(
  answers: Record<string, Answer>,
  name: string,
): Extract<Answer, { type: "choice" }> {
  const answer = answers[name];

  if (answer?.type !== "choice") throw new Error(`System One returned no choice for "${name}"`);

  return answer;
}

/** The probability of `true` for `name`; throws if the model answered something else. */
export function noulAnswer(answers: Record<string, Answer>, name: string): number {
  const answer = answers[name];

  if (answer?.type !== "noul")
    throw new Error(`System One returned no yes/no answer for "${name}"`);

  return answer.noul;
}
