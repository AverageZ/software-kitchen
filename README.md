# software-kitchen

See `ARCHITECTURE.md` and `TIMELINE.md`.

## Setup

Node >= 22.13, pnpm 10, the [`gh`](https://cli.github.com) CLI, and [Ollama](https://ollama.com) with the
`clef-flash:9b` decision model (`ollama pull clef-flash:9b`). For GitLab, also the
[`glab`](https://gitlab.com/gitlab-org/cli) CLI.

```sh
pnpm install
pnpm dev     # Mastra dev server + Studio at http://localhost:4111
pnpm check   # oxfmt --check, oxlint (with anti-slop), tsc
pnpm test    # node --test: unit tests plus recipe runs against a local fixture repo
```

## Hosts and bots

The kitchen works out the host from the PR URL, so there is no host list to keep up to date. It
uses `gh` and `glab` with whatever login you already have for that host:

| Host                     | URL it accepts                                    | Sign in once with                 |
| ------------------------ | ------------------------------------------------- | --------------------------------- |
| github.com               | `https://github.com/OWNER/REPO/pull/N`            | `gh auth login`                   |
| GitHub Enterprise        | `https://HOST/OWNER/REPO/pull/N`                  | `gh auth login --hostname HOST`   |
| GitLab.com, self-managed | `https://HOST/GROUP/…/PROJECT/-/merge_requests/N` | `glab auth login --hostname HOST` |

Dependabot (`dependabot[bot]`) and Renovate's GitHub app (`renovate[bot]`) are trusted on every
GitHub host already. A bot that runs as an ordinary account, which is usual for Renovate on GitLab
and for self-hosted Renovate, goes in `config.json` in the kitchen home, under the host it belongs to:

```json
{ "bots": { "gitlab.acme.dev": ["renovate-bot"], "github.acme.dev": ["acme-renovate[bot]"] } }
```

A login listed there is trusted only on that host. Without the file, only the built-in bots are trusted.

## Running the kitchen

```sh
pnpm -s kitchen intake https://github.com/OWNER/REPO/pull/N   # or a GHES PR / GitLab MR URL
pnpm -s kitchen workitem 1                     # triage + router pick the recipe
pnpm -s kitchen workitem 1 --recipe dependabot-bump            # or choose it yourself
pnpm -s kitchen run 1                          # collect evidence, assess, comment on the PR
pnpm -s kitchen tick                           # resume CI waits, rerun deferred items; run from cron
pnpm -s kitchen merge                          # act on AUTO_MERGE assessments (autonomous repos only)
pnpm -s kitchen list                           # WorkItems with status, reason, next action
pnpm -s kitchen assessments                    # recent assessments and what merge did with them
pnpm -s kitchen assessment 3                   # one assessment as JSON
pnpm -s kitchen decisions                      # model calls, for comparing with yours
pnpm -s kitchen decisions review 2 release.no-relevant-change --note "agree"
pnpm -s kitchen eval OWNER/REPO --limit 50 --regression 812   # replay past bot PRs in observation mode
pnpm -s kitchen eval https://gitlab.acme.dev/GROUP/PROJECT --forge gitlab
```

`kitchen run` ends with a safety assessment (see `ARCHITECTURE.md`): a decision of AUTO_MERGE,
INVESTIGATE, HUMAN_REVIEW, DEFER, BLOCK, or INSUFFICIENT_EVIDENCE, with every gate, finding,
deduction, and evidence item in the PR comment and in `kitchen assessment <id>`. AUTO_MERGE leaves
the WorkItem done, DEFER makes it wait and rerun when the condition should clear, and everything
else parks it with a reason and next action.

## Safety policy

Every repository starts from a conservative policy in `packages/kitchen/src/safety/policy.ts`:
observation mode, `renovate[bot]` on GitHub, npm/pnpm, a single stable patch of a devDependency,
72 hours of release age, grade A (95+) for AUTO_MERGE. Override it in `config.json`, for every
repository under `safety.default` and per repository under `safety.repos`:

```json
{
  "safety": {
    "default": { "safety": { "minimumReleaseAgeHours": 96 } },
    "repos": {
      "github.com/octo/app": {
        "safety": { "requiredChecks": ["test"] },
        "mode": "autonomous",
        "automation": { "approve": true, "merge": true }
      }
    }
  },
  "githubApps": {
    "github.com": { "appId": 123456, "privateKeyPath": "/Users/me/.keys/kitchen-merge.pem" }
  }
}
```

Objects merge field by field, arrays replace, and a misspelled field fails at load. The CI gate
needs to know which checks matter: the base branch's required checks plus `safety.requiredChecks`.
A repository with neither gets INSUFFICIENT_EVIDENCE, never a pass. Each assessment records a
policy version (`<rubricVersion>+<digest of every value>`), so a changed threshold is visible.

Nothing is approved or merged unless the repository's policy says `mode: "autonomous"` and
`automation.merge: true`, the assessment is AUTO_MERGE, and `kitchen merge` revalidates it.
`kitchen merge` acts as a GitHub App you create for it, installed on the repository with
Contents and Pull requests (write) and Checks and Commit statuses (read); its token is scoped to
one repository per merge. Keep the App out of every ruleset and protection bypass list: the kitchen
relies on the host to enforce them. If the base branch requires a review, `automation.approve`
lets the App approve (it can't approve its own PR); a merge queue is reported, not used.

With `githubApps` set, every policy must set `verification.localTests` to `false`: PR code never
runs on a host that holds merge credentials, and CI does the testing.

## Replaying history

`kitchen eval` assesses a repository's past Dependabot and Renovate PRs with today's policy and
model in observation mode, stores each assessment (`source = eval`), and summarizes: share eligible,
share grade A, would-merge count (reviews avoided), blocked, escalated with reasons, incomplete
evidence, and named regressions (`--regression <n>`) that would have merged. Live state can't be
replayed, so each PR is assessed as open and mergeable at its final head; release age is judged at
merge time; advisories are today's, so releases found bad later show up. It runs no PR code and
changes nothing on the host. Use it to tune the policy; the kitchen never changes its own policy.

State lives in `~/.software-kitchen` (override with `KITCHEN_HOME`):

- `config.json` holds your settings (optional).
- `kitchen.db` holds Inputs, WorkItems, model decisions, and assessments with their evidence.
- `mastra.db` holds runs and is shared with Studio.
- `work/` holds per-run checkouts, which are deleted after each run.

The PR's install and tests get only `PATH`, `TMPDIR`, and `LANG` from the kitchen's environment
and a fresh empty `HOME`, so its tokens and your `~/.npmrc` and `gh` login are out of reach.

## Layout

| Path                                     | What                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/kitchen/src/cli.ts`            | `kitchen` CLI.                                                                 |
| `packages/kitchen/src/kitchen.ts`        | Intake, WorkItems, run bookkeeping (done / waiting / parked / deferred).       |
| `packages/kitchen/src/routing.ts`        | Recipe registry, triage questions, router rules.                               |
| `packages/kitchen/src/mastra/`           | Mastra app: `index.ts`, workflows (recipes).                                   |
| `packages/kitchen/src/recipes/<recipe>/` | Recipe logic: parsing, local verification, comment.                            |
| `packages/kitchen/src/safety/`           | Policy, evidence and assessment contracts, the evaluator, collectors, replay.  |
| `packages/kitchen/src/merge/`            | `kitchen merge`: GitHub App client, live revalidation, merge authorization.    |
| `packages/kitchen/src/decider.ts`        | Ollama System One client for decision stages.                                  |
| `packages/kitchen/src/forge/`            | What the kitchen reads from and posts to a host via `gh` / `glab`; no merging. |
| `packages/kitchen/src/config.ts`         | `config.json`: trusted bots, safety policy overrides, merge apps.              |
| `tools/oxlint`                           | Vendored anti-slop Oxlint plugin. Ours to edit.                                |
| `oxlint.config.ts`                       | Lint config; every anti-slop rule at `error`.                                  |
| `tsconfig.base.json`                     | Shared compiler options.                                                       |

## TypeScript 7

`tsc` is TypeScript 7 (no JS compiler API). `.pnpmfile.cjs` gives Mastra's
`typescript-paths` dependency its own TypeScript 6 so the bundler can still read
tsconfig `paths`.
