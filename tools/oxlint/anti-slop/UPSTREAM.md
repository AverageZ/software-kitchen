# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7` (package version 0.1.2)
- Copied from: `skills/install-anti-slop/assets/anti-slop/` via `skills/install-anti-slop/scripts/install.mjs`. Identical to `src/` at that commit, minus `*.test.ts`.
- Installed paths: `tools/oxlint/anti-slop/index.ts` (generic plugin), `tools/oxlint/anti-slop/effect/index.ts` (Effect plugin).
- Peer packages: `oxlint` and `@oxlint/plugins` pinned together at `1.88.0` (upstream tested `1.78.0`).

## Deviations

- Effect plugin enabled although the repo has no direct `effect` dependency: requested ("all turned on").
- No source changes.
