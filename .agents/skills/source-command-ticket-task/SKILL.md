---
name: "source-command-ticket-task"
description: "Investigate an open GitHub issue and propose a scoped implementation plan"
---

# source-command-ticket-task

Use this skill when the user asks to run the migrated source command `ticket-task`.

## Command Template

With the supplied issue and optional `@path`: fetch its details, inspect the
path first, search related open and closed issues, research the smallest code
slice, then propose the smallest fix and focused verification.

Do not mutate issues. Defer a separate concern only after checking duplicates;
output issue scope, rationale, related issues, and labels.
