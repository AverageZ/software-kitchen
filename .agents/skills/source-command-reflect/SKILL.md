---
name: "source-command-reflect"
description: "Audit project instructions without duplicate repository facts"
---

# source-command-reflect

Use this skill when the user asks to run the migrated source command `reflect`.

## Command Template

Audit the supplied project instructions, canonical `.agents/` sources, and
existing harness settings against the conversation and repository. Find
contradictions, stale or duplicate prose, and missing mechanical enforcement.
Prefer deletion; retain only non-inferable invariants, safety constraints, and
behavior-changing task knowledge.

Move enforceable rules to existing tooling where appropriate. Present evidence,
the smallest change, and tradeoffs; wait for approval unless the user already
authorized those edits. Then edit canonical sources, verify local skill
references, run `pnpm check` if tooling changed, and report instruction-size
change plus any necessary prose-only policy. This repository has no
`agent-config:sync` script; do not assume generated harness copies exist.
