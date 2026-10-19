---
name: git-workflow
description: Apply project Git conventions when naming branches, writing or reviewing commits, and creating or updating pull requests
---

# Git Workflow

Use this skill whenever proposing, creating, or reviewing a branch name, commit subject, or pull request title. Use the `pr` skill for pull request bodies; this skill owns naming and Git workflow safety.

## Required naming

Allowed types: `internal`, `patch`, `feature`, `wip`, `chore`, `docs`. Use the same type and issue number across the branch, commit subject, and PR title for the same change.

- Branch: `type-<issue-num>-short-desc`.
- Commit subject: `[type|#issue] Short description, closes #issue` when acceptance is complete; use `, refs #issue` for additive prerequisites or pending required evidence.
- PR title: the same format as the commit subject. Closing references require complete acceptance, including required verification.

The placeholders are replaced:

```text
Branch: patch-123-fix-recipe-routing
Commit: [patch|#123] Fix recipe routing, closes #123
PR title: [patch|#123] Fix recipe routing, closes #123
```

- Branch descriptions use lowercase kebab-case. Do not use slashes, underscores, `#`, or prefixes such as `codex/` or `fix/`.
- Commit subjects and PR titles use the literal square brackets, pipe, `#`, comma, and lowercase `closes` or `refs` shown above. The issue number in the prefix and reference clause must match.
- Use a short, imperative description of the actual change. Do not substitute Conventional Commits forms such as `feat:`, `fix:`, or `chore:`; `feat` and `fix` are not allowed types.
- Select the type from the work: `patch` for a bug fix, `feature` for new functionality, `internal` for internal implementation changes, `chore` for maintenance/tooling, and `wip` for explicitly unfinished work. Do not infer a different naming scheme from recent nonconforming commits or PRs.
- Resolve the real issue number from the user request, linked issue, or current branch/PR context. If it is unavailable, ask for it before proposing a final name or taking a Git mutation. Do not fabricate an issue, use `#0`, or invent an issue-less format.
- The closing clause is an issue-closing instruction, not decoration. Do not present unfinished work as ready to merge or close an issue it does not resolve.

## Workflow

1. Inspect the current branch, worktree, staged changes, and relevant diff using read-only Git commands. Preserve unrelated and pre-existing changes; do not stage the whole worktree indiscriminately.
2. Resolve the issue and type, then check the branch name, commit subject, and PR title against the required naming before proposing or applying them. Existing nonconforming names do not override this skill.
3. Run `pnpm check` before an authorized commit, plus focused runtime verification for the changed behavior. A failed check is not permission to use `--no-verify` or bypass hooks. Report the failure rather than claim verification passed.
4. For an authorized PR workflow, use the required title and the `pr` skill's Summary, Evidence, and Merge Danger body. Base the body on the actual diff and observed verification; do not claim unrun checks.
5. Before reporting completion, verify any authorized Git/PR mutation from the resulting branch, commit, or PR metadata. Do not create a commit merely to verify this skill.

## Safety

- Naming guidance is not authorization to mutate Git or GitHub. Follow repository restrictions and the user's requested scope; never commit, push, or open a PR automatically as a side effect of implementation work.
- Creating a commit does not authorize a push. Preparing a title/body does not authorize opening a PR.
- Do not rename an existing branch, amend commits, rebase, force-push, reset, clean, or discard changes merely to fix a convention violation. Report the mismatch and obtain authorization for the specific corrective action when it is outside the requested scope.
- Never rewrite shared history without explicit authorization. Prefer a new correctly named change over rewriting unrelated historical commits.
