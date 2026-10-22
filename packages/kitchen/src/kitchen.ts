import { randomUUID } from "node:crypto";

import type { Decider } from "./decider.ts";
import { parsePrUrl, prSlug, prUrl, repoSlug, type Forge, type PrRef } from "./forge/forge.ts";
import type { RecipeRunResult, RecipeRuns } from "./mastra/workflows/dependabot-bump.ts";
import { isRecipeName, route, triage } from "./routing.ts";
import type { AddedInput, AddedWorkItem, Input, KitchenStore, WorkItem } from "./store.ts";

export interface KitchenDeps {
  store: KitchenStore;
  forge: Forge;
  decider: Decider;
  /** Runs of the `dependabot-bump` recipe, the only recipe so far. */
  runs: RecipeRuns;
  now: () => Date;
}

export type WorkItemResult = ({ routed: true } & AddedWorkItem) | { routed: false; reason: string };

interface PrInput {
  input: Input;
  ref: PrRef;
}

const INSPECT_RUN =
  "Inspect the run in Mastra Studio (`pnpm dev`), then rerun it with `kitchen run`";

/** Consecutive DEFER assessments after which a WorkItem parks instead of deferring again. */
export const MAX_DEFERRALS = 5;

/** Intake, WorkItems, and run bookkeeping. Recipes do the work; this records where each item stands. */
export class Kitchen {
  readonly #deps: KitchenDeps;

  constructor(deps: KitchenDeps) {
    this.#deps = deps;
  }

  /** Stores a PR URL verbatim as an Input. Submitting the same PR again returns the stored Input. */
  intake(raw: string): AddedInput {
    const ref = parsePrUrl(raw);

    if (ref === null) {
      throw new Error(
        `Not a pull request URL (…/OWNER/REPO/pull/N or …/GROUP/PROJECT/-/merge_requests/N): ${raw}`,
      );
    }

    return this.#deps.store.addInput({
      source: "cli",
      kind: "pull-request",
      raw,
      key: `pull-request:${prSlug(ref)}`,
    });
  }

  /**
   * Turns an Input into a WorkItem. With `recipe`, the owner chose; without it, triage proposes a
   * recipe and the router's rules accept or reject the proposal.
   */
  async createWorkItem(inputId: number, recipe: string | null): Promise<WorkItemResult> {
    const { store, forge, decider } = this.#deps;
    const { input, ref } = this.#input(inputId);
    const scope = { inputId, repo: repoSlug(ref), scope: prSlug(ref) };

    if (recipe !== null) {
      if (!isRecipeName(recipe)) throw new Error(`Unknown recipe "${recipe}"`);

      return { routed: true, ...store.addWorkItem({ ...scope, recipe, risk: null }) };
    }

    const pr = await forge.getPullRequest(ref);
    const proposal = await triage(decider, ref, pr);

    store.addDecision({
      kind: "triage",
      inputId: input.id,
      runId: null,
      model: decider.model,
      subject: `${prSlug(ref)} ${pr.title}`,
      verdict: proposal.recipe,
      confidence: proposal.confidence,
      answers: JSON.stringify(proposal),
    });

    const decision = route(proposal, pr);

    if (decision.recipe === null) return { routed: false, reason: decision.reason };

    return {
      routed: true,
      ...store.addWorkItem({ ...scope, recipe: decision.recipe, risk: decision.risk }),
    };
  }

  /** Starts a new run of the WorkItem's recipe and records how it ended: done, waiting, or parked. */
  async run(workItemId: number): Promise<WorkItem> {
    const { store } = this.#deps;
    const workItem = store.getWorkItem(workItemId);

    if (workItem === null) throw new Error(`No WorkItem ${workItemId}`);

    if (workItem.status === "running" || workItem.status === "waiting") {
      throw new Error(
        `WorkItem ${workItemId} is already ${workItem.status} (run ${workItem.runId ?? "?"})`,
      );
    }

    return this.#start(workItem);
  }

  /**
   * Wakes every waiting WorkItem whose time has come: resumes runs waiting on CI and starts fresh
   * runs for deferred ones. Run it from cron or by hand.
   */
  async tick(): Promise<WorkItem[]> {
    const { store, runs } = this.#deps;
    const settled: WorkItem[] = [];

    for (const workItem of store.listDue(this.#deps.now())) {
      const { runId } = workItem;

      if (workItem.wakeAction === "rerun" || runId === null) {
        settled.push(await this.#start(workItem));
        continue;
      }

      store.markRunning(workItem.id, runId);
      settled.push(await this.#settle(workItem, runId, () => runs.resume(runId)));
    }

    return settled;
  }

  async #start(workItem: WorkItem): Promise<WorkItem> {
    const { ref } = this.#input(workItem.inputId);
    const runId = randomUUID();

    this.#deps.store.markRunning(workItem.id, runId);

    return this.#settle(workItem, runId, () => this.#deps.runs.start(runId, { url: prUrl(ref) }));
  }

  async #settle(
    workItem: WorkItem,
    runId: string,
    execute: () => Promise<RecipeRunResult>,
  ): Promise<WorkItem> {
    const { store } = this.#deps;
    let result: RecipeRunResult;

    try {
      result = await execute();
    } catch (cause) {
      // A throw here means the run never reached a recorded end state; park rather than leave it "running".
      result = { status: "failed", error: cause instanceof Error ? cause.message : String(cause) };
    }

    switch (result.status) {
      case "finished": {
        const { outcome } = result;

        if (outcome.modelCall !== null) {
          store.addDecision({
            kind: "release-notes",
            inputId: workItem.inputId,
            runId,
            model: outcome.modelCall.model,
            subject: `${workItem.scope} ${outcome.subject}`,
            verdict: outcome.modelCall.verdict,
            confidence: outcome.modelCall.confidence,
            answers: outcome.modelCall.answers,
          });
        }

        if (outcome.input !== null && outcome.assessment !== null) {
          store.addAssessment({
            workItemId: workItem.id,
            runId,
            source: "run",
            repo: workItem.repo,
            scope: workItem.scope,
            input: outcome.input,
            assessment: outcome.assessment,
          });
        }

        switch (outcome.status) {
          case "done":
            store.markDone(workItem.id, outcome.commentUrl);
            break;
          case "deferred": {
            const reason = `deferred: ${outcome.reason ?? "a temporary condition"}`;
            const deferrals = store.recentDecisions(workItem.id, MAX_DEFERRALS);

            if (deferrals.length === MAX_DEFERRALS && deferrals.every((d) => d === "DEFER")) {
              store.markParked(
                workItem.id,
                `${reason} (${MAX_DEFERRALS} times in a row)`,
                "Check why the condition never clears, then rerun with `kitchen run`",
                outcome.commentUrl,
              );
              break;
            }

            store.markWaiting(
              workItem.id,
              outcome.retryAt ?? this.#deps.now().toISOString(),
              "rerun",
              reason,
            );
            break;
          }

          case "parked":
            store.markParked(
              workItem.id,
              outcome.reason ?? "parked",
              outcome.nextAction ?? INSPECT_RUN,
              outcome.commentUrl,
            );
            break;
        }

        break;
      }

      case "waiting":
        store.markWaiting(
          workItem.id,
          result.wakeAt,
          "resume",
          `waiting for CI: ${result.pending.join(", ")}`,
        );
        break;
      case "failed":
        store.markParked(workItem.id, `run failed: ${result.error}`, INSPECT_RUN, null);
        break;
    }

    const settled = store.getWorkItem(workItem.id);

    if (settled === null) throw new Error(`WorkItem ${workItem.id} disappeared`);

    return settled;
  }

  #input(inputId: number): PrInput {
    const input = this.#deps.store.getInput(inputId);

    if (input === null) throw new Error(`No Input ${inputId}`);

    const ref = parsePrUrl(input.raw);

    if (ref === null) throw new Error(`Input ${inputId} is not a pull request URL`);

    return { input, ref };
  }
}
