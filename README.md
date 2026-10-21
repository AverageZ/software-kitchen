# software-kitchen

See `ARCHITECTURE.md` and `TIMELINE.md`.

## Setup

Node >= 22.13, pnpm 10, an authenticated `gh` CLI, and [Ollama](https://ollama.com) with the
`clef-flash:9b` decision model (`ollama pull clef-flash:9b`).

```sh
pnpm install
pnpm dev     # Mastra dev server + Studio at http://localhost:4111
pnpm check   # oxfmt --check, oxlint (with anti-slop), tsc
pnpm test    # node --test: unit tests plus recipe runs against a local fixture repo
```

## Running the kitchen

```sh
pnpm -s kitchen intake https://github.com/OWNER/REPO/pull/N   # store the Input (repeat-safe)
pnpm -s kitchen workitem 1                     # triage + router pick the recipe
pnpm -s kitchen workitem 1 --recipe dependabot-bump            # or choose it yourself
pnpm -s kitchen run 1                          # run the recipe; comments on the PR
pnpm -s kitchen tick                           # resume runs waiting on CI; run from cron
pnpm -s kitchen list                           # WorkItems with status, reason, next action
pnpm -s kitchen decisions                      # model calls, for comparing with yours
pnpm -s kitchen decisions review 2 safe --note "agree"
pnpm -s kitchen eval OWNER/REPO --limit 50     # replay past Dependabot bumps through the model
```

`kitchen run --allow-merge` lets the run merge, but only when the draft safe rule in
`ARCHITECTURE.md` passes. Without the flag the recipe never merges.

`kitchen eval` re-rates a repository's past single-package Dependabot bumps with the current prompt
and model, as if tests and CI passed, and counts how many pass the rule's model clauses at several
`safe` thresholds, split by merged, closed, and open. It changes nothing on GitHub and stores nothing;
run it before and after editing `rate.ts` or the thresholds in `safe-rule.ts`.

State lives in `~/.software-kitchen` (override with `KITCHEN_HOME`): `kitchen.db` holds Inputs,
WorkItems, and decisions; `mastra.db` holds runs, shared with Studio; `work/` holds per-run checkouts,
which are deleted after each run. The PR's install and tests get only `PATH`, `HOME`, `TMPDIR`, and
`LANG` from the kitchen's environment, so its tokens are not passed to them.

## Layout

| Path                                     | What                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| `packages/kitchen/src/cli.ts`            | `kitchen` CLI.                                                |
| `packages/kitchen/src/kitchen.ts`        | Intake, WorkItems, run bookkeeping (done / waiting / parked). |
| `packages/kitchen/src/routing.ts`        | Recipe registry, triage questions, router rules.              |
| `packages/kitchen/src/mastra/`           | Mastra app: `index.ts`, workflows (recipes).                  |
| `packages/kitchen/src/recipes/<recipe>/` | Recipe logic: parsing, decision questions, rules, comment.    |
| `packages/kitchen/src/decider.ts`        | Ollama System One client for decision stages.                 |
| `packages/kitchen/src/github/`           | Everything the kitchen does to GitHub, via `gh`.              |
| `tools/oxlint`                           | Vendored anti-slop Oxlint plugin. Ours to edit.               |
| `oxlint.config.ts`                       | Lint config; every anti-slop rule at `error`.                 |
| `tsconfig.base.json`                     | Shared compiler options.                                      |

## TypeScript 7

`tsc` is TypeScript 7 (no JS compiler API). `.pnpmfile.cjs` gives Mastra's
`typescript-paths` dependency its own TypeScript 6 so the bundler can still read
tsconfig `paths`.
