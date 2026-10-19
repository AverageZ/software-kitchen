---
name: "source-command-triage-issue"
description: "Triage a stale GitHub issue as close, update, or replace"
---

# source-command-triage-issue

Use this skill when the user asks to run the migrated source command `triage-issue`.

## Command Template

Fetch the supplied issue, search related issues, and inspect the smallest code
slice needed to determine whether it is resolved, relevant, superseded, or
misframed. Recommend exactly one outcome: close, update, or replace.

Report evidence, related issues, and ready-to-run GitHub CLI commands. Search
duplicates before drafting replacements and obtain repository labels. Do not
execute mutations without human approval.
