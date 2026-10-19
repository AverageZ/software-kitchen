# Software Kitchen

The job of the kitchen:

> Given an input, classify and apply the appropriate recipe to achieve the goal, verify, and monitor the end result.

The kitchen accepts sparse, informal inputs. It uses standing recipes and repository context to discover scope, perform authorized work, and produce verified outcomes. It investigates before asking questions and interrupts the owner only for consequential decisions it cannot resolve within its delegation.

Input (inbox of inputs):

- JIRA
- Github Issue
- Random thought
- Some slack message that is going to distract me
- Snippet of code with a "fix this" comment
- Logging system report
- PR

Classification:

- Routing table
- Decisions model (like `clef-flash:9b`)
- Outputs WorkItems

Inputs become WorkItems after classification determines their scope

Recipe:

- declares input
- builds a prompt
- specifics verification steps
- Each stage needs (yaml configuration):
  - Inputs and required context.
  - Execution method: ordinary code, model decision, or harness session.
  - Structured output and completion conditions.
  - Deadline, attempt limit, and cost budget.
  - Allowed next states.
  - Failure and escalation behavior.

Every active stage has an owner, a deadline, and a recoverable recorded state. Waiting work consumes no execution slot.

Concretely:

- Workers claim stages using expiring leases and report heartbeats.
- An expired lease triggers reconciliation; it does not leave the item permanently “running.”
- CI waits, human waits, and retry delays release worker capacity.
- Retries have limits and backoff.
- Repeated failures park the item with a reason and a next action.
- Provider outages pause affected work while other eligible work continues.
- Repository or branch locks cover only operations that require exclusion.
- A prerequisite blocks its dependents, not unrelated items.

Router:

- moves WorkItems to the appropriate lane/recipe/stage

| Component  | Responsibility                                                               |
| ---------- | ---------------------------------------------------------------------------- |
| Intake     | Accept inputs, preserve their source, deduplicate events                     |
| Triage     | Gather context and propose `WorkItem` classification                         |
| Router     | Apply rules and select an eligible recipe                                    |
| Scheduler  | Dispatch ready stages within resource and concurrency limits                 |
| Runner     | Execute a bounded stage through your existing harness                        |
| Reconciler | Find expired runs, missed events, stale evidence, and changed external state |

## Recipe Ideas

### Routine work

- Dependabot makes a PR, auto-labelled with "agent:run" - the kitchen picks it up, classifies the recipe as "evaluate the dependency bump, test/verify it, approve if deemed safe, and merge the PR." No human in the loop if it's a minor change that can be safely handled
  - how is it deemed "safe"
  - where is the test and verification flow described
- I add a minor github issue with no body, just "migrate Button to new testing library" - picked up, classified as "refactor work, test/verify it, open PR for human verification, labelled with `agent:monitor`"
- I have one or more open PRs labelled `agent:monitor`- picked up, classified as "address feedback, resolve conflicts when they show up"

### Small tasks

TODO

### Medium tasks

TODO

### Large tasks

TODO

## Links

- https://github.com/humanlayer/12-factor-agents
- https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents
- https://stripe.dev/blog/stripes-payment-method-factory-orchestrating-agents-for-repeated-custom-integrations
