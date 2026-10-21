import { join } from "node:path";
import { parseArgs } from "node:util";

import { clefFlash } from "./decider.ts";
import { ghGitHub } from "./github/gh.ts";
import { parseRepo } from "./github/pull-request.ts";
import { kitchenHome } from "./home.ts";
import { Kitchen } from "./kitchen.ts";
import { dependabotBump } from "./mastra/index.ts";
import {
  EVAL_HEADER,
  formatCase,
  formatSummary,
  replayBumps,
  type EvalCase,
} from "./recipes/dependabot-bump/eval.ts";
import { KitchenStore, type WorkItem } from "./store.ts";

const USAGE = `Usage: kitchen <command>

  intake <pr-url>                         Store a pull request URL as an Input
  workitem <input-id> [--recipe <name>]   Make a WorkItem; without --recipe, triage and the router choose
  run <work-item-id> [--allow-merge]      Run the WorkItem's recipe; merging also needs the safe rule to pass
  tick                                    Resume waiting WorkItems that are due
  list                                    Show WorkItems
  decisions                               Show recorded model decisions and your reviews
  decisions review <id> <verdict> [--note <text>]
                                          Record your own call on a decision
  eval <owner/repo> [--limit <n>]         Rate the repo's last n Dependabot bumps (default 50)
                                          with today's model and prompt, without running anything`;

const DEFAULT_EVAL_LIMIT = 50;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    recipe: { type: "string" },
    "allow-merge": { type: "boolean", default: false },
    note: { type: "string" },
    limit: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const store = new KitchenStore(join(kitchenHome(), "kitchen.db"));

const kitchen = new Kitchen({
  store,
  github: ghGitHub,
  decider: clefFlash,
  runs: dependabotBump.runs,
  now: () => new Date(),
});

function id(text: string | undefined, what: string): number {
  const value = Number(text);

  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`Expected a ${what} id, got "${text ?? ""}"`);

  return value;
}

function limit(text: string | undefined): number {
  if (text === undefined) return DEFAULT_EVAL_LIMIT;

  const value = Number(text);

  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`Expected --limit to be a positive integer, got "${text}"`);

  return value;
}

function describe(workItem: WorkItem): string {
  const lines = [
    `WorkItem ${workItem.id}  ${workItem.status}  ${workItem.recipe}  ${workItem.scope}  risk=${workItem.risk ?? "-"}`,
  ];

  if (workItem.reason !== null) lines.push(`  reason: ${workItem.reason}`);

  if (workItem.nextAction !== null) lines.push(`  next:   ${workItem.nextAction}`);

  if (workItem.wakeAt !== null) lines.push(`  wakes:  ${workItem.wakeAt}`);

  if (workItem.resultUrl !== null) lines.push(`  result: ${workItem.resultUrl}`);

  return lines.join("\n");
}

async function main(): Promise<void> {
  const [command, ...args] = positionals;

  switch (values.help ? undefined : command) {
    case "intake": {
      const { input, created } = kitchen.intake(args[0] ?? "");

      console.log(`${created ? "Stored" : "Already stored"} Input ${input.id}: ${input.raw}`);
      break;
    }

    case "workitem": {
      const result = await kitchen.createWorkItem(id(args[0], "Input"), values.recipe ?? null);

      if (!result.routed) {
        console.log(`Not routed: ${result.reason}`);
        process.exitCode = 1;
        break;
      }

      console.log(`${result.created ? "Created" : "Existing"} ${describe(result.workItem)}`);
      break;
    }

    case "run":
      console.log(describe(await kitchen.run(id(args[0], "WorkItem"), values["allow-merge"])));
      break;
    case "tick": {
      const settled = await kitchen.tick();

      console.log(settled.length === 0 ? "Nothing due." : settled.map(describe).join("\n"));
      break;
    }

    case "list":
      console.log(store.listWorkItems().map(describe).join("\n") || "No WorkItems.");
      break;
    case "decisions":
      if (args[0] === "review") {
        const verdict = args[2];

        if (verdict !== "safe" && verdict !== "review" && verdict !== "unsafe") {
          throw new Error(
            "Give your verdict as safe, review, or unsafe, e.g. `kitchen decisions review 3 safe`",
          );
        }

        if (!store.reviewDecision(id(args[1], "decision"), verdict, values.note ?? null))
          throw new Error(`No decision ${args[1]}`);

        console.log(`Recorded your call on decision ${args[1]}: ${verdict}`);
        break;
      }

      printDecisions();
      break;
    case "eval": {
      const repo = parseRepo(args[0] ?? "");

      if (repo === null)
        throw new Error("Give a repository as owner/repo, e.g. `kitchen eval octo/app`");

      const count = limit(values.limit);
      const cases: EvalCase[] = [];

      console.log(EVAL_HEADER);

      for await (const evalCase of replayBumps(ghGitHub, clefFlash, repo, count)) {
        cases.push(evalCase);
        console.log(formatCase(evalCase));
      }

      console.log(
        cases.length === 0
          ? `No single-package Dependabot bumps in ${repo.owner}/${repo.repo}.`
          : `\n${formatSummary(cases)}`,
      );
      break;
    }

    default:
      console.log(USAGE);
      process.exitCode = command === undefined || values.help ? 0 : 1;
  }
}

function printDecisions(): void {
  const decisions = store.listDecisions();

  const reviewed = decisions.filter(
    (decision) => decision.kind === "bump-rating" && decision.ownerVerdict !== null,
  );

  const agreed = reviewed.filter((decision) => decision.ownerVerdict === decision.verdict);

  for (const decision of decisions) {
    const owner = decision.ownerVerdict === null ? "unreviewed" : `you: ${decision.ownerVerdict}`;
    const note = decision.ownerNote === null ? "" : ` (${decision.ownerNote})`;

    console.log(
      `${decision.id}  ${decision.kind}  ${decision.verdict} @ ${decision.confidence.toFixed(2)}  ${owner}${note}  ${decision.subject}`,
    );
  }

  console.log(`\nBump ratings reviewed: ${reviewed.length}; you agreed with ${agreed.length}.`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  store.close();
}
