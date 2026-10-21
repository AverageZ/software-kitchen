# Software Kitchen — Timeline

One step at a time. Don't start the next step until the current one runs boringly.

## Phase 1: Plumbing (no models)

- [x] **1. Skeleton.** TypeScript repo, Mastra installed, a hello-world workflow.
  - Done when: `mastra dev` runs it from Studio.
- [x] **2. Intake.** CLI command takes a GitHub PR URL and stores the Input verbatim.
  - Done when: running it twice stores one Input.
- [x] **3. WorkItem.** Turn an Input into a WorkItem by hand (recipe name passed as a flag).
  - Done when: WorkItem is in the store, linked to its Input.

## Phase 2: First recipe (Dependabot bump)

- [x] **4. Code-only recipe.** Check out the PR, install, run tests, post the result as a PR comment. No merging.
  - Done when: a real Dependabot PR gets a correct comment.
- [x] **5. Limits and waiting.** Wait for CI by suspending; attempt and time limits; park on failure with a reason.
  - Done when: a failing PR ends up parked, not stuck "running".
- [ ] **6. Decision stage.** Model rates the bump (structured output). Still no merging; you compare its call to yours.
  - Done when: you've reviewed ~20 calls and trust or reject it.
  - Built: `clef-flash:9b` rates every bump; review with `kitchen decisions`, or replay a repo's merged
    history with `kitchen eval OWNER/REPO` (a merge counts as your "safe"). Waiting on your ~20 reviews and
    some real unsafe examples: history has almost none.
- [ ] **7. Define "safe".** Write the rule (semver level, tests, changelog, package allowlist?). Turn on auto-merge for that rule only.
  - Done when: rule is written down and one PR merges unattended.
  - Built: draft rule in `ARCHITECTURE.md`, merge behind `kitchen run --allow-merge`. Waiting on your sign-off and a first merge.

## Phase 3: Routing

- [x] **8. Triage + Router.** Model proposes a recipe; plain rules decide.
  - Done when: a Dependabot PR reaches step 4's recipe with no flags.

## Phase 4: Agent work

- [ ] **9. Refactor recipe.** First Session stage: small issue in, PR out, labelled `agent:monitor`.
  - Done when: one issue becomes a PR you'd approve.
- [ ] **10. Monitor recipe.** Watches `agent:monitor` PRs; addresses feedback and conflicts.
  - Done when: a review comment gets a correct follow-up commit.

## Phase 5: Keeping it honest

- [ ] **11. Reconciler.** Finds stuck runs, missed events, and PRs that changed underneath a run.
  - Done when: killing the server mid-run leaves nothing stuck.
