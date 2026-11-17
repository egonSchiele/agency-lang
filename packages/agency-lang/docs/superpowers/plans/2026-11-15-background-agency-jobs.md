# Background Agency jobs: implementation plan

> **Replaced, never built.** On 2026-11-15 this design was dropped for starting a program in its own process (`spawn`, #1476). That spec is `docs/superpowers/specs/2026-11-15-start-a-program-in-its-own-process.md`. Do not build from this plan. It stays as a record.

**Goal:** a program can run Agency code as a background job, and a person can answer the interrupts that job raises.

**Spec:** `docs/superpowers/specs/2026-11-15-background-agency-jobs.md`. Read it first. This plan says how to build what the spec decides, and does not repeat the reasons. Where this plan says "decision 4", it means the spec's.

**This is the second plan.** The first one had a job's interrupts answered by the parent's handlers. In this one a job's interrupts are answered by a policy the job holds, and the handler chain is not changed at all. The review file beside this plan was written against the first one.

**Before building:** the spec has a section "Needs the owner's decision" with four items. Do not start until the owner has answered them.

**How to work through it:** top to bottom. The tasks are ordered so each one builds on the one before. Make all the changes for a PR, then run one build and one test run, as "How to test" says at the end.

**Two PRs.** Tasks 1 to 7 are the language feature: any Agency program can use it. Tasks 8 to 10 wire it into `agency agent`. Task 11, the docs, is split between them. Open the second PR on top of the first.

Paths are relative to `packages/agency-lang`. Work in the worktree `worktree-agent-messaging`, on the branch `adit/agent-messaging`.

## Background: the code this builds on

Read this section before the tasks. Each part names the file to open.

### The job table

`lib/runtime/jobs/jobTable.ts` holds the background jobs of one run. It is plain data and a set of functions that take it. The table is the field `jobs` on `RuntimeContext` (`lib/runtime/state/context.ts`), and `cleanup()` closes it.

Today every job wraps a shell process:

- `addJob` starts the process through the host and pushes a `Job`.
- A `Job` has a `summary`, a `process`, its own `AbortController`, a read position for each output stream, and a promise called `ended`.
- `readJob` returns the output since the last read and moves the read position.
- `waitForJob` resolves when the job ends, when a timer fires, or when the caller's signal aborts.
- `endJob` aborts the job's controller and waits for `ended`.
- `onJobEnd` registers a listener that is called once for each job that ends.

`lib/stdlib/jobs.ts` is the TypeScript side of `std::jobs`. Each function there calls `currentRun()` on its first line and works on `run.ctx.jobs`. `stdlib/jobs.agency` wraps those functions.

### A subprocess session

`lib/runtime/ipc.ts` runs Agency code in a child process. Read `docs/dev/runtime/subprocess-ipc.md` beside it.

The call path today is:

1. `run()` in `stdlib/agency.agency` calls `_runProgram`, which raises `std::run` and then calls `_run` inside a `guard(cost:)` block.
2. `_run` calls `_runFor` (`ipc.ts:1351`). It checks the nesting depth, clamps the limits, works out which trusted modules and which settings the child gets, and calls `runBatch` with one child.
3. That child's work is `invokeSubprocess` (`ipc.ts:1183`). It writes the compiled program to a temporary folder, builds a run instruction or a resume instruction, and calls `runSubprocessSession`.
4. `runSubprocessSession` (`ipc.ts:1092`) forks the child and makes a `RunSession`. `attachSessionHandlers` wires the child's events to it and sends the instruction.
5. The session settles with one of two outcomes: a result, or a pause that carries the child's checkpoint and its unanswered interrupts.

A `RunSession` (`ipc.ts:238`) reads four things from the call that started it:

| Field | Used for |
| --- | --- |
| `stateStack` | The stack the parent's handler chain runs on for the child's interrupts, and the stack whose guards the child's spending is billed to and enforced on |
| `branchRun` | The run the parent's handler chain runs under |
| `parentStore` | The run that forwarded callbacks fire under |
| the `abortSignal` argument | Kills the child when the caller is cancelled |

It also writes the child's output straight to `process.stdout` and `process.stderr`, in `attachStdoutForwarder`.

### How the parent answers a child's interrupt

`handleInterruptMessage` (`ipc.ts`, near line 690) receives each interrupt the child sends. It calls `gatherChainOutcome`, which runs the parent's handler chain, and sends back the result. The result is a `HandlerChainOutcome` (`lib/runtime/interrupts.ts:222`):

```ts
export type HandlerChainOutcome =
  | { kind: "rejected"; value: any }
  | { kind: "approved"; value: any }
  | { kind: "propagated" }
  | { kind: "noResponse" };
```

The child combines this with the outcome of its own handlers. If nothing settled the interrupt, the child pauses.

A job replaces the chain with a policy check. That is the one change to this path, and it is in task 1.

### A policy as a function

`lib/runtime/policy.ts` holds the `Policy` type and the matcher. `checkPolicyExplicit(policy, interrupt, dirs)` returns the first matching rule's result, or null when no rule matches. `dirs` is a `PolicyDirs`, which is the field `policyDirs` on `RuntimeContext` (`context.ts:124`).

`makeRunPolicyHandler(policy, dirs, interactive)` in `lib/runtime/runPolicyHandler.ts` wraps the matcher as a function from an interrupt to an answer. It returns `undefined` when no rule matches. With `interactive` true, it also returns `undefined` for an approving rule on a raise that expects a value. `agency run --policy` installs it as a handler. A job calls it directly.

### Stacks, guards, and cost

A `StateStack` has a list of `guards`. The root budget from `--max-cost` is a guard on the root stack with `isRootBudget` set (`lib/runtime/rootBudget.ts`). A cost guard is shared by reference with every branch, through `cloneForBranch`.

`accountChildUsage` (`ipc.ts`, near line 840) bills each charge from a child to the session's stack and then calls `enforceGuards()` on it. A tripped guard kills the child.

`getCost()` returns the `localCost` of the stack that calls it (`lib/stdlib/thread.ts:421`).

### The CLI policy handler

`_handler` in `stdlib/policy.agency:1329` is what `cliPolicyHandler` returns. It checks the saved rules with `checkPolicy` and applies one with `applyRule`. When no rule decides, it calls `askUser`, which draws the approval prompt under the `std::tty` lock and records an "always" answer as a rule. The rules it works with are in the module variable `_policy`.

### `startJob` and the REPL

`startJob` in `stdlib/safeBash.agency` calls `approvedPlan` and then starts a job only when the plan's kind is `bash`. An `agency ...` line has the kind `agency` and runs in the foreground through `runAgency`, which calls `cli()` in `std::agency`. `cli(["run", file])` calls `runFile(cwd, file, "main")`.

`lib/stdlib/cliJobLine.ts` prints the line the REPL shows when a job ends. `jobEndLines` tracks what owns the terminal and holds a line while a menu is open. `_runLineRepl` in `lib/stdlib/cli.ts` registers it with `onJobEnd`.

`lib/agents/agency-agent/lib/slashCommands/jobs.agency` is the `/jobs` command.

## Rules that apply to every task

- Use types, not interfaces. Use objects, not maps. Use arrays, not sets. No dynamic imports.
- No mutable state in a TypeScript module variable. Everything a job needs lives on the job.
- Do not run `agency fmt` on any `.agency` file that already exists. Format only the `.agency` files this plan adds.
- Format the TypeScript files you touch with prettier, by name.
- `lib/runtime/ipc.ts` is about 1,600 lines. New code for jobs goes in `lib/runtime/jobs/agencyJob.ts`, not in `ipc.ts`.
- Do not change `lib/runtime/interrupts.ts`. If a task seems to need a change there, stop and ask.
- Check every doc and comment you write against `docs/dev/contributing/anti-patterns.md` and the writing tips before the PR.
- Never edit `CHANGELOG.md`.

## What a reviewer should look at hardest

Each of these has a test in the task named.

1. **A rejected `std::runInBackground` starts nothing.** Task 5. The test must fail when the start is moved above the raise.
2. **Nothing approves a job's interrupt except a rule in the job's policy and a person.** A job started with no policy inside `handle { ... } with approve` must block on its first interrupt. Task 6.
3. **An approval of `std::run` does not approve a background start.** Task 5.
4. **A rule never approves a raise that expects a value.** Task 3, and task 6 with a real child.
5. **No handler answers a pending interrupt.** `resumeJob` passes the caller's answers to the child and raises only `std::jobs::resume`. Task 6 has the test, and it must fail if `resumeJob` raises the child's interrupts again.
6. **A guard around the starting call does not stop the job later, and the root budget still does.** Task 3.
7. **`run()` behaves exactly as before.** Task 1 changes code that `run()` uses. The existing tests in `tests/agency/subprocess/` and `lib/runtime/ipc.test.ts` are the check, and they must pass unchanged.

---

## Task 1: a session takes its wiring from the caller

**Files:**
- Modify: `lib/runtime/ipc.ts`
- Test: `lib/runtime/ipc.test.ts`

Today a session assumes a waiting call. This task makes the four things it assumes into one value the caller supplies. `run()` supplies today's behaviour, so nothing changes for it.

### The wiring type

```ts
/** What a session needs from whoever started it. */
export type SessionWiring = {
  /** Receives each chunk of the child's output, and the truncation line. */
  onOutput: (stream: "stdout" | "stderr", chunk: Buffer | string) => void;
  /** The stack the child's spending is billed to and enforced on. */
  usageStack: StateStack;
  /** Called after each charge has been billed. */
  onUsage?: (delta: NormalizedDelta) => void;
  /** The parent's answer to one of the child's interrupts. */
  answer: (intr: InterruptInfo, interruptId: string) => Promise<HandlerChainOutcome>;
  /** Whether the child's lifecycle events fire the parent's callbacks. */
  forwardCallbacks: boolean;
};
```

`InterruptInfo` and `HandlerChainOutcome` are both in `lib/runtime/interrupts.ts` already.

Add `wiring: SessionWiring` to `RunSession`, and pass it into `runSubprocessSession`.

### Use it in four places

1. **`attachStdoutForwarder`** takes a stream name in place of a destination and calls `s.wiring.onOutput`. The byte counting, the truncation line, and the limit failure stay as they are.
2. **`handleInterruptMessage`** keeps its `adoptAlwaysScope` call and its `try` and `catch`. Inside the `try`, the block that calls `gatherChainOutcome` becomes `const outcome = await s.wiring.answer({ effect, message, data, origin, expectsValue }, msg.interruptId)`.
3. **`accountChildUsage`** bills and enforces on `s.wiring.usageStack`, then calls `s.wiring.onUsage` when it is set. It must stay synchronous. The comment above it says why.
4. **`handleCallbackMessage`** returns at once when `s.wiring.forwardCallbacks` is false.

Remove `stateStack` and `branchRun` from `RunSession` once nothing reads them. `parentStore` stays, for callbacks. `ctx` stays, for locks.

### `run()`'s wiring

The block that `handleInterruptMessage` loses moves, without a changed line, into one function in `ipc.ts`:

```ts
/** The answer a waiting `run()` gives: the parent's handler chain, run on
 *  the stack of the call that started the child. */
function chainAnswer(
  ctx: RuntimeContext<any>,
  branchRun: Run,
  stateStack: StateStack,
): SessionWiring["answer"]
```

Its body is the `runInBranchContext` call with `gatherChainOutcome` inside it, and it returns the `outcome`. The comments on span isolation move with the code.

In `invokeSubprocess`, build the wiring that reproduces today's behaviour:

```ts
const wiring: SessionWiring = {
  onOutput: (stream, chunk) =>
    (stream === "stdout" ? process.stdout : process.stderr).write(chunk),
  usageStack: args.stateStack,
  answer: chainAnswer(args.ctx, args.branchRun, args.stateStack),
  forwardCallbacks: true,
};
```

### Share the launch preparation

`_runFor` does five things before it starts a child: the capability check, the depth check, clamping the limits, choosing the trusted modules, and merging the parent's settings into the child's config. A job needs all five. Move them into one exported function that `_runFor` then calls:

```ts
export type ChildLaunch = {
  limits: RunLimits;
  trustedModules: TrustedModules[];
  configOverrides: Partial<AgencyConfig> | undefined;
  childDepth: number;
  cappedMaxDepth: number;
};

/** Everything decided before a child starts. Returns a failure Result in
 *  place of a launch when the depth cap or a trusted-module entry refuses. */
export function prepareChildLaunch(
  store: Run,
  compiled: { moduleId: string; code: string; trustedModules?: string[] },
  limits: RunLimits,
  configOverrides: Partial<AgencyConfig> | undefined,
  maxDepth: number,
  ceilings: RunLimits,
): ChildLaunch | ResultFailure
```

`clampLimits` gains a `ceilings` argument. `_runFor` passes `LIMIT_CEILINGS`. Add a second constant for jobs:

```ts
export const BACKGROUND_LIMIT_CEILINGS = {
  ...LIMIT_CEILINGS,
  wallClock: 12 * 60 * 60 * 1000,
} as const;
```

Export `runSubprocessSession` and `cleanupTempDir`, which task 3 calls. `buildRunInstruction`, `buildResumeInstruction`, and `materializeCompiledScript` are exported already.

### Tests

The existing tests in `lib/runtime/ipc.test.ts` and `tests/agency/subprocess/` must pass unchanged. Add to `ipc.test.ts`:

- A session sends back the outcome its wiring's `answer` returned.
- A session whose `answer` throws sends a rejection that starts "Parent handler error".
- A session whose wiring has `forwardCallbacks: false` drops a callback message.
- A session calls `onOutput` with each chunk and with the truncation line.
- A session calls `onUsage` after a charge.

---

## Task 2: the job table holds a second kind of job

**Files:**
- Modify: `lib/runtime/jobs/jobTable.ts`
- Test: `lib/runtime/jobs/jobTable.test.ts`

### What a job reads its output from

`readJob` calls `job.process.output()`. Give a job one field that both kinds fill:

```ts
/** What a job has printed on each stream. */
export type OutputText = { stdout: string; stderr: string };

/** Where a job's output comes from. Null once a read has returned the
 *  final state, which frees the output. */
type JobOutput = () => OutputText;
```

A shell job sets it to `process.output`. An Agency job sets it to a function over two strings it appends to. Replace the uses of `job.process` in `readJob` with it.

### One record per job

Everything an Agency job needs lives on its `Job` in the table, in one optional field:

```ts
/** What an Agency job needs across its stretches. Null for a shell job,
 *  and null again once the job has reached a final state. */
agency: AgencyJob | null;
```

`AgencyJob` is defined in `lib/runtime/jobs/agencyJob.ts`, in task 3. `jobTable.ts` imports that type and nothing else from the file.

There is no second table. When `dropOldFinishedJob` drops a job, everything the job held goes with it. `finishJob` sets `agency` to null for every final state, which frees the compiled program, the policy, the stack, and any checkpoint as soon as the job is over.

### The blocked state

```ts
export type JobState = "running" | "blocked" | "ended" | "stopped" | "timedOut";
```

Add to `JobSummary`:

```ts
/** For a blocked job, the message of each pending interrupt. */
waitingOn: string[];
/** For an Agency job that has ended: whether its result is a success or a
 *  failure. Null for a shell job and for a job that has not ended. */
outcome: "returned" | "failed" | null;
```

`finishAgencyJob` sets `outcome` from the result, with `isFailure` from `lib/runtime/result.ts`. The result itself is on the report and not on the summary, because it can be large and a summary is copied for every listing.

Add to `JobReport`:

```ts
/** What `run()` would have returned, once an Agency job has ended. */
result?: unknown;
```

### Waking a wait when a job blocks

`waitForJob` wakes on `job.ended`. A blocked job has not ended, so a wait needs a second way to wake.

Give each job a list of functions to call when its state changes:

```ts
/** Called when the job blocks or ends. `waitForJob` adds one and removes it. */
waiters: (() => void)[];
```

`waitForJob` returns at once when the job is not `running`. Otherwise it pushes `done` onto `waiters` and removes it inside `done`. `finishJob` and the new `blockJob` call every waiter. Keep `job.ended` for `endJob`.

`endJob` calls the job's `stop` and then awaits `job.ended`, and `stopJob` awaits `endJob` before it reads the job. For a shell job, `ended` comes from `process.wait()`. An Agency job has no process, so `addAgencyJob` makes the promise itself and keeps its resolve function on the job, and `finishJob` calls that function for an Agency job. Then `stopJob` on a running Agency job returns after the child is dead, with the state `stopped`. Do not leave `ended` as an already resolved promise, which would return while the child is still alive, and do not leave it as a promise nothing resolves.

### New functions

```ts
/** Adds an Agency job in the running state. `stop` is what `endJob` and
 *  `closeJobTable` call, with the job's id. */
export function addAgencyJob(
  table: JobTable,
  host: Host,
  init: { label: string; agency: AgencyJob; output: JobOutput; stop: (id: string) => void },
): JobSummary

/** The Agency data of a job, or null for a shell job, a finished job, or
 *  an unknown id. */
export function agencyJobOf(table: JobTable, id: string): AgencyJob | null

/** The job's child paused. `waitingOn` is the message of each interrupt. */
export function blockJob(table: JobTable, id: string, waitingOn: string[]): void

/** A blocked job's child was started again. */
export function unblockJob(table: JobTable, id: string): void

/** An Agency job reached its final state. */
export function finishAgencyJob(
  table: JobTable,
  id: string,
  ending: { state: JobState; result?: unknown; note: string },
): void

/** Calls `listener` once each time a job becomes blocked. Returns a
 *  function that removes the listener. */
export function onJobBlocked(table: JobTable, listener: (job: JobSummary) => void): () => void
```

Three rules for them:

- `addAgencyJob` applies the same limit check `addJob` applies. A blocked job counts toward `MAX_RUNNING_JOBS`, because it will run again.
- `finishAgencyJob` goes through `finishJob`, so `dropOldFinishedJob` and the end listeners behave the same for both kinds.
- `blockJob` calls the blocked listeners the way `finishJob` calls the end listeners: each in its own `try`, with the error logged. Move that loop out of `finishJob` into one function, `notify(listeners, job)`, and call it from both. Do not write the loop a second time.

`endJob` calls `job.controller.abort()` today. Make it call the job's `stop` function, which for a shell job is that abort.

`closeJobTable` stops every running job today. Make it stop every blocked job as well, through the same `stop`. A blocked job has no process, and stopping it is what drops its checkpoint.

### The status words

`describeJobState` gains:

- `blocked` for the blocked state,
- `returned` when an ended job's `outcome` is `returned`,
- `failed` when it is `failed`.

`describeJobState` takes a `JobSummary`, which is why the summary carries `outcome`. A shell job's `outcome` is null, so its words do not change.

### Tests

In `jobTable.test.ts`, with no child process:

- `blockJob` makes the job `blocked` and sets `waitingOn`.
- `unblockJob` makes it `running` again under the same id.
- A wait on a blocked job returns at once.
- A wait in progress returns when the job blocks.
- `finishAgencyJob` sets the result, and `readJob` returns it once.
- `describeJobState` says `returned` for a success result and `failed` for a failure result, and a shell job's words are unchanged.
- `endJob` on a running Agency job does not resolve until `finishAgencyJob` is called, and the job is `stopped` when it does.
- A blocked listener that throws does not stop the others.
- A blocked job counts toward the running limit.
- A job that is stopped, a job that fails, and a job that ends each have a null `agency` afterwards.
- `closeJobTable` calls `stop` for a blocked job.

---

## Task 3: the Agency job

**Files:**
- Create: `lib/runtime/jobs/agencyJob.ts`
- Modify: `lib/runtime/state/stateStack.ts`, for `addLocalCost`
- Test: `lib/runtime/jobs/agencyJob.test.ts`

This file starts a job, runs each stretch of it, answers its interrupts from its policy, blocks it, resumes it, and stops it. It uses the table from task 2 and the session from task 1.

### What an Agency job holds

This is the value of the `agency` field from task 2. Nothing is added to `RuntimeContext`.

```ts
export type AgencyJob = {
  compiled: CompiledProgramValue;
  node: string;
  launch: ChildLaunch;
  cwd: string | undefined;
  /** The rules that answer this job's interrupts. See decision 4. */
  policy: Policy;
  /** The dollars this job may spend in total, or null for no cap. */
  maxCost: number | null;
  spent: number;
  /** The stack this job's spending is billed to. It carries the root
   *  budget and nothing else. */
  stack: StateStack;
  /** The run this job's sessions log under. Its stack is `stack`. */
  run: Run;
  /** Aborted by `stopJob` and by `closeJobTable`. */
  controller: AbortController;
  /** The child's output so far. A separate object, so the table's output
   *  reader can keep it after `agency` is set to null. */
  collected: OutputText;
  subprocessSessionId: string;
  /** Set while the job is blocked. */
  paused: SubprocessResumePayload | null;
};
```

### The policy check

This is the whole of decision 4, in one function:

```ts
/** The parent's answer to a job's interrupt: what the job's policy says,
 *  and nothing from any handler. */
export async function policyOutcome(
  policy: Policy,
  dirs: PolicyDirs,
  intr: InterruptInfo,
): Promise<HandlerChainOutcome> {
  const response = await makeRunPolicyHandler(policy, dirs, true)(intr);
  if (response === undefined) return { kind: "noResponse" };
  if (isRejected(response)) return { kind: "rejected", value: response.value };
  if (isApproved(response)) return { kind: "approved", value: response.value };
  return { kind: "propagated" };
}
```

`makeRunPolicyHandler` is in `lib/runtime/runPolicyHandler.ts`. The third argument is `interactive`. Passing true is what keeps a rule from approving a raise that expects a value: the handler stays silent for it, so the job blocks and a person supplies the value. Do not write that check a second time here.

`isRejected` and `isApproved` are in `lib/runtime/interrupts.ts`. Check the type `makeRunPolicyHandler` declares for an interrupt (`Intr` in `lib/runtime/interruptPrompts.ts`) against `InterruptInfo`, and use whichever the compiler accepts for the parameter.

### Starting

```ts
export async function startAgencyJob(
  run: Run,
  start: {
    compiled: CompiledProgramValue;
    node: string;
    args: Record<string, any>;
    launch: ChildLaunch;
    cwd: string | undefined;
    policy: Policy;
    maxCost: number | null;
    label: string;
  },
): Promise<JobSummary>
```

In order:

1. **Make the job's stack** with one function in this file, `newJobStack(startingStack)`. It is the only place that knows how a job's stack is put together. It starts from `new StateStack()`, as `RuntimeContext` does (`context.ts:383`). Do not use `getOrCreateBranch`, which is how `runBatch` gets a branch. That attaches the stack to the caller's frame, and the frame is saved in checkpoints. A job's stack belongs to no frame. The function then adds the root cost budget and no other guard: for each guard on `startingStack` that is a `CostGuard` with `isRootBudget` set, it calls `stack.pushGuard(guard.cloneForBranch(startingStack, stack))`, which is how `rootBudget.ts` adds a guard. For a cost guard `cloneForBranch` returns the same object, so a charge on the job's stack counts against the one root budget.
2. **Make the run the sessions log under:** `detachedRun(run, { stack })`, from `lib/runtime/asyncContext.ts`.
3. **Build the `AgencyJob`** from the pieces above, the arguments, and a new `AbortController`.
4. **Add the job to the table** with `addAgencyJob`. Its `output` returns the two strings in `collected`. Its `stop` calls `stopAgencyJob`.
5. **Start the first stretch** with `runStretch`, without awaiting it. Attach a `catch` that logs, so a bug in `runStretch` is never an unhandled rejection.
6. Return the summary.

The caller has already checked the policy with `validatePolicy`. Task 5 does that before anything is raised.

### One stretch of running

```ts
async function runStretch(
  ctx: RuntimeContext<any>,
  id: string,
  job: AgencyJob,
  instructionFor: (scriptPath: string) => RunInstruction | ResumeInstruction,
): Promise<void>
```

This is `invokeSubprocess` without the waiting call. In order:

1. `materializeCompiledScript(job.compiled)` gives the script path.
2. Log `subprocessStarted` on `job.run.log`, as `invokeSubprocess` does. The mode is `run` for the first stretch and `resume` after.
3. Call `runSubprocessSession` with the job's wiring and with `abortSignal: job.controller.signal`.
4. Handle the outcome, in the next section.
5. In a `finally`, call `cleanupTempDir(scriptPath)`.

The wiring:

```ts
const wiring: SessionWiring = {
  onOutput: (stream, chunk) => {
    job.collected[stream] += chunk.toString();
  },
  usageStack: job.stack,
  onUsage: (delta) => chargeJob(ctx, id, job, delta),
  answer: (intr) => policyOutcome(job.policy, ctx.policyDirs, intr),
  forwardCallbacks: false,
};
```

`answer` reads `job.policy` each time it is called, so a policy that a resume replaced is the one used from then on.

The only stop signal the session gets is the job's own controller. Nothing here reads the starting stack or the run's signal, so Escape and a failed sibling tool call cannot stop a job or touch its interrupts.

### The three outcomes

- **A result.** Call `finishAgencyJob` with the state `ended` and the value as `result`.
- **A pause.** Set `job.paused` to the payload `invokeSubprocess` saves today: the child's checkpoint, the interrupts, the node, and the session id. Then call `blockJob` with the message of each interrupt.
- **A rejected session.** When the error is an `AgencyCancelledError`, the job was stopped: finish it with the state `stopped`. For any other error, finish it with the state `ended` and a `result` that is a failure carrying the error's message. That is what `try _run(...)` gives a waiting caller.

Log `subprocessEnd` in each case, as `invokeSubprocess` does.

Every final state goes through `finishAgencyJob`, which sets the job's `agency` to null. So a job that is stopped, fails, or passes `maxCost` holds nothing afterwards, the same as one that returns.

### Cost

```ts
function chargeJob(
  ctx: RuntimeContext<any>,
  id: string,
  job: AgencyJob,
  delta: NormalizedDelta,
): void
```

`NormalizedDelta` is in `lib/runtime/invocationUsage.ts`. Its `cost` is a `CostBreakdown`, so read that type for the field that holds the total in dollars. Call that number the amount. `chargeJob` does three things with it.

**1. It adds the amount to `job.spent`.** The total is on the job, so it carries across a resume.

**2. It adds the amount to the root stack's `localCost`.** This is what makes `getCost()` include the job.

`getCost()` returns the `localCost` of the stack that calls it. The session bills each charge to its `usageStack`, which is the job's stack, through `billCharge` (`stateStack.ts:1091`). A branch's spending reaches its parent when the branch joins. A job's stack never joins anything, so without this step no other stack would ever see what the job spent.

`StateStack` has `billCharge`, which adds to `localCost` and charges the guards, and `chargeGuards`, which only charges the guards (`stateStack.ts:1090`). Add the third one beside them, `addLocalCost(amount)`, which only adds to `localCost`, and call `ctx.stateStack.addLocalCost(amount)`. Do not write the field from this file, and do not call `billCharge` on the root stack. That would charge the root budget's guard a second time, since the job's stack shares that guard and the session has already charged it. It would also charge whatever guard block the main program happens to be inside at that moment.

A branch that is running at that moment got its starting cost from its parent before the charge, so `getCost()` inside that branch does not include the charge until the branch joins. That is accepted. It is how a sibling branch's spending behaves today.

**3. It enforces `maxCost`.** When `job.maxCost` is not null and `job.spent` is over it, set the note "Stopped: spent $X of a $Y limit." and stop the job.

The session's own enforcement still runs on the job's stack, which holds only the root budget.

### Resuming

```ts
export function resumeAgencyJob(
  ctx: RuntimeContext<any>,
  id: string,
  responses: InterruptResponse[],
  policy: Policy | null,
): JobSummary
```

`responses` is in the order of `job.paused.interrupts`. Task 6 does the matching by id before it calls this.

1. When `policy` is not null, set `job.policy` to it.
2. Take `job.paused` and set it to null.
3. Call `unblockJob`.
4. Start a stretch whose instruction is `buildResumeInstruction` with the saved payload, the responses, and the job's limits, settings, and identity. Do not await it.

`resolveInstruction` in `ipc.ts` reads the responses from `ctx.getInterruptResponse`, which is filled by `respondToInterrupts`. A job's responses come as an argument, so this file calls `buildResumeInstruction` directly.

### Stopping

```ts
export function stopAgencyJob(ctx: RuntimeContext<any>, id: string): void
```

- A running job: abort `job.controller`. The session kills the child and rejects with `AgencyCancelledError`, and the outcome code above finishes the job as `stopped`.
- A blocked job: there is no child. Finish the job as `stopped`, which drops its checkpoint with the rest of `agency`.

It reads the job with `agencyJobOf(ctx.jobs, id)` and does nothing when that is null.

### Tests

`lib/runtime/jobs/agencyJob.test.ts` uses a fake in place of `runSubprocessSession`, so no child starts. Pass the session function in as an argument with the real one as the default, the way `jobTable.ts` takes `capBytes`.

For `policyOutcome`:

- An approving rule gives `approved`.
- A rejecting rule gives `rejected`, and its `rejectMessage` is the value.
- A `propagate` rule gives `propagated`.
- No matching rule gives `noResponse`. So does the empty policy.
- An approving rule on an interrupt with `expectsValue: true` gives `noResponse`.
- A rejecting rule on an interrupt with `expectsValue: true` gives `rejected`.

For the job:

- A stretch that returns a value finishes the job with that result.
- A stretch that pauses blocks the job, and `job.paused` holds the payload.
- The wiring's `answer` gives what the job's policy says.
- `resumeAgencyJob` starts a second stretch with a resume instruction that carries the responses in order.
- `resumeAgencyJob` with a policy: the second stretch's `answer` uses the new policy. With null, it uses the old one.
- `stopAgencyJob` on a blocked job finishes it as `stopped` and drops the payload.
- `endJob` on a running job aborts the job's controller, resolves after the fake session rejects with `AgencyCancelledError`, and leaves the job `stopped`.
- A job that spends, blocks, is resumed, and spends again is stopped when the sum passes `maxCost`.
- A charge adds its amount to the root stack's `localCost` once, and charges the root budget's guard once.
- A job that is stopped, and one whose session rejects with an error, each have a null `agency` afterwards.
- The job's stack holds the root cost budget and no other guard, when the starting stack also holds a `guard(cost:)` guard.
- The job's stack is not a branch of any frame.
- Aborting the run's own signal does not abort the signal the session was given.

The cases that need a real child are in task 6's Agency tests.

---

## Task 4: a pending interrupt keeps `expectsValue`

**Files:**
- Modify: `lib/runtime/ipcChild.ts`
- Create: `lib/runtime/ipcChild.test.ts`. The file has no unit test today.

`SerializedInterrupt` (`ipcChild.ts:48`) is the type of what a paused child sends for each unanswered interrupt. The type has no `expectsValue`. The approval prompt needs that field, to know that an interrupt asks for a value and not for a yes or no.

The field already travels. `serializeInterruptsForIpc` (`ipcChild.ts:71`) copies every field of the interrupt except the two checkpoint fields, and an interrupt carries `expectsValue: true` when its raise expects a value (`interrupts.ts:144`). So the only change is to add `expectsValue?: boolean` to the type, so the code that reads it type-checks.

Test: the function that builds the `interrupted` message keeps `expectsValue: true` on an interrupt that has it, and adds no field to one that does not. Case 12 in task 6 checks the same thing with a real child.

---

## Task 5: `runInBackground` and `runFileInBackground`

**Files:**
- Modify: `stdlib/agency.agency`
- Modify: `lib/stdlib/jobs.ts`

### The effect

Add beside `std::run` (`stdlib/agency.agency:69`):

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

### Share the payload

`_runProgram` (`stdlib/agency.agency:235`) works out the origin labels and the message, builds the payload, and raises `std::run`. The background version raises a different effect with the same payload plus the policy. Move the part that builds the labels and the payload into one function, so the two cannot drift apart:

```agency
type RunQuestion = {
  message: string;
  payload: Record<string, any>
}

// What a run is about to ask: the message and the payload std::run
// carries. `run` raises it as std::run. `runInBackground` adds the policy
// and raises it as std::runInBackground.
def runQuestion(
  compiled: CompiledProgram,
  node: string,
  args: Record<string, any>,
  settings: RunSettings,
  sourceModule: string,
  functionName: string,
): RunQuestion {
  // the origin labels, the message, and the payload object that
  // _runProgram builds today
}
```

`RunSettings` stands for whatever type `_runOptions` returns. Use its real name.

`_runProgram` then reads:

```agency
const question = runQuestion(compiled, node, args, settings, sourceModule, functionName)
return interrupt std::run(question.message, question.payload)
```

If the type checker refuses a `Record<string, any>` where the effect's declared fields are expected, give `runQuestion` a return type whose `payload` is the declared shape. Do not go back to two copies of the object.

### The TypeScript side

Add to `lib/stdlib/jobs.ts`:

```ts
/** Starts an approved program as a background job and returns its id.
 *  Raises nothing: its only callers raised std::runInBackground first. */
export async function _runInBackground(
  compiled: CompiledProgramValue,
  node: string,
  args: Record<string, any>,
  wallClock: number,
  memory: number,
  ipcPayload: number,
  stdout: number,
  configOverrides: Partial<AgencyConfig> | null,
  cwd: string,
  maxDepth: number,
  maxCost: number | null,
  policy: Policy,
  label: string,
): Promise<string>
```

It calls `currentRun()` on its first line, calls `prepareChildLaunch` with `BACKGROUND_LIMIT_CEILINGS`, throws the failure's message when the launch is refused, and calls `startAgencyJob`.

### The Agency side

```agency
@capabilities(fileWrite, subprocess)
export def runInBackground(
  compiled: CompiledProgram,
  node: string,
  args: Record<string, any> = {},
  wallClock?: number,
  memory?: number,
  ipcPayload?: number,
  stdout?: number,
  logFile?: string,
  cwd?: string,
  maxDepth?: number,
  maxCost?: number,
  policy: Record<string, any> = {},
): Result<string> raises <std::runInBackground> {
  """
  Start a compiled Agency program as a background job and return its job id at once. Read it with jobOutput, stop it with stopJob, and answer its questions with jobInterrupts and resumeJob, all from std::jobs. The job's interrupts are answered by the policy given here and by no handler: a handler around this call approves the start and nothing the job does later. An interrupt the policy has no rule for blocks the job until a person answers it.

  @param compiled - The complete value returned by compile, including its captured code.
  @param node - The exported entry node to execute.
  @param args - Named arguments for the entry node.
  @param wallClock - The time limit for one stretch of running, in milliseconds, up to twelve hours. Time spent waiting for an answer does not count.
  @param maxCost - The total the job may spend in dollars, or null for no cap.
  @param policy - The approval rules for the job's interrupts. The default has no rules, so every interrupt blocks the job.
  """
  // 1. Fail when _subprocessDepth() is above 0.
  // 2. validatePolicy(policy), from std::policy's TypeScript side
  //    (`_validatePolicy` in lib/stdlib/policy.ts). Return its failure.
  // 3. Build the settings, with a wallClock default of one hour.
  // 4. const question = runQuestion(...)
  // 5. return interrupt std::runInBackground(
  //      "${question.message}, in the background",
  //      { ...question.payload, policy: policy })
  // 6. try _runInBackground(...), and return the id.
}
```

Give the other parameters the docstring lines `run` has. `runFileInBackground` takes what `runFile` takes plus `policy`, compiles with `_compileFile`, and calls `runInBackground`. Its label is `agency run <filename>`. The label for a bare `runInBackground` is the module id and the node.

Step 5 uses an object spread. If Agency has no spread in an object literal, add the policy inside `runQuestion` through an optional last parameter and keep one copy of the object.

`return interrupt ...` is the form `_runProgram` uses. A rejection returns the failure, and an approval carries on to the next line.

A guard block is not used for `maxCost` here. The job enforces it, in task 3.

### Tests

These are the first three cases of `tests/agency/agencyJobs.agency`. Task 6 lists the whole file.

---

## Task 6: `jobInterrupts` and `resumeJob`

**Files:**
- Modify: `lib/stdlib/jobs.ts`
- Modify: `stdlib/jobs.agency`
- Create: `lib/stdlib/jobs.test.ts`
- Create: `tests/agency/agencyJobs.agency`, `tests/agency/agencyJobs.test.json`
- Create: `tests/agency/agencyJobs/`, a folder of small child programs

### The TypeScript side

```ts
/** A blocked job's pending interrupts, as data. An empty list for a job
 *  that is not blocked. Throws for an unknown id. */
export function _jobInterrupts(id: string): PendingInterruptForAgency[]

/** A checked set of answers, ready to resume a job with. The Agency side
 *  reads `command` and `interrupts` for the question it raises, and hands
 *  the whole value back to `_resumeJob`. */
export type PreparedResume = {
  command: string;
  interrupts: PendingInterruptForAgency[];
  /** One for each interrupt, in the interrupts' order. */
  responses: InterruptResponse[];
  /** The policy the job has from this resume on, or null to keep its own. */
  policy: Policy | null;
};

/** Checks the answers against the job's pending interrupts, and the policy
 *  when one is given. Throws when the job is not blocked, when an id is
 *  unknown, when an answer is missing or extra, or when the policy is not
 *  valid. */
export function _prepareResume(
  id: string,
  answers: JobAnswerForAgency[],
  policy: Policy | null,
): PreparedResume

/** Resumes a blocked job with what `_prepareResume` returned. */
export function _resumeJob(id: string, prepared: PreparedResume): JobSummaryForAgency
```

`_prepareResume` looks each interrupt's answer up by `interruptId`, builds `{ type: answer.action, value: answer.value }` for it, and then calls `validateResumeBatch(interrupts, responses)` from `lib/runtime/interrupts.ts`. It throws that function's message when there is one. It checks a policy that is not null with `validatePolicy` from `lib/runtime/policy.ts`.

The Agency side gets one value and passes it back. It does not pull the interrupt ids out or keep the responses in step with them. That bookkeeping stays in these two functions.

`_resumeJob` calls `resumeAgencyJob`. Before it does, it checks two things again, because time passes while `std::jobs::resume` is being answered:

- The job is still blocked. It may have been stopped.
- The job's pending interrupt ids are exactly the ids in `prepared.interrupts`, in the same order. Another caller may have resumed the job, and the job may have blocked again on different interrupts. Old answers must not be given to new questions.

When either check fails, it throws, and the job is left as it is.

`_readJob` and `_listJobs` need no change beyond the new fields from task 2.

### The Agency side

Add to `stdlib/jobs.agency`:

```agency
export type PendingInterrupt = {
  interruptId: string;
  effect: string;
  message: string;
  data: any;
  origin: string;
  expectsValue: boolean
}

export type JobAnswer = {
  interruptId: string;
  action: "approve" | "reject";
  value?: any
}

effect std::jobs::resume {
  jobId: string;
  command: string;
  interrupts: PendingInterrupt[];
  answers: JobAnswer[];
  policy: Record<string, any> | null
}

export def jobInterrupts(id: string): Result<PendingInterrupt[]> {
  """
  List the questions a blocked background job is waiting on. Each one has the effect, the message, and the data of an interrupt the job raised and nobody answered. Returns an empty list for a job that is not blocked.

  @param id - The job id, such as job-3fa9c1.
  """
  const pending = try _jobInterrupts(id)?
  return success(pending)
}

export def resumeJob(
  id: string,
  answers: JobAnswer[],
  policy: Record<string, any> | null = null,
): Result<JobSummary> raises <std::jobs::resume> {
  """
  Resume a blocked background job with a person's answers to its questions. Show each question from jobInterrupts to a person first, and pass their answers here. Do not give this function to a model as a tool.

  @param id - The job id, such as job-3fa9c1.
  @param answers - One answer for each pending question, matched by interruptId. value is the value an approval carries, or the reason for a rejection.
  @param policy - Approval rules that replace the job's own from now on, or null to keep them.
  """
  const prepared = try _prepareResume(id, answers, policy)?
  return interrupt std::jobs::resume("Resume ${id} with these answers?", {
    jobId: id,
    command: prepared.command,
    interrupts: prepared.interrupts,
    answers: answers,
    policy: policy
  })
  const resumed = try _resumeJob(id, prepared)?
  return success(resumed)
}
```

The answers and the policy are checked before the raise, so a bad set fails without asking anyone.

The effect declares all five fields it is raised with, as other effects do. `std::toolbox::review` in `stdlib/toolbox.agency:142` is an example.

Add `state` and the report's `result` to the `JobReport` and `JobSummary` types in this file, and `waitingOn` and `outcome` to `JobSummary`.

Add one sentence to `jobOutput`'s docstring: "A blocked job is waiting for the user's answer, so do not wait on it."

### The child programs

`tests/agency/subprocess/run-file.agency` shows how a test runs a child from a fixture folder. Put these in `tests/agency/agencyJobs/`:

- `asks.agency` raises one custom effect, prints a line, and returns a value.
- `asksTwice.agency` raises the same effect twice.
- `asksForValue.agency` assigns the answer of a raise and returns it.
- `spends.agency` is for the cost tests. Read `tests/agency/subprocess/run-max-cost.agency` for how an existing test makes a child spend without a real model.

### The Agency tests

`tests/agency/agencyJobs.agency`, one node per case. Job ids are random, so each node reads its id from the start function's result. A policy in a test is an object literal, such as `{ "test::ask": [{ action: "approve" }] }`.

1. A rejected `std::runInBackground` starts no job.
2. A handler that approves `std::run` and rejects every other effect does not let a background run start.
3. A policy that is not valid fails the call. A handler that counts raises sees none.
4. A child whose interrupt the job's policy approves runs to the end. Its output and its result are in the report.
5. A job is started with no policy, inside `handle { ... } with approve`, and raises. The job becomes `blocked`. This is the test that no parent handler approves a job's interrupt.
6. A job is started with no policy, inside a handler that approves `std::runInBackground` and rejects every other effect, and raises. The job becomes `blocked`, not failed. This is the test that no parent handler rejects one either.
7. A policy rule that rejects, with a `rejectMessage`: the child's result carries the reason.
8. A blocked job: `jobInterrupts` returns its effect, message, and data.
9. `resumeJob` with an approval lets the child finish.
10. `resumeJob` with a rejection and a reason: the child's result carries the reason.
11. `resumeJob` runs inside a handler that approves `std::jobs::resume` and rejects every other effect. The job resumes with the answer it was given. This must fail if `resumeJob` raises the child's interrupts again.
12. A handler that rejects `std::jobs::resume` stops the resume, and the job stays blocked.
13. `asksForValue.agency` under a policy that approves its effect: the job blocks, and the value in the answer is what the child returns.
14. `asksTwice.agency` with no policy blocks. `resumeJob` with an approval and with a policy that approves the effect: the job runs to the end and does not block a second time.
15. The same child, resumed with an approval and no policy, blocks a second time.
16. A job started inside `guard(cost:)` spends past that limit after the block has ended, and keeps running.
17. `resumeJob` with a missing answer, an extra answer, or an unknown `interruptId` fails and leaves the job blocked.
18. `runInBackground` inside a subprocess returns a failure. The node runs a child that calls it.
19. `stopJob` on a blocked job makes it `stopped`, and `jobInterrupts` then returns an empty list.
20. A job spends, and `getCost()` called afterwards in the starting program includes the amount.

Case 16 needs the job to spend at a known moment, after the guard's block has ended. Do not use a sleep for that. Have the child wait for a file the test creates, the way the shell job tests in `lib/host/node/nodeSubprocess.test.ts` do, so the clock never decides the order. Every other case waits with `jobOutput(id, wait: ...)`, which returns when the job blocks or ends.

One more case belongs in the unit test file `lib/stdlib/jobs.test.ts`, because it needs the job to change between two calls: `_resumeJob` given a `PreparedResume` whose interrupts are no longer the job's pending ones throws, and the job stays blocked.

---

## Task 7: `askVerdict`, `currentPolicy`, and the resume approval

**Files:**
- Modify: `stdlib/policy.agency`
- Tests: the existing policy tests in `tests/agency-js/cli-policy-handler*/` and `tests/agency/policy-*/`

Read the spec's decision 8.

### `askVerdict`: move, do not rewrite

`_handler` (`policy.agency:1329`) asks the user in its last third. Cut it at the line `const answer = askUser(intr)` and move everything from there to the end of the function into a new exported function, without changing a line inside it:

```agency
/**
Ask the user about one interrupt at the terminal and return their verdict,
as a handler would return it. `_handler` calls this when no rule decides.
Code that answers a blocked background job calls it once for each pending
interrupt.
*/
export def askVerdict(intr: any): any {
  // the moved code
}
```

The comments move with the code they describe.

### The resume approval

`_handler` ends with the non-interactive block and then the code that moved. Its new ending is:

```agency
if (intr.effect == "std::jobs::resume") {
  return approve()
}
return askVerdict(intr)
```

The order matters. The rule check above still runs first, so a rule that rejects `std::jobs::resume` rejects it. The non-interactive block above still runs first, so a run with nobody at the terminal rejects it.

### `currentPolicy`

```agency
/**
The rules `cliPolicyHandler` is working with right now, including every
"always" answer given so far. A background job is started with these, and
resumed with these, so it runs under the session's rules.
*/
export def currentPolicy(): Policy {
  """
  Return the approval rules the CLI policy handler holds right now, or an empty policy when no handler is installed.
  """
  return _policy ?? {}
}
```

It does not load the policy file. The handler loads it on the first interrupt it sees, and a job in `agency agent` is started by a tool call whose own interrupt has been through the handler by then.

Nothing else in `_handler`, `applyRule`, or `askUser` changes. A job's interrupts never reach them.

### Tests

The existing policy tests must pass unchanged. They are the check that the move changed nothing. Add:

- `std::jobs::resume` is approved with no prompt in an interactive run.
- A rule that rejects `std::jobs::resume` rejects it.
- A non-interactive run rejects `std::jobs::resume`.
- `currentPolicy()` returns the policy the handler was seeded with.
- `currentPolicy()` returns the empty policy before `cliPolicyHandler` is called.

A handler function can be called directly with an interrupt-shaped object, so these need no child process.

**This is the end of the first PR.** Do task 11's docs for these seven tasks, then "How to test".

---

## Task 8: `startJob` starts an `agency run` line as an Agency job

**Files:**
- Modify: `stdlib/agency.agency`
- Modify: `stdlib/safeBash.agency`
- Test: `tests/agency/jobs.agency`

`cli()` in `stdlib/agency.agency` is the one place that knows the shape of an `agency` command line: `["run", file]`, with a file that is not a flag. `startJob` must not take that shape apart a second time. Add one function beside `cli`, which reads the shape the same way `cli`'s own `match` does:

```agency
/** The file an `agency run <file>` line names, or null for any other
  line. `cli` runs such a line in the foreground through `cliRun`. */
export idempotent def cliRunFile(args: string[]): string | null {
  """
  Return the file an Agency run command names, or null when the arguments are not a run command.
  """
  return match(args) {
    ["run", file] if (!file.startsWith("-")) => file
    _ => null
  }
}
```

In `startJob`, after `approvedPlan` returns, the code checks for a plan of kind `bash` and otherwise runs the plan in the foreground. Add one case between them:

```agency
if (exec is { kind: "agency", args }) {
  const file = cliRunFile(args)
  if (file != null) {
    const started = runFileInBackground(dir, file, "main", wallClock: minutes * 60000, policy: currentPolicy())
    if (started is failure) {
      return started
    }
    return success(startedMessage(started.value))
  }
}
```

`minutes` is the value `startJob` already computes from `maxMinutes`, and `minutes * 60000` is how the line above it already turns it into milliseconds.

`currentPolicy` is imported from `std::policy`. `stdlib/safeBash.agency` does not import that module today, and `std::policy` imports `std::shell`. Check that the new import makes no cycle the compiler refuses. If it does, stop and ask: the spec lists this import as an open decision.

`runFileInBackground` raises `std::runInBackground`. Add that effect to the `SafeBashEffects` set (`stdlib/safeBash.agency:4454`).

Every other `agency` line still reaches `runPlanned` and runs in the foreground.

Update `startJob`'s docstring. It says an agency command runs in the foreground however long it takes. It should say that `agency run <file>` becomes a job and other agency commands run in the foreground.

### Tests

In `tests/agency/jobs.agency`:

- `startJob("agency run <a fixture file>")` returns the started message and one job is listed.
- `foregroundForAgencyCommands` still passes: `agency typecheck` runs in the foreground.

---

## Task 9: the REPL prints a line when a job blocks

**Files:**
- Modify: `lib/stdlib/cliJobLine.ts`
- Modify: `lib/stdlib/cli.ts`
- Test: `lib/stdlib/cliJobLine.test.ts`

### The line

```ts
/** "job-3fa9c1 is waiting for your answer. Type /jobs answer job-3fa9c1" */
export function jobBlockedLine(job: JobSummary): string
```

### Showing it

`jobEndLines` has `jobEnded(job)`, which builds a line and then writes it, holds it, or puts it above the prompt, depending on what owns the terminal. Move that second half into one inner function that takes a line. Then add `jobBlocked(job)` to the returned object, which calls it with `jobBlockedLine(job)`.

In `_runLineRepl`, beside the `onJobEnd` call:

```ts
const stopWatchingBlocked = onJobBlocked(replCtx.jobs, jobLines.jobBlocked);
```

Call `stopWatchingBlocked()` in the `finally`, beside `stopWatchingJobs()`.

`cli.ts` is 1,955 lines long. The linter's `max-lines` rule allows 1,250 and does not count blank lines or comments (`eslint.config.js:140`), and the jobs PR found the file close to that limit. Run `npx eslint lib/stdlib/cli.ts` after this change. If it objects, the fix is in `cliJobLine.ts`: have `jobEndLines` take the table and register both listeners itself, returning one function that removes both.

### Tests

In `cliJobLine.test.ts`:

- The blocked line goes above a prompt and keeps what was typed.
- The blocked line is held while something else owns the terminal.

---

## Task 10: `/jobs answer` and the blocked row

**Files:**
- Modify: `lib/agents/agency-agent/lib/slashCommands/jobs.agency`
- Modify: `lib/agents/agency-agent/lib/commandPalette.agency`
- Test: `lib/agents/agency-agent/tests/jobsSlash.agency`

### Answering

```agency
def answerFromSlash(id: string): boolean {
  const pending = jobInterrupts(id)
  if (pending is failure(why)) {
    pushMessage(why)
    return true
  }
  if (pending.value.length == 0) {
    pushMessage("${id} is not waiting for an answer.")
    return true
  }
  const answers = map(pending.value) as intr {
    return askedAnswer(intr)
  }
  const resumed = resumeJob(id, answers, policy: currentPolicy())
  if (resumed is failure(why)) {
    pushMessage(why)
  }
  return true
}

// Asks the user about one pending interrupt and returns their answer in
// the shape resumeJob takes.
def askedAnswer(intr: PendingInterrupt): JobAnswer {
  const verdict = askVerdict(intr)
  return {
    interruptId: intr.interruptId,
    action: verdict.type,
    value: verdict.value
  }
}
```

`map` calls the block for one interrupt at a time, in order, so the prompts appear one after another.

`currentPolicy()` is read after the prompts. An "always approve" the user gave in one of them is a rule by then, so the resumed job has it.

`askVerdict` draws the usual approval prompt. Escape there rejects the prompt's promise with an `AgencyCancelledError` (`cli.ts:736`). A slash command runs inside the same `onSubmit` call a turn does, and the REPL's `catch` around that call prints "cancelled" for an abort error and prompts again (`cli.ts:1586`). So `resumeJob` is never reached and the job stays blocked. This comes from reading the code, and the by-hand list has a step for it.

`resumeJob` raises `std::jobs::resume`. The session's policy handler approves it with no prompt, by task 7.

In `jobsSlashCommand`, route `answer <id>` to `answerFromSlash`, the way `stop <id>` is routed. Update `USAGE` and the palette's description of `/jobs`.

### The list

`listedJobs` prints one row per job. For a blocked job, add each message from `waitingOn` on its own line under the row, indented.

### The model

No change to `jobsNote.agency`. It lists jobs that are running or unread, and a blocked job is neither. Confirm this with a test.

### Tests

In `lib/agents/agency-agent/tests/`:

- `/jobs answer` on a job that is not blocked says so.
- `/jobs answer` on an unknown id prints the failure that lists the jobs.
- `/jobs` shows a blocked job's question.
- `jobsNoteText` returns an empty string when the only job is blocked.
- `startJob` with an `agency run` line, under a session policy that approves the child's effect: the job runs to the end without blocking. Under a session policy with no rule for it: the job blocks, and no prompt opens.

The prompt itself needs a terminal. It is in the by-hand list in "How to test".

---

## Task 11: docs

Dev docs record the mechanism and its rules. They do not record how the work went.

**With the first PR:**

- `docs/dev/stdlib/jobs.md`: the two kinds of job, the blocked state, the job's policy and the rule that no parent handler answers a job's interrupts, why the start has its own effect, how a job's cost is counted, and `jobInterrupts` and `resumeJob`.
- `docs/dev/runtime/subprocess-ipc.md`: the session's wiring, and that a waiting `run()` answers the child's interrupts with the handler chain while a job answers them with its policy. This doc's index line in `CLAUDE.md` says the parent's handlers extend into a subprocess. Say in the doc that this holds for `run()` and not for a job.
- `docs/dev/agents/approval-policies.md`: `askVerdict`, `currentPolicy`, and the `std::jobs::resume` rule.

**With the second PR:**

- `docs/dev/agents/user-commands.md`: `/jobs answer`.
- `docs/dev/stdlib/jobs.md`: the blocked line in the REPL, and that a job in the agent has the session's rules as of its start or its last resume.
- `docs/dev/stdlib/safe-bash.md`: `startJob` and `agency run`.

No new file is added to `docs/dev/`, so the index in `CLAUDE.md` does not change. Check that each description there is still true, and change the one for `jobs.md` if it is not.

`make` regenerates the stdlib pages under `docs/site/stdlib/` from the docstrings. Do not edit those by hand.

---

## How to test

Do this once per PR, after every change for that PR is made. Save each command's output to a file, and read the file when something fails.

**First PR:**

1. `make`. Tasks 5, 6, and 7 change stdlib `.agency` files.
2. `pnpm run typecheck`.
3. `pnpm run lint:structure`.
4. Prettier, by name, on each TypeScript file touched.
5. The unit tests for the files touched: `lib/runtime/ipc.test.ts`, `lib/runtime/ipcChild.test.ts`, `lib/runtime/jobs/jobTable.test.ts`, `lib/runtime/jobs/agencyJob.test.ts`, `lib/stdlib/jobs.test.ts`.
6. The Agency tests, each with `--check-capabilities` after the path:
   - `tests/agency/agencyJobs.agency`
   - `tests/agency/jobs.agency`, which must pass unchanged
   - the files in `tests/agency/subprocess/`, which must pass unchanged
   - the policy tests in `tests/agency/policy-*/`
7. The Agency-js tests in `tests/agency-js/cli-policy-handler*/`.

**Second PR:**

1. `make`. Tasks 8 and 10 change `.agency` files.
2. `pnpm run typecheck`, `pnpm run lint:structure`, and prettier on the two TypeScript files.
3. `lib/stdlib/cliJobLine.test.ts` and `lib/stdlib/cli.test.ts`.
4. `tests/agency/jobs.agency`, `tests/agency/safeBash.agency`, and the agent tests `jobsSlash.agency`, `jobsNote.agency`, and `commandPalette.agency`, each with `--check-capabilities`.

Do not run the whole Agency test suite locally. CI runs it.

**By hand, in `agency agent`, after the second PR.** These need a terminal and a live model:

- Ask the agent to run a small Agency program in the background, one that writes a file. The start asks for approval once. With no rule for the write, the blocked line appears above the prompt.
- `/jobs` shows the job as blocked, with its question.
- `/jobs answer <id>` shows the usual approval prompt. Approving lets the job finish, and the finish line appears.
- Answer "always approve" there. A second write from the same job does not block it, and nothing is printed over the prompt when the rule approves it.
- Press Escape at the first prompt of `/jobs answer`. The REPL prompt returns and the job is still blocked.
- Let a job block while the slash menu is open. The line appears after the menu closes.
- Press Escape during a turn while a job runs. The job keeps running.
- Start a job in one turn and let it raise several turns later. It blocks, and is not rejected.
- Quit while a job is blocked. `pgrep` finds no child left.

## What is not in this plan

The spec's section "What this does not cover" lists these, and none of them is built here:

- A job whose interrupts reach the parent's handlers.
- A policy that follows the session live.
- Messages between a job and its parent.
- A subagent as a background job.
- `agency test` in the background.
- A blocked job that survives quitting the agent.
- A background run started from inside a subprocess.
- Input to a shell job.
