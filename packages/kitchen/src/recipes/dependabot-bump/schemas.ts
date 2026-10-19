import { z } from "zod";

import { checkSchema, prRefSchema, pullRequestSchema } from "../../github/pull-request.ts";

import { bumpSchema } from "./bump.ts";

export const recipeInputSchema = z.object({
  pr: prRefSchema,
  /** Merge when the safe rule passes. Off unless the owner opts in per run. */
  allowMerge: z.boolean().default(false),
});

export const inspectedSchema = recipeInputSchema.extend({
  pullRequest: pullRequestSchema,
  bump: bumpSchema,
});

export const testsSchema = z.object({
  status: z.enum(["passed", "failed", "install-failed", "timed-out", "no-tests", "unsupported"]),
  /** The command whose result `status` reports, e.g. `pnpm test`. */
  command: z.string().nullable(),
  /** Last lines of that command's output. */
  log: z.string(),
});

export type Tests = z.infer<typeof testsSchema>;

export const verifiedSchema = inspectedSchema.extend({ tests: testsSchema });

export const ciSchema = z.object({
  status: z.enum(["passed", "failed", "none", "timed-out", "skipped"]),
  checks: z.array(checkSchema),
});

export type Ci = z.infer<typeof ciSchema>;

export const ciCheckedSchema = verifiedSchema.extend({ ci: ciSchema });

export const ratingSchema = z.object({
  model: z.string(),
  verdict: z.enum(["safe", "review", "unsafe"]),
  /** Probability of each verdict. */
  probabilities: z.object({ safe: z.number(), review: z.number(), unsafe: z.number() }),
  confidence: z.number(),
  /** Probability that the release notes describe a breaking change. */
  breaking: z.number(),
});

export type Rating = z.infer<typeof ratingSchema>;

export const ratedSchema = ciCheckedSchema.extend({ rating: ratingSchema.nullable() });

export const ruleResultSchema = z.object({
  safe: z.boolean(),
  /** Every clause of the rule that failed; empty when `safe`. */
  failures: z.array(z.string()),
});

export type RuleResult = z.infer<typeof ruleResultSchema>;

export const judgedSchema = ratedSchema.extend({ rule: ruleResultSchema });

export const outcomeSchema = z.object({
  status: z.enum(["done", "parked"]),
  reason: z.string().nullable(),
  nextAction: z.string().nullable(),
  commentUrl: z.string().nullable(),
  merged: z.boolean(),
  subject: z.string(),
  rating: ratingSchema.nullable(),
});

export type Outcome = z.infer<typeof outcomeSchema>;

export const ciWaitSchema = z.object({
  /** When the run first saw pending checks; bounds the total wait. */
  since: z.string(),
  /** Earliest time `kitchen tick` should look again. */
  wakeAt: z.string(),
  pending: z.array(z.string()),
});
