---
name: "source-command-ticket-task-lite"
description: "Investigate a simple GitHub issue inline and propose a scoped fix"
---

# source-command-ticket-task-lite

Use this skill when the user asks to run the migrated source command `ticket-task-lite`.

## Command Template

With the supplied issue and optional `@path`: fetch details, inspect the path
first, search related issues, research only relevant files directly, then report
the problem, code evidence, proposed fix, and focused verification.

Do not mutate issues or use subagents. If scope crosses systems, needs an
architectural decision, or remains ambiguous, recommend ticket-task and stop.
