import { join } from "node:path";
import { parseArgs } from "node:util";

import { policyFor } from "./config.ts";
import { clefFlash } from "./decider.ts";
import { forgeKindSchema, parseRepo, prSlug, repoSlug, type ForgeKind } from "./forge/forge.ts";
import { kitchenHome } from "./home.ts";
import { Kitchen } from "./kitchen.ts";
import { config, dependabotBump, evidenceSources, forge } from "./mastra/index.ts";
import { executeMerges } from "./merge/execute.ts";
import { createGitHubAppClient, loadAppCredentials } from "./merge/github-app.ts";
import { RELEASE_QUESTIONS } from "./safety/analysis.ts";
import {
  formatReplayCase,
  formatReplaySummary,
  replayHistory,
  REPLAY_HEADER,
  type ReplayCase,
} from "./safety/history.ts";
import { KitchenStore, type StoredAssessment, type WorkItem } from "./store.ts";

const USAGE = `Usage: kitchen <command>

  intake <pr-url>                         Store a GitHub, GitHub Enterprise, or GitLab PR/MR URL as an Input
  workitem <input-id> [--recipe <name>]   Make a WorkItem; without --recipe, triage and the router choose
  run <work-item-id>                      Run the WorkItem's recipe: collect evidence, assess, comment.
                                          Never approves or merges
  tick                                    Resume WorkItems waiting on CI and rerun deferred ones that are due
  merge                                   Approve and merge AUTO_MERGE assessments as the GitHub App in
                                          config.json, after revalidating each PR. Only for repos whose
                                          policy is mode "autonomous" with automation.merge on
  list                                    Show WorkItems
  assessments [--limit <n>]               Show recent safety assessments and what merge did with them
  assessment <id>                         Print one assessment as JSON
  decisions                               Show recorded model decisions and your reviews
  decisions review <id> <verdict> [--note <text>]
                                          Record your own call on a decision
  eval <repo> [--limit <n>] [--forge github|gitlab] [--regression <pr-number>]...
                                          Assess the repo's last n dependency-bot PRs (default 50) in
                                          observation mode and summarize what the kitchen would have done.
                                          --regression marks a PR you know caused a problem.
                                          <repo> is owner/repo on github.com or a repository URL;
                                          self-hosted URLs also need --forge`;

const DEFAULT_LIMIT = 50;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    recipe: { type: "string" },
    note: { type: "string" },
    limit: { type: "string" },
    forge: { type: "string" },
    regression: { type: "string", multiple: true },
    help: { type: "boolean", short: "h", default: false },
  },
});

const store = new KitchenStore(join(kitchenHome(), "kitchen.db"));

const kitchen = new Kitchen({
  store,
  forge,
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

function positive(text: string | undefined, flag: string): number {
  if (text === undefined) return DEFAULT_LIMIT;

  const value = Number(text);

  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`Expected ${flag} to be a positive integer, got "${text}"`);

  return value;
}

function forgeFlag(text: string | undefined): ForgeKind | null {
  if (text === undefined) return null;

  const parsed = forgeKindSchema.safeParse(text);

  if (!parsed.success) throw new Error(`Expected --forge github or --forge gitlab, got "${text}"`);

  return parsed.data;
}

function describe(workItem: WorkItem): string {
  const lines = [
    `WorkItem ${workItem.id}  ${workItem.status}  ${workItem.recipe}  ${workItem.scope}  risk=${workItem.risk ?? "-"}`,
  ];

  if (workItem.reason !== null) lines.push(`  reason: ${workItem.reason}`);

  if (workItem.nextAction !== null) lines.push(`  next:   ${workItem.nextAction}`);

  if (workItem.wakeAt !== null)
    lines.push(`  wakes:  ${workItem.wakeAt} (${workItem.wakeAction ?? "resume"})`);

  if (workItem.resultUrl !== null) lines.push(`  result: ${workItem.resultUrl}`);

  return lines.join("\n");
}

function describeAssessment(record: StoredAssessment): string {
  const { assessment, execution } = record;
  const grade = assessment.grade === null ? "-" : `${assessment.grade} ${assessment.score ?? ""}`;
  const acted = execution === null ? "" : `  merge: ${execution.status} (${execution.detail})`;

  return `${record.id}  ${record.scope}  ${assessment.headSha.slice(0, 7)}  ${assessment.decision}  ${grade}  ${assessment.authorization.mode}${acted}`;
}

/** Verdicts the owner can give a recorded decision: the options the model chose between. */
function verdictsFor(kind: string): readonly string[] {
  return kind === "release-notes"
    ? Object.keys(RELEASE_QUESTIONS.releaseBehavior.criteria)
    : ["safe", "review", "unsafe"];
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
      console.log(describe(await kitchen.run(id(args[0], "WorkItem"))));
      break;
    case "tick": {
      const settled = await kitchen.tick();

      console.log(settled.length === 0 ? "Nothing due." : settled.map(describe).join("\n"));
      break;
    }

    case "merge": {
      const attempts = await executeMerges({
        store,
        policy: (repo) => policyFor(config, repo),
        client: async (host) => {
          const app = config.githubApps.get(host);

          if (app === undefined) return null;

          return createGitHubAppClient(
            host,
            await loadAppCredentials(app.appId, app.privateKeyPath),
          );
        },
      });

      console.log(
        attempts.length === 0
          ? "No AUTO_MERGE assessments waiting."
          : attempts
              .map((a) => `${a.assessmentId}  ${a.scope}  ${a.status}: ${a.detail}`)
              .join("\n"),
      );
      break;
    }

    case "list":
      console.log(store.listWorkItems().map(describe).join("\n") || "No WorkItems.");
      break;
    case "assessments":
      console.log(
        store
          .listAssessments("run", positive(values.limit, "--limit"))
          .map(describeAssessment)
          .join("\n") || "No assessments.",
      );
      break;
    case "assessment": {
      const record = store.getAssessment(id(args[0], "assessment"));

      if (record === null) throw new Error(`No assessment ${args[0] ?? ""}`);

      console.log(JSON.stringify(record.assessment, null, 2));
      break;
    }

    case "decisions":
      if (args[0] === "review") {
        const decision = store.getDecision(id(args[1], "decision"));
        const verdict = args[2] ?? "";

        if (decision === null) throw new Error(`No decision ${args[1] ?? ""}`);

        const allowed = verdictsFor(decision.kind);

        if (!allowed.includes(verdict))
          throw new Error(`Give your verdict as one of: ${allowed.join(", ")}`);

        store.reviewDecision(decision.id, verdict, values.note ?? null);
        console.log(`Recorded your call on decision ${decision.id}: ${verdict}`);
        break;
      }

      printDecisions();
      break;
    case "eval": {
      const repo = parseRepo(args[0] ?? "", forgeFlag(values.forge));
      const regressions = new Set((values.regression ?? []).map((text) => id(text, "PR")));
      const cases: ReplayCase[] = [];

      console.log(REPLAY_HEADER);

      const replay = replayHistory(
        {
          forge,
          decider: clefFlash,
          policy: (ref) => policyFor(config, ref),
          ...evidenceSources,
          workRoot: join(kitchenHome(), "work"),
          now: () => new Date(),
        },
        repo,
        positive(values.limit, "--limit"),
        regressions,
      );

      for await (const replayCase of replay) {
        cases.push(replayCase);
        console.log(formatReplayCase(replayCase));

        if (replayCase.ok) {
          store.addAssessment({
            workItemId: null,
            runId: null,
            source: "eval",
            repo: repoSlug(repo),
            scope: prSlug({ ...repo, number: replayCase.number }),
            input: replayCase.input,
            assessment: replayCase.assessment,
          });
        }
      }

      console.log(
        cases.length === 0
          ? `No dependency-bot PRs in ${repoSlug(repo)}.`
          : `\n${formatReplaySummary(cases)}`,
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
    (decision) => decision.kind === "release-notes" && decision.ownerVerdict !== null,
  );

  const agreed = reviewed.filter((decision) => decision.ownerVerdict === decision.verdict);

  for (const decision of decisions) {
    const owner = decision.ownerVerdict === null ? "unreviewed" : `you: ${decision.ownerVerdict}`;
    const note = decision.ownerNote === null ? "" : ` (${decision.ownerNote})`;

    console.log(
      `${decision.id}  ${decision.kind}  ${decision.verdict}  ${owner}${note}  ${decision.subject}`,
    );
  }

  console.log(
    `\nRelease-note readings reviewed: ${reviewed.length}; you agreed with ${agreed.length}.`,
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  store.close();
}
