# Review: Background Agency jobs, second design (spec and plan)

> **Replaced, never built.** The design this file reviews was dropped on 2026-11-15 for starting a program in its own process (`spawn`, #1476). See `docs/superpowers/specs/2026-11-15-start-a-program-in-its-own-process.md`. This review stays as a record.

Reviewed on 2026-11-15, against the code in this worktree (`a80b90157`):

- `docs/superpowers/specs/2026-11-15-background-agency-jobs.md`
- `docs/superpowers/plans/2026-11-15-background-agency-jobs.md`

Paths are relative to `packages/agency-lang`. I read the code and ran nothing. The two older review files were written against the first design and are left as they are.

## Summary

The second design is much smaller than the first. It changes nothing in `lib/runtime/interrupts.ts`, and it drops the recorded handler list, the rule about handlers whose blocks have ended, the `jobId` field, and the split of the CLI policy handler. The plan follows the spec, and the names it relies on exist.

I found two things that need a change to the spec before building, two that need a stated answer, and some small fixes to the plan.

| # | Finding | Kind |
| --- | --- | --- |
| 1 | An unanswered `std::jobs::resume` pauses the parent, and a pause stops every job | Change the spec |
| 2 | What leaving the handlers out costs, as one concrete example | Change the spec's wording |
| 3 | A child's `std::guard` raise has nobody to answer it | Needs an answer |
| 4 | A rule's decision on a job's interrupt leaves no record | Needs an answer |

## 1. An unanswered `std::jobs::resume` stops the job it is resuming

`docs/dev/stdlib/jobs.md` says a job stops "when the run pauses to hand an interrupt to its caller". `cleanup()` closes the job table (`lib/runtime/state/context.ts:842`).

`resumeJob` raises `std::jobs::resume`. If no handler answers it, the parent pauses to ask its caller. That pause closes the table. When the caller approves and the parent resumes, `_resumeJob` finds no job.

The spec's own example does this. The start has `with approve` and the resume does not:

```agency
const resumed = resumeJob(id, [
  { interruptId: pending.value[0].interruptId, action: "approve" },
])
```

Run with `agency run --interactive`, this program asks the user "Resume job-3fa9c1 with these answers?", and the answer does not matter, because the job is already gone. The same pause stops every other job the program holds.

The same thing happens for any interrupt in the parent that reaches the user while a job is running or blocked. That was true of shell jobs before this spec. It matters more now for two reasons: a blocked job holds a checkpoint that cannot be made again, and the function that answers a blocked job is itself a raise.

`agency agent` is not affected. Its policy handler asks inside the handler, so the session never pauses.

What I would change:

- The spec's example gets `with approve` on the `resumeJob` line, and decision 5 says in one sentence that a program must answer `std::jobs::resume` with a handler, because a pause loses the job.
- `resumeJob`'s docstring says the same.
- The test list gets a case for it. The useful assertion is the failure message a caller reads after the pause, so that it says why the job is gone.

## 2. What leaving the handlers out costs

This is item 1 under "Needs the owner's decision". I think the design is sound. The spec's safety argument is right, but one sentence in it is stronger than the code supports.

The spec says "Every handler around the start sees it and can reject a start whose policy it does not accept." That is true only of a handler written to look at the payload of `std::runInBackground`. A handler written before this feature does not. Here is the case:

```agency
handle {
  // Somewhere inside, possibly several calls down:
  runFileInBackground("./scripts", "report.agency", "main",
    policy: { "std::write": [{ action: "approve" }] }) with approve
} with (intr) {
  if (intr.effect == "std::write") {
    return reject("This block must not write files.")
  }
  return pass()
}
```

Under `run()`, every write the child attempts is rejected by the outer handler. Under `runFileInBackground`, the outer handler passes on the start, the inner `with approve` approves it, and the job writes files. A handler that lists what it refuses is bypassed. A handler that lists what it allows and rejects the rest is not, because it rejects the unknown effect.

I checked the handlers `agency agent` registers outside its tests. There are two: the session's policy handler (`lib/agents/agency-agent/lib/turn.agency:135`) and `guardStopHandler` (`turn.agency:187`), which answers only `std::guard`. Neither refuses anything a job's policy could approve, because the job's policy is the session's own rules. So the agent loses nothing.

What I would change: put this example in the spec's safety section in place of the sentence quoted above, and put one sentence about it in `runInBackground`'s docstring and in the guide page on handlers. A person writing a handler that refuses an effect needs to know that it must also refuse `std::runInBackground`, or inspect its policy.

## 3. A child's `std::guard` raise

A guard trip in a child raises `std::guard`. Today, when no handler in the child owns it, the raise reaches the parent's chain, and in the agent `guardStopHandler` answers it as a hard stop.

For a job, the policy has no rule for `std::guard`, so the parent replies "no response". If no handler in the child answered either, the job blocks, and `/jobs answer` shows an approval prompt for a guard trip. The comment in `_handler` (`stdlib/policy.agency:1337`) says an approval with too little budget is refused by the runtime, which is why that handler passes on the effect.

I did not trace what the child does with an unanswered `std::guard`. The spec should say what happens, and the Agency tests should have a child with a `guard` block that trips.

## 4. A rule's decision leaves no record

Under `run()`, the parent's chain logs each handler decision to statelog. `policyOutcome` in the plan logs nothing. The spec says "A person reads what a job did in its output and its report", and neither of those has the interrupts a rule approved.

So a job can write forty files under a rule, and nothing anywhere says which rule approved which write. I would have `runStretch`'s `answer` log one statelog event for each decision on `job.run.log`, with the effect and the outcome. It prints nothing, so the prompt is not disturbed.

## Smaller points in the spec

**What the start's prompt shows.** In the agent, the payload of `std::runInBackground` carries the whole session policy. `oneLineData` (`stdlib/policy.agency:1300`) shows only string and number fields, so the one-line form leaves the policy out. I did not check what the full prompt body draws for an object that large. Add a step to the by-hand list: look at the prompt for a background start with a session policy of twenty rules.

**The rejection prompt's wording.** When the user picks "r", `askVerdict` asks "What should the agent do instead?" and wraps the reason with "The user rejected this call." (`stdlib/policy.agency:1430`). For a job's interrupt the reason goes to the job's program, not to the agent. This is fine for a first version. Say so in the spec, so nobody reports it as a bug.

**`currentPolicy()` before the policy has loaded.** It returns the empty policy, and a job started with it blocks on everything. That fails on the safe side. The plan's reasoning that the policy is loaded by then depends on `approvedPlan` raising for an `agency run` line, which I did not check.

## Smaller points in the plan

1. **Task 2, `JobOutput`.** The comment says "Null once a read has returned the final state", and the type is `() => OutputText` with no null. Make the comment and the type agree.
2. **Task 3, a stretch that runs out of time.** The three outcomes do not say which state a job gets when its child passes `wallClock`. A shell job gets `timedOut`. Say whether an Agency job gets `timedOut`, or `ended` with a failure result, and add the unit test.
3. **Task 5, the spread.** Agency has object spread (`stdlib/jobs.agency:81`, `stdlib/policy.agency:366`). Drop the paragraph that says what to do if it does not.
4. **Task 6, tests.** Add the case from finding 1.
5. **Task 10, `askVerdict` outside a handler.** It is exported now. `recordAnswer` already returns early when `_policy` is null (`stdlib/policy.agency:1217`), so a caller with no handler installed gets a prompt and no saved rule. Say that in its doc comment.

## Things I checked that hold

- `makeRunPolicyHandler(policy, dirs, true)` gives the four results in decision 4's table, and stays silent for an approving rule on a raise that expects a value (`lib/runtime/runPolicyHandler.ts:42`).
- `detachedRun` exists (`lib/runtime/asyncContext.ts:205`). `validatePolicy` is in `lib/runtime/policy.ts:246`, and `lib/stdlib/policy.ts:16` exports it as `_validatePolicy`.
- The cut line for `askVerdict` is right: everything from `const answer = askUser(intr)` to the end of `_handler` returns an approval or a rejection and nothing else, so `verdict.type` is always a valid `action`.
- `askUser` checks again for a rule saved by the prompt before it, so two pending interrupts of one effect ask once after an "always approve".
- A slash command runs inside the session's `handle` block, so `resumeJob` called from `/jobs answer` reaches `_handler` and its new approval.
- `startJob`'s `exec is { kind: "agency", args }` matches the shape at `stdlib/safeBash.agency:4568`, and `cliRunFile`'s guard agrees with the first arm of `cli`'s `match` (`stdlib/agency.agency:1299`).
- `CostBreakdown.totalCost` is the dollars field (`lib/runtime/invocationUsage.ts:43`).
- `std::policy` imports neither `std::safeBash` nor `std::agency` directly. I did not follow its imports further down.
