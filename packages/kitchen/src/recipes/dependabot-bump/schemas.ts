import { z } from "zod";

import { prRefSchema, prUrlSchema, pullRequestSchema } from "../../forge/forge.ts";
import { assessmentInputSchema, safetyAssessmentSchema } from "../../safety/assessment.ts";
import { evidenceBundleSchema, testsSchema } from "../../safety/evidence.ts";
import { policySchema } from "../../safety/policy.ts";

import { bumpSchema } from "./bump.ts";

const items = evidenceBundleSchema.shape;

export const recipeInputSchema = z.object({ url: prUrlSchema });

export const inspectedSchema = recipeInputSchema.extend({
  pr: prRefSchema,
  pullRequest: pullRequestSchema,
  bump: bumpSchema,
  /** The repository's resolved safety policy, fixed for the whole run. */
  policy: policySchema,
});

/** Evidence gathered without running any of the PR's code. */
export const collectedSchema = inspectedSchema.extend({
  evidence: z.strictObject({
    pullRequest: items.pullRequest,
    changes: items.changes,
    registry: items.registry,
    advisories: items.advisories,
    repoPolicy: items.repoPolicy,
    releaseNotes: items.releaseNotes,
  }),
});

export const verifiedSchema = collectedSchema.extend({
  /** Null when the policy turns local tests off. */
  tests: testsSchema.nullable(),
  localTests: items.localTests,
  artifacts: items.artifacts,
});

export const ciCheckedSchema = verifiedSchema.extend({ checks: items.checks });

/** The model call as recorded for the owner to review in `kitchen decisions`. */
export const modelCallSchema = z.object({
  model: z.string(),
  verdict: z.string(),
  confidence: z.number(),
  answers: z.string(),
});

export type ModelCallRecord = z.infer<typeof modelCallSchema>;

export const analyzedSchema = ciCheckedSchema.extend({
  analysis: items.analysis,
  modelCall: modelCallSchema.nullable(),
});

export const assessedSchema = analyzedSchema.extend({
  input: assessmentInputSchema,
  assessment: safetyAssessmentSchema,
});

export const outcomeSchema = z.object({
  /** `deferred`: a temporary condition; the kitchen runs the recipe again at `retryAt`. */
  status: z.enum(["done", "parked", "deferred"]),
  reason: z.string().nullable(),
  nextAction: z.string().nullable(),
  retryAt: z.string().nullable(),
  commentUrl: z.string().nullable(),
  subject: z.string(),
  /** Null when the run stopped before assessing (not a single-package bump). */
  input: assessmentInputSchema.nullable(),
  assessment: safetyAssessmentSchema.nullable(),
  modelCall: modelCallSchema.nullable(),
});

export type Outcome = z.infer<typeof outcomeSchema>;

export const ciWaitSchema = z.object({
  /** When the run first saw pending checks; bounds the total wait. */
  since: z.string(),
  /** Earliest time `kitchen tick` should look again. */
  wakeAt: z.string(),
  pending: z.array(z.string()),
});
