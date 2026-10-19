# software-kitchen

See `ARCHITECTURE.md` and `TIMELINE.md`.

## Setup

Node >= 22.13, pnpm 10.

```sh
pnpm install
pnpm dev     # Mastra dev server + Studio at http://localhost:4111
pnpm check   # oxfmt --check, oxlint (with anti-slop), tsc
```

## Layout

| Path                 | What                                                    |
| -------------------- | ------------------------------------------------------- |
| `packages/kitchen`   | Mastra app: `src/mastra/index.ts`, workflows (recipes). |
| `tools/oxlint`       | Vendored anti-slop Oxlint plugin. Ours to edit.         |
| `oxlint.config.ts`   | Lint config; every anti-slop rule at `error`.           |
| `tsconfig.base.json` | Shared compiler options.                                |

## Agent skills

`.agents/skills/` contains the general-purpose skills borrowed from
`strategy-game`: Git workflow, PR writing, test quality, prose cleanup, issue
planning (full and lite), issue triage, and instruction review. Testing and
verification guidance uses this repository's commands and workflow contracts;
game-specific skills and the game-only Playwright DSL are excluded.

## TypeScript 7

`tsc` is TypeScript 7 (no JS compiler API). `.pnpmfile.cjs` gives Mastra's
`typescript-paths` dependency its own TypeScript 6 so the bundler can still read
tsconfig `paths`.
