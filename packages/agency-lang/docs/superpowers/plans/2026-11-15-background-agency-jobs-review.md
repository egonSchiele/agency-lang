# Review: Background Agency jobs, implementation plan

> **Replaced, never built.** The design this file reviews was dropped on 2026-11-15 for starting a program in its own process (`spawn`, #1476). See `docs/superpowers/specs/2026-11-15-start-a-program-in-its-own-process.md`. This review stays as a record.

**Out of date.** This review is of the first plan, in which the parent's handlers answered a job's interrupts. The plan was rewritten later the same day around a policy the job holds, and that plan has not been reviewed.

Second review, 2026-11-15. It replaces the first review of the same day.

Reviewed: `docs/superpowers/plans/2026-11-15-background-agency-jobs.md` as revised at 00:45, against the revised spec and the code in this worktree (`a80b90157`). Paths are relative to `packages/agency-lang`. I read the code and ran nothing.

## Summary

Every point from the first review is fixed, and the spec was updated to match. The plan is ready to build once the two items below are settled. Both are small.

## What the first review raised, and where it stands

| First review | Now |
| --- | --- |
| A job's spending never reaches `getCost()` | Fixed. `chargeJob` adds the amount to the root stack's `localCost` and does not charge the root budget twice. Spec decision 7 says the same. Test 17 covers it. |
| A rule that decides a job's interrupt prints into the prompt | Fixed. `applyRule` skips both prints when the interrupt has a `jobId`. Tests added. |
| The job's data was split across two records | Fixed. The data is one optional `agency` field on the table's `Job`, set to null at every final state. |
| How to make the job's stack | Fixed: `new StateStack()`, with the reason `getOrCreateBranch` is wrong here. |
| `cloneForBranch` arguments | Fixed. |
| Task 5's premise | Fixed. It is now a type change. |
| The effect's declared fields | Fixed, with `command` added. |
| A job that changes while `std::jobs::resume` is answered | Fixed. `_resumeJob` compares the pending ids, with a unit test. |
| The size of `cli.ts` | Fixed. The plan gives the real length and the rule's limit. |
| What `with approve` on the start does | Fixed, in the docstring. |
| Escape inside `/jobs answer` | Traced in the plan and added to the by-hand list. I checked both line references (`lib/stdlib/cli.ts:736` and `:1586`) and they say what the plan says. |

## Status

Both items below are now fixed in the plan, along with one more found during the anti-pattern check: `describeJobState` takes a `JobSummary`, and the plan had the result only on `JobReport`. The summary now carries an `outcome` field that `describeJobState` reads.

## Two items left

### 1. What `job.ended` is for an Agency job

Task 3 says "Keep `job.ended` for `endJob`". `endJob` calls the job's `stop` and then awaits `job.ended` (`lib/runtime/jobs/jobTable.ts:222`), and `stopJob` awaits `endJob` before it reads the job (`lib/stdlib/jobs.ts:115`).

For a shell job, `ended` is the promise from `process.wait()`. An Agency job has no process, and the plan does not say what its `ended` is. Two ways this goes wrong:

- If `addAgencyJob` leaves it as a resolved promise, `stopJob` on a running Agency job returns before the child is dead, and reports the state `running`.
- If it is a promise nothing resolves, `stopJob` never returns.

The plan should say that `addAgencyJob` makes a promise that `finishAgencyJob` resolves. A running job's `stop` aborts the controller, the session rejects, the outcome code calls `finishAgencyJob`, and `endJob` then returns with the job `stopped`. Add a unit test in `agencyJob.test.ts`: `endJob` on a running Agency job resolves after the session rejects, and the job's state is `stopped` when it does.

### 2. The effect's field separators in task 7

The `std::jobs::resume` effect separates its fields with commas. Every effect in the stdlib separates fields with semicolons (`stdlib/shell.agency:45`, `stdlib/agency.agency:69`). Use semicolons.

## Things I checked in the revision that hold

- `[intr.interruptId for intr in pending]` is valid Agency. The stdlib uses the same form (`stdlib/safeBash.agency:342`).
- `const x = try _f(...)?` is the form `stdlib/jobs.agency:100` uses.
- `getCost()` reads `localCost` of the calling stack (`lib/stdlib/thread.ts:421`), so adding to the root stack's `localCost` is what a program's own `getCost()` call reads.
- The line limit the plan cites for `cli.ts` is at `eslint.config.js:140`, as the plan says.
- `finishJob` is the one place a job reaches a final state, so setting `agency` to null there covers a stopped job, a failed job, and a job past `maxCost`.
