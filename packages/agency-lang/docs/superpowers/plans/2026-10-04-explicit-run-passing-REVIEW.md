# Review: passing the run explicitly

This is a review of `2026-10-04-explicit-run-passing.md`. It was checked
against main at `ad1d7ec9b` on 2026-10-04. Paths are relative to
`packages/agency-lang`.

## Verdict

The design is right and the work should go ahead. Passing the run as an
argument gives each function the same values the hidden variable gives it
today, and that includes handler functions. Keeping `AsyncLocalStorage` in
place while every read is compared against it is a sound way to make a
change of this size.

The plan needs seven changes before work starts. The first two are in
Phase 1 and both affect handlers.

1. [Task 3 would make a parent reject every interrupt a subprocess raises.](#1-task-3-would-reject-every-subprocess-interrupt)
2. [Task 2 can turn off three limits without any error.](#2-task-2-can-turn-off-three-limits-without-any-error)
3. [The rule in Task 8 is wrong for three stored callbacks, and `sameRun` cannot check any of them.](#3-the-rule-in-task-8-is-wrong-for-three-stored-callbacks)
4. [Phase 2 cannot pass the Agency-js suite, because the handle it needs arrives in Phase 3.](#4-phase-2-needs-the-handle-from-phase-3)
5. [`__call` is one of five places where the runtime calls a plain function.](#5-five-places-call-a-plain-function)
6. [`sameRun` checks less than the plan says it does.](#6-samerun-checks-less-than-the-plan-says)
7. [The wrong-run check has been tried only on a model that leaves out the hard cases.](#7-the-wrong-run-check-is-untested-on-the-real-runtime)

Decision 5 has an answer [below](#decision-5): rename, and keep the old name
exported for one release.

## 1. Task 3 would reject every subprocess interrupt

This is how a parent process runs its handlers for an interrupt that a
subprocess raised:

```ts
// lib/runtime/ipc.ts:877
async function handleInterruptMessage(s: RunSession, msg: any): Promise<void> {
  try {
    const { outcome } = await s.ctx.statelogClient.runInBranchContext(
      s.ctx.statelogClient.snapshotStack(),
      () => gatherChainOutcome({ ... }, s.ctx, s.stateStack, msg.interruptId),
    );
    trySendDecision(s, { type: "decision", interruptId: msg.interruptId, outcome });
  } catch (err) {
    trySendDecision(s, {
      type: "decision",
      interruptId: msg.interruptId,
      outcome: { kind: "rejected", value: `Parent handler error: ...` },
    });
  }
}
```

This function runs from the child's `message` event (`ipc.ts:1262`). The
comment at `ipc.ts:1124` says that code runs outside any `agencyStore`
frame. `handleCallbackMessage` installs `s.parentStore` for that reason
(`ipc.ts:1145`). `handleInterruptMessage` installs nothing.

It works today because the reads are lenient. `runHandlerChain` reads a
missing depth as 0 (`interrupts.ts:257`), and `executingHandlers()` returns
an empty list.

After Task 2, `runInBranchContext` needs a frame to copy. After Task 3,
`runHandlerChain` throws when there is no frame. The `catch` above turns
that throw into a rejection, so the parent rejects every interrupt from a
subprocess with "Parent handler error".

The plan does not remove or redesign the path that carries a subprocess
interrupt to the parent. The message still arrives, and the handlers are
still found, because they live on `ctx.handlers` and not in the frame. The
break is one missing step: the chain throws before it asks the first
handler.

Nothing is approved by mistake. A parent rejection is final in the child
(`interrupts.ts:439`), so the subprocess cannot do anything that needs
approval. The tests under `tests/agency/subprocess/` should fail, for
example `vote-child-reject-parent-approve.agency`.

The problem is the plan's description of Task 3. It says the only callers
with no frame are unit tests.

Change the plan:

1. Before Task 3, list the production code that runs with no frame. The
   message handlers in `ipc.ts` are one group. The fallbacks that skip the
   frame when there is no outer one are another: `runBatch.ts:438`,
   `toolInvocation.ts:58`, `toolInvocation.ts:82`, `toolInvocation.ts:107`,
   `runner.ts:187`, and `agencyFunction.ts:297`.
2. Say which frame `handleInterruptMessage` installs. The natural choice is
   `s.parentStore`.
3. Decide the case below and add a test for it.

Installing `s.parentStore` changes which handlers are asked. Suppose a
handler body starts a subprocess, and the subprocess raises an interrupt.
Today the parent's chain runs with an empty executing list, so that handler
is asked about the interrupt. With `s.parentStore` installed, and the
executing list folded into the frame by Task 2, the chain sees that handler
as executing and skips it.

Skipping it matches what happens when a handler body raises an interrupt in
the same process. It is still a handler that is asked today and skipped
afterwards, in a phase titled "No behaviour change". `CLAUDE.md` asks for
every case where a handler could be skipped to be flagged, so this one needs
an explicit decision from the owner.

To keep today's behaviour exactly, install the stored frame with the two
values reset:

```ts
agencyStore.run({ ...s.parentStore, executingHandlers: [], handlerChainDepth: 0 }, ...)
```

Every parent handler is then asked about every subprocess interrupt, as it
is today. This is the right choice for Phase 1. Whether a handler should
hear interrupts from a subprocess its own body started can be decided later,
as its own change with its own test.

## 2. Task 2 can turn off three limits without any error

Every step of every function installs this frame:

```ts
// lib/runtime/runner.ts:190, inside Runner.runInScope
return agencyStore.run(
  {
    ctx: this.ctx,
    stack: this.stack,
    threads: this.threads,
    globals: outer?.globals ?? this.ctx.globals,
    toolInvocationStack: outer?.toolInvocationStack,
    decisions: outer?.decisions,
    callsite: { ... },
    runner: this,
  },
  fn,
);
```

The frame is built from scratch. It names each field it wants and copies
nothing else.

Today that is harmless for the five small values, because they live in their
own variables and `agencyStore.run` does not touch them. After Task 2 they
are fields of the frame. A frame built this way drops them unless the code
is changed to copy them.

If `runInScope` drops them:

- A handler body that calls a function loses the executing-handler list at
  that function's first step. An interrupt raised below that point is sent
  back to the handler that is running. The list exists to prevent that.
- The handler chain depth restarts at 0 on the same step, so the limit of 10
  does not stop the recursion either.
- The call depth restarts at every step, so `maxCallDepth` never trips.

None of these fails at the place where the value is lost. Task 3 does not
catch them, because a frame exists.

Task 2 names six files. It leaves out the eight places that build a frame
from scratch:

| Where | Line |
| --- | --- |
| `Runner.runInScope` | `lib/runtime/runner.ts:190` |
| `runInBranchAlsFrame` | `lib/runtime/runBatch.ts:471` |
| `withResumableScope` | `lib/runtime/resumableScope.ts:181` |
| `runNode`, three frames | `lib/runtime/node.ts:295`, `448`, `500` |
| `runInTestContext` | `lib/runtime/asyncContext.ts:270` |
| `runInBootstrapFrame` | `lib/runtime/asyncContext.ts:300` |

Generated code avoids the same mistake by copying the outer frame first. The
comment at `lib/ir/builders.ts:584` explains that without the copy,
`globals`, `callsite`, and `runner` would be reset.

Change the plan:

1. In Task 2, make the five fields required in the type, as they are in the
   `Run` type later in the plan. The compiler then reports every frame built
   from scratch.
2. For each place in the table, write down whether it copies the five values
   from the outer frame or starts them fresh. Today every one of them keeps
   the values.
3. Check that `tests/agency/handlers` has a test where a handler body calls
   a function, and that function raises the effect the handler handles. Add
   one if it is missing. It is the test that fails if a step drops the list.

Three details of folding the values in:

- **`spans` is changed in place.** `startSpan` pushes onto the array it finds
  (`lib/statelogClient.ts:284`). The root frame's `spans` must be the
  client's own `rootStack` array. It must not be a new empty array. Posts
  made after the run's frame has ended read `rootStack`
  (`statelogClient.ts:246`), and a subprocess puts its parent's span at the
  bottom of it (`statelogClient.ts:300`).
- **`runInBranchContext` does nothing when observability is off**
  (`statelogClient.ts:275`). Keep that.
- **`isInsideCallback()` asks whether the variable has a value**
  (`lib/runtime/hooks.ts:158`). An `activeCallbacks` array is always
  present, so the function has to ask whether the array is empty. The runner
  uses the answer to put off an external pause.

## 3. The rule in Task 8 is wrong for three stored callbacks

Task 8 says each stored callback "closes over the run that was current when
it was stored". Today these callbacks read the frame that is current when
they are called. For the subprocess session handlers the stored frame is the
right one, and `handleCallbackMessage` already uses it. Three other
callbacks depend on the frame at call time.

**The memory manager.**

```ts
// lib/runtime/state/context.ts:595
// Read the ACTIVE branch stack dynamically on each
// access (not a captured one): this manager is cached per
// configKey and shared across concurrent branches, so each
// branch's get/set must resolve to ITS own stack.
get: () => {
  const s = agencyStore.getStore()?.stack ?? this.stateStack;
```

One manager serves every fork branch. If it kept the run from when it was
created, every branch would read and write the first branch's memory id.
Each manager method needs the run passed in per call.

**`makeLazyCallbackRef`** (`lib/runtime/revivers/functionRefReviver.ts:236`).
It builds a function while a checkpoint is being restored. The function
forwards to the real callback when someone calls it (line 254). The run at
restore time belongs to a bootstrap frame, whose thread store throws on use.
The function should pass on the run its caller gives it.

**Console capture** (`lib/stdlib/ui.ts:276`). The override sends each
`console.log` to the transcript of the REPL whose frame is current. A
`console.log` call from arbitrary code carries no run. Without the hidden
variable, two REPLs running at once cannot each capture their own output.
The plan should say that this behaviour is lost, and which transcript gets
the output.

`sameRun` cannot check any stored callback. It compares the stored object
with the current frame. By the time a stored callback fires, the current
frame is a deeper one, so the two are never the same object.

Change the plan:

1. Replace the one rule in Task 8 with a table of the 11 places. For each,
   say whether it uses the stored run or the caller's run.
2. For each, say what Phase 2 compares. It has to be the value the callback
   reads, for example `stored.stack === agencyStore.getStore()?.stack`.
3. Change the Phase 2 exit check. It allows reads of `agencyStore` only in
   `sameRun` and the installers, and these comparisons are a third kind.

## 4. Phase 2 needs the handle from Phase 3

```js
// tests/agency-js/agent-session-resume/loop.js
export async function fakeRepl(onSubmit) {
  for (const line of process.env.LINES.split(",")) {
    await __call(onSubmit, { type: "positional", args: [line] });
  }
}
```

Task 9 changes `__call` to take the run first. That is in Phase 2. On the
second pass through its loop, this helper calls `__call` after an `await`,
where `currentRun()` throws. The fix is `agency.current()` and `run.call`, which
Task 13 adds in Phase 3. Task 13 is also where the plan updates this file.
So the Agency-js suite cannot pass at the end of Phase 2.

The same applies to `agency.*`. The Phase 2 exit check allows no read of
`agencyStore` outside `sameRun` and the installers, so `agency.*` must read
`currentRun()` by then. Nine test helpers call `agency.*`: eight under
`tests/agency/ts-helpers/` and `tests/agency-js/queue-message/tools.js`.
Any of them that does so after an `await` needs the handle in Phase 2.

Users are affected too. Between the two merges, main would tell a user that
their helper is wrong and offer no replacement.

Change the plan: move Task 13 into Phase 2, before Task 10.

## 5. Five places call a plain function

The plan sets the current-run variable in `__call`. The runtime calls plain
functions from four more places. A helper reached through any of them finds
the variable unset.

| Where | Line | What it calls |
| --- | --- | --- |
| `__call` | `lib/runtime/call.ts:124` | An imported function. |
| `__callMethod` | `lib/runtime/call.ts:222` | A method on a JavaScript object. |
| `invokeCallback` | `lib/runtime/hooks.ts:198` | A callback passed from TypeScript, or a global hook from a package. |
| `runHandlerChain` | `lib/runtime/interrupts.ts:308` | A handler registered from TypeScript with `agency.withHandler`. |
| `AgencyFunction.invoke` | `lib/runtime/agencyFunction.ts:214` | `_fn`. The comment above it says this may be imported TypeScript. |

Change the plan:

1. Put the set-and-restore in one function, and call it from all five
   places.
2. Restore the previous value in a `finally`. The plan says the variable is
   cleared. Clearing breaks a helper that makes a call and then reads the
   run, all before its first `await`:

   ```ts
   export function helperA() {
     const run = agency.current();
     run.call(helperB); // sets the variable for helperB, then clears it
     agency.addCost(1); // helperA has not awaited yet, and the variable is gone
   }
   ```

   This example assumes `run.call` sets the variable for a plain function.
   See "A helper that calls another helper" under Smaller points.

3. Say how `AgencyFunction.invoke(run, ...)` knows whether `_fn` takes the
   run as its first argument. Either every `fn` takes it, including the ones
   written by hand in `functionRefReviver.ts` and `lib/stdlib/agency.ts:92`,
   or the function carries a flag.
4. Rule 1 gives every handler function the run as its first parameter.
   `agency.withHandler(handler, fn)` is public, and its `HandlerFn` takes
   only the interrupt (`lib/runtime/types.ts:43`). Say whether handlers
   written in TypeScript change shape. If they do, that is a second breaking
   change next to Decision 6.

## 6. `sameRun` checks less than the plan says

The plan says the suites, with the check on, test "that the run the code was
handed is the run it would have found". There are three gaps.

### An installer can be handed the wrong run

```ts
const child: Run = { ...run, stack: branch.stack };
return agencyStore.run(child, () => fn(child));
```

If `run` is the wrong run here, the child is made from it and then
installed. Everything inside agrees with `AsyncLocalStorage`, and the check
passes. `AsyncLocalStorage` is right only while each installer makes its
child from the frame that main would have used. Each installer must call
`sameRun(run)` on its own argument before it makes the child.

`Runner.runInScope` is the installer where this matters most. Today it
takes `stack` and `threads` from the Runner. It takes `globals`,
`toolInvocationStack`, and `decisions` from the frame that is current when
the step starts (`runner.ts:189`). The plan's example gives `step` no run:

```ts
await runner.step(1, async (runner, __run) => { ... });
```

So the step's run has to come from the run the Runner was built with. For a
step nested inside another step, the current frame is the outer step's
frame, which is a different object. `sameRun` fails there on every nested
step.

Say where a step's run comes from. Either generated code passes `__run`
into `step`, or the Runner keeps track of the run of the step it is in. I
recommend passing it. A body that forgot to declare `__run` then fails at
its first nested step, because it passes the outer run. If the Runner keeps
track, that body's direct reads use the outer run and nothing checks them.

### Generated code is an installer, and it reads fields directly

Generated code installs two frames of its own: one around each function body
(`lib/ir/builders.ts:588`) and one around an `async` call
(`lib/backends/typescriptBuilder.ts:2761`). In Phase 2 both have to stay,
and each has to install the same object that it passes. Phase 3 removes
them. The fixtures are therefore rebuilt in Phase 2 and again in Phase 3.
Task 12 does not mention the second rebuild.

Generated code also reads fields directly, such as `__run.globals`. The
plan says the check runs "at every read". Either generated code wraps those
reads in `sameRun` during Phase 2, or they are unchecked and rule 2 is the
only protection. Say which.

Rule 2 can be enforced when the code is generated. Add a check that every
function body handed to the runtime declares `__run`: steps, hooks,
conditions, loop bodies, pipe stages, fork blocks, and handlers. Rule 2
lists four of these as examples, and a condition or a hook is as easy to
miss.

### Reads that accept a missing frame

About 30 reads look like this and treat a missing frame as a normal answer:

```ts
// lib/runtime/memory/manager.ts:52
function recordMemoryUsageIfInFrame(observation: UsageObservation): void {
  if (!agencyStore.getStore()) return;
```

Other examples:

- `agency.ctxMaybe()` returns `undefined` (`lib/runtime/agency.ts:80`).
- `StatelogClient.post` redacts with the top-level globals
  (`statelogClient.ts:1582`).
- `withPushedHandler` registers the handler with no live guards
  (`lib/runtime/asyncContext.ts:157`).

After Phase 3, a helper that has passed its first `await` looks the same to
these reads as code outside any run. The plan's own objection to PR #1167
is that "some reads treat a lost context as a normal answer".

Phase 2 is the only time the two cases can be told apart. During Phase 2 a
lost run shows up as a frame in `AsyncLocalStorage` with the variable unset.
Change the plan so that `currentRun()` and its lenient form both throw in
that case during Phase 2.
The suites then find each of these reads. Each one a helper can reach should
end Phase 2 either strict or taking a run.

## 7. The wrong-run check is untested on the real runtime

The prototype's README says: "It has no threads, guards, cost accounting,
race, tool calls, subprocesses, or async function calls." Its check is one
field on each run:

```ts
// scripts/explicit-context-spike/explicit/runtime.ts
status: "live" | "parked" | "closed";
```

Entering a function sets the caller to `parked`. Leaving sets the caller
back to `live` and the callee to `closed`.

The plan does not answer these questions about the real runtime:

1. **Which operations check the state?** "Throws if anything uses it" cannot
   include the runtime's own code. `runBatch` uses the parent's run to log
   and fire hooks while its branches are running.
2. **What does a copy do with the state?** The plan's example,
   `{ ...run, stack: branch.stack }`, copies the parent's state into the
   child.
3. **What is changed in place?** The plan says a `Run` is never changed, and
   Decision 4 says the check costs one field write per call. `state` and
   `spans` are both changed in place. Say so on the type.
4. **Two waits at once.** One field cannot record two waits that overlap.
   When the first ends, the run is `live` while the second is still going.
5. **`async` calls.** The plan says the caller cannot be marked as waiting.
   The callee also must not touch the caller's state when it leaves. In the
   prototype's code, a callee that outlives its caller's step would set a
   closed run back to `live`.
6. **Stored callbacks.** They hold a run that is `parked` or `closed` by the
   time they fire. The subprocess session handlers fire while the run that
   started the subprocess is waiting for it.
7. **Race losers.** They keep running after the parent has moved on
   (`runner.ts:1279`).
8. **Two calls through one handle.** A helper that runs
   `Promise.all([run.call(a), run.call(b)])` makes the second call on a
   parked run. Is that an error?
9. **Background work.** A helper that starts work and returns before it
   ends leaves that work holding a closed run. Today the frame keeps
   working. If this becomes an error, `ts-helpers.md` has to say so.

Change the plan:

1. Write the answer to each question into the design section.
2. In Task 6, add `sameRun` first and get the suites green. Then add the
   `state` check as its own commit, while `AsyncLocalStorage` is still in
   place. A failure then points at one check.
3. Confirm Decision 4 after Phase 2. It was made on the prototype's result.
   If the real runtime needs many exemptions, the check protects less than
   the decision assumed.

## Safety features in the guide

The plan removes none of the safety features that `docs/site/guide/`
describes. It changes how the runtime finds its state. It does not change a
rule. The features fall into two groups.

### Features that do not read the frame

The plan cannot affect these, because none of them reads the hidden
variable.

| Feature | Guide page | Where it lives |
| --- | --- | --- |
| Every handler is asked, and one reject wins | `handlers.md` | `ctx.handlers`, walked in `runHandlerChain` |
| `with approve` and `.preapprove()` cannot override an outer reject | `handlers.md` | The same walk |
| Policies, `--policy`, `--approve`, `--reject`, `--interactive` | `policies.md` | Handlers on `ctx.handlers` |
| `raises` and effect sets | `effects-and-raises.md` | The type checker |
| A callback cannot raise an interrupt | `callbacks.md` | The type checker |
| Checkpoints, the checksum, refusing a resume when the code changed, `maxRestores` | `checkpointing.md` | `ctx.checkpoints` and the checkpoint itself |
| `destructive` and `idempotent` tools, `maxToolCallRounds` | `llm-part-2.md` | The result and the tool loop's saved state |
| A run cannot pause in the middle of a handler | `handlers.md` | `StateStack.executingHandlerEntries` |
| Each run has its own globals | `state-isolation.md` | A context made per run in `runNode` |
| Subprocess cost metering and resource limits | `guards.md` | The IPC session, with `ctx` and the stack passed explicitly |

### Features that read the frame

The design keeps each of these. Each one is also a place where a mistake in
the implementation weakens the feature without an error. The findings above
cover them.

| Feature | Guide page | What it reads | Covered by |
| --- | --- | --- | --- |
| A handler does not hear its own raises | `handlers.md` | The executing-handler list | Finding 2 |
| The handler recursion limit | `handlers.md` | The handler chain depth | Finding 2 |
| `maxCallDepth` | `agency-config-file.md` | The call depth | Finding 2 |
| A callback does not call itself again | Not in the guide (`lib/runtime/hooks.ts:152`) | The active-callback list | Finding 2 |
| A pause waits until a callback has finished | `interrupts-from-typescript.md` | The active-callback list (`runner.ts:398`) | Finding 2 |
| A parent's handlers answer a subprocess's interrupts | `why-agency.md` | No frame today | Finding 1 |
| Each fork branch has its own globals | `state-isolation.md`, `concurrency.md` | The frame's `globals` | Finding 6 |
| A cost or time guard applies to its branch | `guards.md` | The frame's `stack` | Finding 6 |
| A tool body has its own message thread | `message-threads.md` | The frame's `threads` | Finding 6 |
| Redaction of values tagged in a branch | `tags.md` | The frame's `globals` | Smaller points |

Finding 2 names three limits. The active-callback list is a fourth value
that a frame built from scratch would drop, and it guards the two callback
rows above.

### Three additions from reading the guide

**The current-run variable is shared by every run in the process.** The
guide promises that five requests calling one agent at once each get their
own state. Today each request's frame follows its own chain of `await`s, so
one request cannot read another's. Under the plan there is one variable for
the whole process. It is safe because it is set and restored inside one
synchronous call. If a throw ever skips the restore, the next helper to run
reads the other request's run: its globals, its thread, and its handlers.
This is why the restore in finding 5 must be in a `finally`, in one function,
with a test that throws from a helper and then checks the variable.

**Memory spending can stop counting against a cost guard.**
`recordMemoryUsageIfInFrame` returns without charging when it finds no frame
(`lib/runtime/memory/manager.ts:53`). It runs after the awaited provider
call. If it is converted to a lenient read of the current-run variable, it
finds nothing after that `await`, and memory spending is never charged. The
guard does not trip and nothing reports an error. `agency.addCost` does not
have this problem, because it throws when it finds no run. This was listed
under Smaller points. It belongs with finding 6.

**The guide documents `getRuntimeContext()` and patterns that will throw.**
`guards.md` and `ts-helpers.md` both tell users to read the abort signal
with `getRuntimeContext()`. That is how a TypeScript helper stops when a
time guard trips. Decision 5 with no alias breaks that code, and Task 16
lists `ts-helpers.md` but not `guards.md`.

Most examples in `ts-helpers.md` call `agency.*` after an `await`:

```ts
const { tokens, cost } = await myCustomLLM(prompt);
agency.addCost(cost);
```

```ts
await agency.withCostGuard(0.05, async () => {
  await agency.llm("Be brief: " + question);
  await agency.llm("Now elaborate slightly: " + question); // after an await
});
```

Under the plan these throw and name `agency.current()`. Nothing is skipped
without an error, so no safety feature is lost. It is a larger breaking
change than Decision 6 describes, which mentions only `__call`. The same
applies to `withResumableScope`, `thread.with`, and `withHandler` bodies.

## Decision 5

Rename `getRuntimeContext()` to `currentRun()`, and keep the old name
exported for one release.

Inside this repo the rename is right. The function's meaning changes,
because it throws after the first `await`. Keeping the name would hide that
at 70 call sites.

Outside this repo there are published packages that import the old name.
Their peer ranges accept any newer runtime:

```json
// packages/kokoro/package.json
"agency-lang": ">=0.19.3"

// packages/lora/package.json
"agency-lang": ">=0.26.0"
```

Both packages import `getRuntimeContext` from `agency-lang/runtime`. With no
alias, an installed copy of either fails at import against the new runtime,
with an error about a missing export.

All three of their reads are on the first line of the function, before any
`await`. An alias that calls `currentRun()` keeps them working. Export the
old name for one release with a deprecation note. Raise the peer range in
the kokoro and lora releases that use the new name.

## Smaller points

- **The audit script is not on a branch.** The plan says it is on
  `spike/explicit-context`. It is an untracked folder in that branch's
  worktree: `.worktrees/explicit-context/packages/agency-lang/scripts/explicit-context-spike/`.
  The prototype is in the same folder. Cleaning up that worktree deletes
  both. Task 1 should name this path, and the folder should be committed
  somewhere first.
- **Two of the 12 small readers are not small.** Task 4 says they read the
  frame "only for a log line, a config flag, or the clock".
  `recordMemoryUsageIfInFrame` and `meteredMemoryDispatch` charge the cost
  guards on the branch's stack (`lib/runtime/memory/manager.ts:52`, `:64`).
  The manager is shared across branches, so it cannot hold the stack from
  construction. Move these two to Task 7.
- **`run.log` and posts outside a run.** Some posts are made after the run's
  frame has ended, such as `agentEnd` (`statelogClient.ts:172`). They need a
  named root logger. After that, remove the posting methods from
  `ctx.statelogClient`'s public type. A call site that Task 5 missed is then
  a compile error. Left in place, it would post with the top-level globals
  and skip the branch's redaction tags.
- **Task 9's template list.** `debugger.mustache` passes `__ctx` to
  `debugStep` and is not on the list.
- **A helper that calls another helper.** `async-context.md:105` says a
  helper that calls another `_foo` helper does not need to do anything
  about the frame. After an `await` that stops being true: the second
  helper's `currentRun()` throws. Say how the first helper makes the call.
  Either `run.call` also sets the variable for plain functions, or the
  second helper takes a run.
- **Task 14's lint.** It catches `currentRun()` written after an `await` in
  the same function. It misses the case above, where the function awaits
  and then calls a helper whose first line is `currentRun()`. The audit
  script already follows calls, so the lint can too.
- **`run.call(fn, ...args)` takes positional arguments only.** The
  descriptor it replaces also carries named arguments and a trailing block.
  Say whether `run.call` supports them.
- **The Phase 3 web view step.** It bundles the prototype's nine scenarios.
  The prototype's runtime imports nothing, so this step tests the prototype
  and says nothing about the real runtime, which the plan says still imports
  `fs` and `path`. Replace it with a check on the built runtime, or drop it.
- **The goal's fourth bullet.** "A function that needs the run and was not
  given one is a type error" holds for runtime functions. A helper that
  calls `currentRun()` after an `await` fails when it runs, and a `.js`
  helper has no type check at all.
- **Speed.** A run is now made on every call and every step, with 14 fields
  and a logger. Time the handler suite on main before Phase 2 and after it,
  and put both numbers in the PR.
- **Phase 2 can be split if the diff is too large.** `getRuntimeContext()`
  keeps working while `AsyncLocalStorage` is in place. Tasks 10 and 11 can
  merge as their own PR after Tasks 6 to 9.
- **Tests to add to Task 15.**
  1. A handler body calls a TypeScript helper. The helper awaits a timer and
     then raises the handler's own effect through the handle. The handler is
     skipped, as it is today.
  2. A helper makes two `run.call`s at once.
  3. A fork block writes a global and calls nothing. The parent's global is
     unchanged.
  4. A value tagged as secret inside a fork branch is redacted in a log post
     made from that branch.

## What was checked

These parts of the plan match the code:

- There are six `AsyncLocalStorage` instances: `asyncContext.ts:119`,
  `callDepth.ts:57`, `executingHandlers.ts:36`, `hooks.ts:152`,
  `interrupts.ts:229`, and `statelogClient.ts:167`.
- `lib/stdlib` has 70 calls to `getRuntimeContext()`.
- lora and kokoro are the only other packages that read the context.
- `loop.js` is the only test helper that imports `__call`.
- Every file, function, template, test folder, and script the tasks name
  exists.
- A handler body is a plain closure (`typescriptBuilder.ts:4002`) that the
  chain calls from the raiser's frame (`interrupts.ts:308`). Passing the
  chain's run as the first argument gives a handler the values it sees
  today.
- The argument for one module variable holds, given the restore in finding
  5. Promise continuations never run inside another call's synchronous
  part, so the variable is back to its old value before any other code runs.

These were not checked:

- The counts that come from the audit script: 595, 339, 208, 114, and 33.
  The script was not run.
- The test counts, 1763 and 189.
- No test was run for this review.
