import { isDeepStrictEqual } from "node:util";

import { parsePrUrl, type RepoRef } from "../forge/forge.ts";
import { assess } from "../safety/assess.ts";
import type { Policy } from "../safety/policy.ts";
import type { ExecutionStatus, KitchenStore, StoredAssessment } from "../store.ts";

import { authorizeMerge } from "./authorize.ts";
import {
  HeadMovedError,
  MergePermissionError,
  MergeRefusedError,
  type MergeClient,
} from "./github-app.ts";

export interface MergeDeps {
  store: KitchenStore;
  /** The repository's policy as configured now, which must still match the assessment's. */
  policy: (repo: RepoRef) => Policy;
  /** The merge app's client for a host; null when `config.json` has no app for it. */
  client: (host: string) => Promise<MergeClient | null>;
}

export interface MergeAttempt {
  assessmentId: number;
  scope: string;
  status: ExecutionStatus;
  detail: string;
}

interface Execution {
  status: ExecutionStatus;
  detail: string;
}

/**
 * Acts on every unexecuted AUTO_MERGE assessment from a recipe run. This is the only code that
 * approves or merges, and it runs no PR code: it reads assessments the kitchen recorded, never
 * instructions from the PR, and records what it did to each.
 */
export async function executeMerges(deps: MergeDeps): Promise<MergeAttempt[]> {
  const attempts: MergeAttempt[] = [];

  for (const record of deps.store.listMergeCandidates()) {
    const execution = await execute(record, deps);

    deps.store.recordExecution(record.id, execution.status, execution.detail);
    attempts.push({ assessmentId: record.id, scope: record.scope, ...execution });
  }

  return attempts;
}

async function execute(record: StoredAssessment, deps: MergeDeps): Promise<Execution> {
  const { assessment, input } = record;

  // The stored decision is trusted only if the evaluator reaches it again from the stored evidence.
  if (!isDeepStrictEqual(assess(input), assessment)) {
    return {
      status: "refused",
      detail: "the stored assessment does not reproduce from its evidence and policy",
    };
  }

  const ref = parsePrUrl(assessment.pullRequestUrl);

  if (ref === null || ref.forge !== "github") {
    return {
      status: "refused",
      detail: "only GitHub pull requests can be merged by the merge app",
    };
  }

  const client = await deps.client(ref.host);

  if (client === null) {
    return {
      status: "refused",
      detail: `no githubApps entry for ${ref.host} in config.json; the evaluator's own login never merges`,
    };
  }

  try {
    const approver = await client.identity(ref);
    const live = await client.livePullRequest(ref);
    const repoPolicy = input.evidence.repoPolicy;

    const authorization = authorizeMerge({
      assessment,
      policy: deps.policy(ref),
      live,
      approver,
      requiredChecks: repoPolicy.status === "ok" ? repoPolicy.data.requiredChecks : [],
    });

    if (!authorization.authorized)
      return { status: "refused", detail: authorization.reasons.join("; ") };

    const summary = auditSummary(record);

    if (authorization.approve) await client.approve(ref, assessment.headSha, summary);

    await client.merge(ref, {
      sha: assessment.headSha,
      method: input.policy.automation.mergeMethod,
      title: `${input.evidence.pullRequest.data.title} (#${ref.number})`,
      message: summary,
    });

    return {
      status: "merged",
      detail: `merged ${assessment.headSha.slice(0, 7)} as ${approver}${authorization.approve ? " after approving" : ""}`,
    };
  } catch (error) {
    if (error instanceof HeadMovedError) {
      return {
        status: "refused",
        detail: `PR head changed after evaluation (${error.message}); rerun the WorkItem to assess the new head`,
      };
    }

    if (error instanceof MergePermissionError || error instanceof MergeRefusedError)
      return { status: "refused", detail: error.message };

    return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** What the review and merge commit say, so the host's own history explains the merge. */
function auditSummary(record: StoredAssessment): string {
  const { assessment } = record;

  return [
    `Software Kitchen assessment #${record.id}: ${assessment.decision}, grade ${assessment.grade ?? "-"} (${assessment.score ?? "-"}/100).`,
    `Policy ${assessment.policyVersion}, evaluated ${assessment.evaluatedAt} on ${assessment.headSha}.`,
    ...assessment.explanation.map((line) => `- ${line}`),
  ].join("\n");
}
