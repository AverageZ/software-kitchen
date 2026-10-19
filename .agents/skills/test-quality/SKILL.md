---
name: test-quality
description: Review and write behavior-focused tests for TypeScript code, Mastra workflows, CLI boundaries, persistence, and external integrations.
---

# Test Quality Workflow

Use this skill when writing, changing, auditing, or reviewing tests and when
investigating coverage gaps. Follow the repository's existing test conventions;
do not import strategy-game's fixtures, browser DSL, or test dependencies.

## Required Workflow

1. **Read the owner and nearest valid pattern.** Inspect the implementation that
   owns the behavior and existing tests at that boundary. A legacy test is not
   automatically a valid precedent.
2. **State the observable contract.** Name the setup, production action, and
   resulting value, persisted state, transition, error, or external effect. The
   setup must not already satisfy the expected outcome.
3. **Choose the narrowest sufficient layer.** Use unit tests for validation,
   routing rules, boundaries, and structured decisions; integration tests for
   workflow coordination, persistence, suspension, and resumption; CLI or live
   scenarios for user-facing commands and external integration contracts. Add a
   slower layer only when it proves a distinct behavior.
4. **Name a plausible regression.** Identify the missing operation, wrong
   boundary, precedence error, or invalid transition the test must catch. If the
   same assertion would pass with that behavior broken, redesign the test.
5. **Act through the production boundary and observe the result.** Inspect the
   returned domain value, stored record, workflow state, or externally observable
   effect after the action. Mocks may supply external inputs but configured
   return values and call logs alone do not prove the claimed outcome. Keep
   tests deterministic and isolated; never mutate live GitHub resources in an
   automated test without explicit authorization.
6. **Run the focused test or scenario.** Discover the actual runner and command
   from the owning package; do not assume `pnpm test` or Playwright exists. If
   there is no test runner, use a temporary smoke script through the real
   production boundary. For a bug, observe failure before the fix and success
   afterward when practical. Report only verification actually exercised.
7. **Re-review validity after a green run.** Passing tests, assertion counts,
   coverage percentages, and clean lint do not establish semantic validity.
   Remove obsolete or invalid tests in the touched scope without deleting
   distinct regression coverage.

## Coverage Boundaries

Cover distinct outcomes, material boundaries, and plausible regressions rather
than one test per function or implementation branch. Keep variant matrices at
fast layers instead of repeating them across unit, integration, and CLI tests.
Do not add tests solely to increase a metric.

Do not permanently test wiring, prop forwarding, copied fixture inputs, source
text, incidental wording, method existence, or bare successful execution.
A smoke observation is sufficient for a mechanical refactor unless a material
consumer-visible contract otherwise lacks coverage.

Use project contracts from [ARCHITECTURE.md](../../../ARCHITECTURE.md) and the
current acceptance criteria in [TIMELINE.md](../../../TIMELINE.md), not invented
APIs or planned behavior presented as existing implementation. For example,
when intake exists, submitting the same PR URL twice must leave one stored
Input; a schema-only assertion would not prove that persistence contract.

## Static Checks Are Separate

`pnpm typecheck` checks TypeScript contracts. `pnpm check` runs formatting, lint,
and type checking. Neither command exercises runtime values, persistence,
workflow transitions, or GitHub effects. Run focused runtime verification for
behavioral changes in addition to applicable static checks.

Report a compact **contract → layer → plausible regression → post-action
observation → command/result** when it helps a reviewer assess the evidence.
Do not add this boilerplate to every test file.
