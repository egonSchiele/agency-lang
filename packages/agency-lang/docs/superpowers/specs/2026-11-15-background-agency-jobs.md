# Background Agency jobs: run Agency code in the background and answer its interrupts

> **Replaced, never built.** On 2026-11-15 this design was dropped for starting a program in its own process (`spawn`, #1476). That spec is `docs/superpowers/specs/2026-11-15-start-a-program-in-its-own-process.md`, and its section "What we keep from the background jobs design" lists the ideas that carried over. This file stays as a record of the design and its reasoning.

**Status:** spec, not built. Date: 2026-11-15. This is the second design. The first one had a job's interrupts answered by the handlers of the code that started it. This one has them answered by a policy the job is given when it starts. The section "Why a job does not use the parent's handlers" says why. The review file beside this spec was written against the first design.

Paths are relative to `packages/agency-lang`.

The discussion that led here is recorded in `docs/superpowers/ideas/2026-11-14-agents-talking-to-agents.md`.

## The problem

A program can start a shell command as a background job since #1454. It cannot do the same with Agency code.

Agency code that runs in a subprocess runs through `run()` in `std::agency`. The caller waits until the child ends:

```agency
import { runFile } from "std::agency"

node main() {
  const result = runFile("./scripts", "report.agency", "main") with approve
  print(result)
}
```

If `report.agency` takes forty minutes, `main` is stuck on that line for forty minutes. In `agency agent`, this means the agent cannot run a long Agency program and keep working. This is item 1 of ADI-295.

A shell job could not solve this. Starting the real `agency` program through a shell would run the code with no connection to the program that started it. The child's interrupts would reach nobody, and its spending would not count against the run's budget.

## How a subprocess works today

Read `docs/dev/runtime/subprocess-ipc.md` for the full picture. This section has the parts this spec depends on.

**The session.** `run()` starts a child process and keeps a `RunSession` object for it (`lib/runtime/ipc.ts`). Event listeners on the session handle every message the child sends: its interrupts, its lock requests, its spending, and its result. The calling code awaits a promise that settles when the session ends. The listeners do their work whether or not anything is awaiting that promise.

**The child's interrupts.** When the child raises an interrupt, three things happen in order:

1. The child's own handlers run. A reject there is final.
2. The child sends the interrupt to the parent. The parent runs its own handler chain and replies with an outcome: approved, rejected, propagated, or no response (`HandlerChainOutcome` in `lib/runtime/interrupts.ts:222`).
3. The child combines the two outcomes by the rules of handlers: any reject rejects, otherwise any propagate goes to the user, otherwise an approve approves.

**A pause.** If nothing settled the interrupt, the child saves a checkpoint and exits. It sends the parent one last message with the checkpoint and the unanswered interrupts. Today the parent keeps those in the frame of the `run()` call, and the interrupts travel up to the parent's own caller. When the user answers, the parent starts a fresh child with a resume instruction. That instruction carries the checkpoint, the interrupts, and one response for each.

**A policy answers an interrupt as a plain function.** `makeRunPolicyHandler(policy, dirs, interactive)` in `lib/runtime/runPolicyHandler.ts` takes a policy value and returns a function from an interrupt to an answer. It is what `agency run --policy` installs. It answers only when a rule matches, and it is silent otherwise. It needs no stack and no handler list.

## Why a job does not use the parent's handlers

A waiting `run()` gets four things from the fact that its caller is still standing inside the call: which handlers hear the child's interrupts, which cost guards its spending trips, whether it was cancelled, and whether a person can be asked at that moment.

A background job's caller has returned and moved on. The first design kept the parent's handlers answering anyway. To do that it had to record the handler list when the job started, keep calling handlers after their blocks had ended, leave out handlers of sibling branches, give the job its own stop signal, and split the CLI policy handler so that it would not open a prompt for a job. Each of these was a new rule in the handler chain, which is the most safety-sensitive code in the runtime.

Handlers are scoped by where the code is, like `try` and `catch`. A background job's interrupts happen outside every block, on purpose. A policy is a value. It has no position in the code, so nothing has to be recorded and nothing can end.

So in this design a job's interrupt is answered by two things only: the job's policy, and a person. Decision 4 has the rule, and the section "Interrupts, handlers, and checkpoints" says what this means for safety.

## The change in one example

```agency
import { runFileInBackground } from "std::agency"
import { jobInterrupts, resumeJob, jobOutput } from "std::jobs"

node main() {
  const policy = {
    "std::read": [{ action: "approve" }]
  }
  const started = runFileInBackground("./scripts", "report.agency", "main", policy: policy) with approve
  if (started is failure) {
    return started
  }
  const id = started.value

  // ... the program does other work here ...

  const report = jobOutput(id, wait: 60)
  print(report)
}
```

`runFileInBackground` asks one approval, starts the child, and returns a job id at once. The job is in the run's job table beside its shell jobs, so `jobOutput`, `stopJob`, and `listJobs` work on it.

The `with approve` on that line approves the start and nothing else. It does not answer the job's interrupts. The policy does: every `std::read` the job raises is approved without asking anyone.

Now suppose `report.agency` raises an interrupt the policy has no rule for:

```agency
node main() {
  raise report::publish("Publish the report?", { path: "out/report.md" })
  return "published"
}
```

The job becomes `blocked`. The program that started it reads the pending interrupts as data, shows them to the user, and resumes the job with the user's answers:

```agency
const pending = jobInterrupts(id)
if (pending is failure) {
  return pending
}
// Show pending.value to the user and collect one answer for each.
const resumed = resumeJob(id, [
  { interruptId: pending.value[0].interruptId, action: "approve" },
])
```

`jobInterrupts` raises nothing. `resumeJob` raises one effect of its own, and no handler answers the child's interrupts.

## Decisions

### 1. Starting a background run is its own function, with its own effect

`runInBackground` takes what `run` takes, plus one argument, `policy`. `runFileInBackground` takes what `runFile` takes, plus `policy`. Each returns `Result<string>`, and the string is the job id.

They are separate functions because the return value differs. `run` returns the child's result. `runInBackground` returns before the child has one.

`policy` is a policy value, the same shape `checkPolicy` and `--policy` take. Its default is the empty policy, which answers nothing. A policy that fails `validatePolicy` fails the call before anything is raised.

Both functions raise a new effect, `std::runInBackground`. Its payload is the payload of `std::run` plus the policy:

```agency
effect std::runInBackground {
  moduleId: string;
  node: string;
  args: Record<string, any>;
  limits: { wallClock: number; memory: number; ipcPayload: number; stdout: number; maxCost: number | null };
  cwd: string;
  logFile: string;
  depth: number;
  module: string;
  function: string;
  trustedModules: string[];
  policy: Record<string, any>
}
```

The effect is separate from `std::run` for a safety reason. Approving `std::run` approves starting a program whose every interrupt still comes back to the approver's handlers. Approving a background start approves more: everything the job's policy will approve later, with no handler looking. A handler or a saved rule that approves `std::run` must not approve that by accident. With a new effect, no existing handler and no existing rule covers it, and whoever does approve it can read the policy in the payload.

A rejected `std::runInBackground` starts nothing.

### 2. Only the root program can start a background run

`runInBackground` returns a failure when it is called inside a subprocess.

A subprocess has no user to show a blocked job to. Its own unanswered interrupts travel to its parent by pausing the whole subprocess. Letting it hold blocked jobs of its own would need a way to pass their interrupts up as well. That is more than the first version needs.

### 3. An Agency job is a second kind of job in the same table

The job table is `RuntimeContext.jobs` (`lib/runtime/jobs/jobTable.ts`). Today every job wraps a shell process. An Agency job wraps a subprocess session.

What stays the same for both kinds:

- The id, such as `job-3fa9c1`.
- The read position, so each `jobOutput` returns only what is new.
- The limits on how many jobs run and how many finished jobs are kept.
- `cleanup()` closes the table, which stops every job when the run ends or pauses.
- The table is never saved in a checkpoint.

What an Agency job holds that a shell job does not:

- The compiled program, the limits, and the settings it was started with. A resume starts a fresh child, and that child needs them again.
- Its policy. See decision 4.
- A stack of its own, used only for counting cost. See decision 7.
- The total its child has spent, across every stretch of running.
- When it is blocked, the child's checkpoint and its pending interrupts.

A session lasts one stretch of running, because each resume starts a new child with a new session. Anything that must last the whole job lives on the job.

### 4. A job's interrupts are answered by its policy, and by no handler

When a job's child raises an interrupt, the same three steps happen as for `run()`, with one difference in step 2:

1. The child's own handlers run, as today.
2. The child sends the interrupt to the parent. The parent checks it against the job's policy and replies with the outcome. No handler in the parent runs.
3. The child combines the two outcomes, as today.

The policy check has four results:

| The policy has | The parent replies | What happens |
| --- | --- | --- |
| A rule that approves | approved | The child carries on. |
| A rule that rejects | rejected, with the rule's `rejectMessage` | The raise fails in the child with that reason. |
| A rule that says `propagate` | propagated | The job blocks, even if a handler in the child approved. |
| No matching rule | no response | The child's own handlers decide. If none did, the job blocks. |

This is `makeRunPolicyHandler`, called with `interactive` set to true. That setting gives one more rule, which the CLI policy handler also has: a rule cannot approve a raise that expects a value. An approval from a rule carries no value, so such a raise blocks the job, and a person supplies the value through `resumeJob`.

**What the parent's handlers do not do.** A handler around the start, a handler registered later, and the session's policy handler in `agency agent` are all left out. None of them approves a job's interrupt, and none of them rejects one. This is the same for every job and does not depend on where the start was called from.

**The interrupt has nothing new on it.** The first design added a `jobId` field to the interrupt a handler receives. No handler receives a job's interrupt now, so the field is not added.

**Cancel.** A job's session is stopped by the job's own stop signal and by nothing else. Escape in the REPL and a failed sibling tool call do not stop a job, and they cannot affect its interrupts, because no code on the path of a job's interrupt reads the starting stack.

### 5. A blocked job is answered by a person

If the policy and the child's handlers do not settle the interrupt, the child saves a checkpoint and exits, as it does today. The job's state becomes `blocked`. The job holds the checkpoint and the pending interrupts, in memory.

Two functions in `std::jobs` deal with a blocked job.

**`jobInterrupts(id)` returns the pending interrupts as data.**

```agency
export type PendingInterrupt = {
  interruptId: string;
  effect: string;
  message: string;
  data: any;
  origin: string;
  expectsValue: boolean
}
```

Nothing is raised. The caller shows these to the user however it likes. For a job that is not blocked, the list is empty.

**`resumeJob(id, answers, policy)` resumes the job with the user's answers.**

```agency
export type JobAnswer = {
  interruptId: string;
  action: "approve" | "reject";
  value?: any
}
```

`value` is the value an approval carries, or the reason a rejection carries. These are the two things `approve(value)` and `reject(message)` carry in a handler.

`std::agency` has a similar type, `InterruptAnswer`, for the scripted answers `test()` takes. `JobAnswer` is a separate type on purpose. Tests and jobs are separate features, and a change to one type must not change the other.

`policy` is optional. When it is given, it replaces the job's policy from this resume on. `agency agent` uses it so that an "always approve" the user gave while answering reaches the job. When it is left out, the job keeps the policy it has.

`resumeJob` does these things in order:

1. It checks the answers. There must be exactly one for each pending interrupt, matched by `interruptId`. `validateResumeBatch` in `lib/runtime/interrupts.ts` already checks a set of interrupts against a set of responses for `respondToInterrupts`, and `resumeJob` uses it after the lookup by id. It also checks a given policy with `validatePolicy`. A bad set or a bad policy fails and leaves the job blocked.
2. It raises `std::jobs::resume`. See below.
3. It starts a fresh child with a resume instruction, which is the path a resumed `run()` uses today. The job keeps its id and its state becomes `running`.

**Why no handler answers the pending interrupts.** Three reasons:

1. The handlers around the `resumeJob` call were written for the code at that spot. They have nothing to do with the child's work. Where a program calls `resumeJob` must not change the answers.
2. Raising the interrupt again in the parent would make a new interrupt that belongs to the parent, at the parent's line. The real one belongs to the child, at the child's line, and the answer has to go there.
3. Agency already keeps these two kinds of answer apart. A handler or a rule answers when the interrupt is raised. A person answers later, and that answer travels with the checkpoint as a response. `respondToInterrupts` in TypeScript and `/resume` over HTTP both work this way.

**`resumeJob` raises `std::jobs::resume`.**

```agency
effect std::jobs::resume {
  jobId: string;
  command: string;
  interrupts: PendingInterrupt[];
  answers: JobAnswer[];
  policy: Record<string, any> | null
}
```

`resumeJob` is the one function in `std::jobs` that can approve something. The effect lets a program's handlers or policy decide whether the code calling it may answer for the user, and whether it may replace the job's policy. A handler that rejects the effect stops the resume, and the job stays blocked. A handler that approves it lets the resume go ahead with the answers it was given. No handler changes an answer, and the child's interrupts are not raised.

`resumeJob` is not in any tool bundle, and its docstring says a model must not be given it.

### 6. Output, the result, and the report

**Output.** A waiting `run()` copies the child's output to the parent's terminal. A background job collects it. `jobOutput` returns what is new since the last read, as it does for a shell job. The `stdout` limit of the run caps it.

**Trace events.** A child forwards its lifecycle events to the parent, where callbacks such as the agent's tool trace print them. A background job does not forward them. Its statelog events still go to the shared log.

**The result.** When the child ends, the job's state becomes `ended`. The report gains one field, `result`, which holds what `run()` would have returned. It is a `Result`, so a failure in the child is a failure there.

**Status in words.** `describeJobState` gains three: `blocked`, `returned` for a successful result, and `failed` for a failure.

**A wait ends when the job blocks.** `jobOutput(id, wait: 300)` waits for the job to end. A blocked job cannot end until the user answers. So a wait on a blocked job returns at once, and a wait that is already in progress returns when the job becomes blocked. Both report the state `blocked`.

### 7. Limits, cost, and stopping

**Time.** `wallClock` keeps its meaning: it limits one stretch of running, and time spent blocked does not count. `run()` has a ceiling of one hour (`LIMIT_CEILINGS` in `lib/runtime/ipc.ts`). A background run has its own ceiling of twelve hours, which is the ceiling shell jobs have. The default is one hour.

**Cost.** Each charge from a child goes through `accountChildUsage`. Today it bills the guards on the session's stack and then enforces them, and a tripped guard kills the child. A cost guard is shared by reference with every branch and does not know when its block has ended. With the starting stack, this code would stop the job an hour after the guard's block ended:

```agency
const started = guard(cost: $1.00) {
  return runFileInBackground("./scripts", "report.agency", "main")
}
```

This problem has nothing to do with handlers, so this design keeps the first design's answer. A job has a stack of its own, and its sessions bill that stack. The rules:

- **The run's total.** Each charge is added to the root stack's cost, so `getCost()` in the program that started the job includes it. A branch that is running when the charge arrives sees it after that branch joins, which is how a sibling branch's spending behaves today.
- **The root budget.** The limit from `--max-cost` or the config's `budget` still applies to a job. The job's stack carries the root budget's guards for this, and no other guard.
- **Guards around the starting call.** They do not cap the job. Their blocks ended when `runInBackground` returned.
- **`maxCost`.** The job adds up what its child has spent across every stretch and stops the child when the total passes `maxCost`. The report's `note` says so. Today `maxCost` is a `guard(cost:)` block around the `run()` call, which cannot work here for the reason above.

A time guard around the starting call does not apply to the job either. The job has `wallClock`.

**Stopping.** `stopJob` kills the child. For a blocked job there is no child, so it discards the checkpoint. Either way the state becomes `stopped`.

### 8. Three small changes to `std::policy`

`_handler` in `stdlib/policy.agency` is the handler `cliPolicyHandler` returns. It checks the saved rules, and when no rule decides, it asks the user. A job's interrupts never reach it, so it keeps its shape. Three things change around it.

**`askVerdict` is exported.** The second half of `_handler`, from the `askUser` call to the end, moves into its own function:

```agency
export def askVerdict(intr: any): any
```

It asks the user and returns their verdict. It holds the `askUser` call and everything after it: saving an "always" answer as a rule, reading a typed value, and asking for a reason on a rejection. `_handler` calls it where that code was. The code that answers a blocked job calls it once for each pending interrupt, with the interrupt's data. It is the same prompt the user sees today, with the same answers.

`askVerdict` returns what a handler returns: a value with a `type` of `approve` or `reject` and an optional `value`. The caller makes a `JobAnswer` from it by copying `type` to `action` and `value` to `value`, and adding the `interruptId`. `std::jobs` does not import `std::policy`, so this conversion is in the caller.

**`currentPolicy()` returns the rules the handler holds.**

```agency
export def currentPolicy(): Policy
```

It returns the policy `cliPolicyHandler` is working with at that moment, including every "always" answer given so far. When no handler is installed it returns the empty policy. This is how a job started in `agency agent` gets the session's rules, and how a resume gives the job the rules saved since.

**The handler approves `std::jobs::resume` without asking.** At a terminal, the person answering the job's interrupts is the person who would be asked, so a second prompt would ask them to confirm their own answers. The check comes after the rule check, so a rule that rejects the effect still rejects it. It comes after the non-interactive check, so a run with nobody at the terminal does not approve a resume by default. The end of `_handler` reads:

```agency
if (intr.effect == "std::jobs::resume") {
  return approve()
}
return askVerdict(intr)
```

### 9. In `agency agent`

**Starting.** The model already has `startJob`. Today an `agency run file.agency` line given to `startJob` runs in the foreground, because it runs in the agent's own process. With this change, `startJob` starts that line as an Agency job, through `runFileInBackground`. Every other `agency` line stays in the foreground. `agency test` is not part of this spec.

`startJob` passes two things the model does not choose:

- `policy` is `currentPolicy()`, so the job runs under the rules the session has at that moment.
- `wallClock` is `startJob`'s `maxMinutes`. `runFile`'s own default is 60 seconds, which is too short for a job.

The start raises `std::runInBackground`, and the session's policy handler asks the user about it like any other effect.

**What the user sees while a job runs.** Nothing. A rule that decides a job's interrupt is applied in the runtime and prints nothing. A person reads what a job did in its output and its report.

**When a job blocks.** The REPL prints a line, as it does when a job ends:

```
job-3fa9c1 is waiting for your answer. Type /jobs answer job-3fa9c1
```

It uses the same code that prints the finish line (`lib/stdlib/cliJobLine.ts`), so it appears above the prompt and never inside a menu.

**Answering.** `/jobs answer <id>` calls `jobInterrupts`, calls `askVerdict` for each pending interrupt, turns each verdict into a `JobAnswer`, and calls `resumeJob` with the answers and with `currentPolicy()`. Escape during the prompts resumes nothing, and the job stays blocked.

An "always approve" answer there saves a rule in the session's policy, as it does in a turn. Because the resume passes the current policy, the job has that rule from then on.

`resumeJob` raises `std::jobs::resume`, and the session's policy handler approves it without asking, as decision 8 says. So the user sees one prompt for each pending interrupt and nothing more.

**A rule saved in a turn while a job is running** does not reach the job until its next resume. The job keeps the policy it was last given.

**`/jobs`** lists a blocked job with its state and the message of each pending interrupt.

**The model.** The model gets no message about a blocked job. The jobs message lists jobs that are running or unread, and a blocked job is neither. If the model reads the job with `jobOutput`, the report says `blocked`. `jobOutput`'s docstring gains one sentence saying that a blocked job waits for the user and that the model should not wait on it.

**One-shot runs.** A one-shot run gets no job tools today, and that does not change.

## Interrupts, handlers, and checkpoints

**Is a handler skipped?** Yes, on purpose, and this is the one place this design differs from `run()`. The parent's handlers do not hear a job's interrupts. What keeps this safe:

- **Nothing is approved unless a rule in the job's policy approves it.** With the default empty policy, every interrupt the child's own handlers do not settle blocks the job and goes to a person. Leaving the handlers out can therefore only do one thing a handler would have prevented: let through an interrupt that a rule in the job's policy approves and a handler would have rejected.
- **That policy is approved before the job starts.** The start raises `std::runInBackground` with the policy in its payload. Every handler around the start sees it and can reject a start whose policy it does not accept.
- **No old approval covers it.** The effect is new, so a handler or a saved rule that approves `std::run` does not approve a background start.
- **The child's own handlers still run**, as they do under `run()`.

A program that needs its handlers to hear every interrupt of a child uses `run()`.

**Can code approve what was sent to the user?** `resumeJob` is the one function that answers a pending interrupt, and it takes answers as arguments. It raises `std::jobs::resume` first, so a program's handlers or policy can refuse it. Decision 2 keeps it out of sandboxed code: only the root program can start a background run, so only the root program holds a blocked job.

**The parent's checkpoint.** The job table is not saved. If the parent pauses, resumes, or is rewound, the table is empty afterwards, and a blocked job's checkpoint is lost with it. `jobInterrupts` and `resumeJob` for an old id return the failure `jobOutput` returns today, which lists the jobs that exist.

**The child's checkpoint.** A blocked job's checkpoint lives in the parent's memory and is never written to disk in this version. Nothing outside the process can edit it.

**`restore()` in the parent.** A `restore(checkpoint)` inside a program is applied to the same context, so its jobs keep running and its blocked jobs stay blocked.

## Where the code goes

| File | Change |
| --- | --- |
| `lib/runtime/jobs/jobTable.ts` | A job wraps either a shell process or a subprocess session. The `blocked` state. A wait ends when a job blocks. A listener for a job becoming blocked. |
| `lib/runtime/jobs/agencyJob.ts` (new) | Starting a job, running each stretch, the policy check, blocking, resuming, stopping, and cost. |
| `lib/runtime/ipc.ts` | A session takes from its caller where output goes, which stack is billed, how the child's interrupts are answered, and whether callbacks are forwarded. `run()` supplies today's behaviour. A second wall-clock ceiling. |
| `lib/runtime/state/stateStack.ts` | `addLocalCost`. |
| `lib/runtime/ipcChild.ts` | `SerializedInterrupt` carries `expectsValue`, so the prompt knows a pending interrupt asks for a value. |
| `lib/stdlib/jobs.ts`, `stdlib/jobs.agency` | `jobInterrupts`, `resumeJob`, the `std::jobs::resume` effect, the two new types, the `result` field, and the new status words. |
| `stdlib/agency.agency` | `runInBackground`, `runFileInBackground`, and the `std::runInBackground` effect. |
| `stdlib/policy.agency` | `askVerdict`, `currentPolicy`, and the approval of `std::jobs::resume`. |
| `stdlib/safeBash.agency` | `startJob` starts an `agency run` line as an Agency job. |
| `lib/stdlib/cliJobLine.ts`, `lib/stdlib/cli.ts` | The line for a blocked job. |
| `lib/agents/agency-agent/lib/slashCommands/jobs.agency` | `/jobs answer`, and the blocked row in the list. |
| `docs/dev/stdlib/jobs.md`, `docs/dev/runtime/subprocess-ipc.md`, `docs/dev/agents/approval-policies.md` | The mechanism and its rules. |

`lib/runtime/interrupts.ts` and `lib/runtime/types.ts` are not changed. The handler chain stays as it is.

## What this does not cover

- **A job whose interrupts reach the parent's handlers.** `run()` is the function for that.
- **A policy that follows the session live.** A job has the policy it was given at its start or at its last resume.
- **Messages between a job and its parent.** A child can already print, raise an interrupt, and return a value. Sending a message into a running job is a later piece of work.
- **A subagent as a background job.** This spec gives it the ground to stand on. The reviewer and the coder are not started as jobs here.
- **`agency test` in the background.**
- **A blocked job that survives quitting.** That needs the checkpoint on disk and the integrity check in `docs/dev/runtime/checkpoint-integrity.md`.
- **A background run started from inside a subprocess.**
- **Input to a shell job.**

## Decided by the owner

1. `resumeJob` raises an effect of its own.
2. Twelve hours is the ceiling for one stretch of a background run.
3. The CLI policy handler approves `std::jobs::resume` without asking.
4. The names `runInBackground` and `runFileInBackground`, and a `JobAnswer` type that is separate from `InterruptAnswer`.

## Needs the owner's decision

These four are new in this design. The spec picks one answer for each so the plan can be written, and none of them is settled.

1. **A job's interrupts skip the parent's handlers.** This is the design itself. The section "Interrupts, handlers, and checkpoints" has the argument that it is safe.
2. **The start raises a new effect, `std::runInBackground`, and not `std::run`.** The first design raised `std::run`. The name is also new.
3. **`startJob` reads the session's rules with `currentPolicy()` from `std::policy`.** This makes `std::safeBash` import `std::policy`. The other way to do it is for the agent to hand the policy to `startJob`, which needs a way to do that which the model cannot reach.
4. **`resumeJob` takes an optional `policy`.** Without it, a job in `agency agent` would block again on an interrupt the user had answered with "always approve".

## How to test

Make every change first. Then run `make` once and each test file once, with the output saved to a file.

**Unit tests, no child process.** `lib/runtime/jobs/jobTable.test.ts` and `lib/runtime/jobs/agencyJob.test.ts`, with a fake session:

- A session that reports a pause makes the job `blocked`, and the job holds the interrupts.
- A resume makes it `running` again under the same id.
- `stopJob` on a blocked job discards the checkpoint.
- A wait on a blocked job returns at once.
- A wait in progress returns when the job blocks.
- A cost total past `maxCost` stops the job.
- The cost total carries across a resume: a job that spends, blocks, is resumed, and spends again is stopped when the sum passes `maxCost`.
- The policy check gives each of the four outcomes in decision 4's table, and gives no response for a value-expecting raise under an approving rule.

**Agency tests, real children, no model calls.** A new `tests/agency/agencyJobs.agency`, with small child programs in a fixture folder:

1. A rejected `std::runInBackground` starts no job.
2. A handler that approves `std::run` and rejects every other effect does not let a background run start.
3. A policy that is not valid fails the call, and nothing is raised.
4. A child whose interrupt the job's policy approves runs to the end. Its output and its result are in the report.
5. A job started with no policy inside `handle { ... } with approve` raises. The job becomes `blocked`: the handler did not approve it.
6. A job started with no policy inside a handler that rejects everything except the start raises. The job becomes `blocked`: the handler did not reject it.
7. A policy rule that rejects, with a `rejectMessage`: the child reads the rejection and its reason.
8. A blocked job: `jobInterrupts` returns its effect, message, and data.
9. `resumeJob` with an approval lets the child finish. With a rejection, the child reads the rejection and its reason.
10. `resumeJob` runs inside a handler that approves `std::jobs::resume` and rejects every other effect. The job resumes with the answer it was given. This must fail if `resumeJob` raises the child's interrupts again.
11. A handler that rejects `std::jobs::resume` stops the resume, and the job stays blocked.
12. A child that asks for a value, under a policy that approves the effect, blocks. The answer's value reaches the child.
13. `resumeJob` with a new policy: the child's next raise of the same effect is approved by the new policy and the job does not block again.
14. A job started inside `guard(cost:)` spends past that limit after the block has ended, and keeps running.
15. `resumeJob` with a missing answer, an extra answer, or an unknown `interruptId` fails and leaves the job blocked.
16. `runInBackground` inside a subprocess returns a failure.
17. `stopJob` on a blocked job makes it `stopped`.
18. A job spends, and `getCost()` called afterwards in the starting program includes the amount.

**Policy tests.** In the existing tests for `stdlib/policy.agency`:

- `std::jobs::resume` is approved with no prompt in an interactive run. A rule that rejects it still rejects it. A non-interactive run rejects it.
- `currentPolicy()` returns the seeded policy, and returns the empty policy when no handler is installed.
- Every existing test passes unchanged. They are the check that moving code into `askVerdict` changed nothing.

**The agent.** In `lib/agents/agency-agent/tests/`:

- `/jobs answer` on a blocked job resumes it, and `/jobs answer` on a job that is not blocked says so.
- `startJob` with an `agency run` line starts a job whose policy is the session's.

**By hand, in `agency agent`.** These need a terminal:

- Start an `agency run` job whose program writes a file. With no rule for the write, the blocked line appears above the prompt. `/jobs answer` shows the usual approval prompt, and approving lets the job finish.
- Answer "always approve" there. A second write from the same job does not block it, and nothing is printed over the prompt.
- Let a job block while the slash menu is open. The line appears after the menu closes.
- Press Escape during a turn while a job runs. The job keeps running.
- Quit while a job is blocked. No child process is left.
