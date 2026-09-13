# Pausing a run from outside

A TypeScript host can stop a running node at a statement boundary, keep its
state as a checkpoint, and continue it later.

```ts
import { main, isPaused, resumeFromCheckpoint } from "./agent.js";

const pause = new AbortController();
const result = await main({ pauseSignal: pause.signal });
// Elsewhere, while main() runs: pause.abort()

if (isPaused(result.data)) {
  const resumed = await resumeFromCheckpoint(result.data);
}
```

`result.data` is a `PausedCheckpoint`: `{ type: "paused", checkpoint, runId }`.
It is plain JSON, so a host can store it and resume in another process.

## How a pause happens

1. The caller passes `pauseSignal`, a standard `AbortSignal`, to a node export,
   `respondToInterrupts`, or `resumeFromCheckpoint`. The entry runs its body
   under `withExternalSignals` (`lib/runtime/externalSignals.ts`). When the
   signal fires, it sets `execCtx.pauseRequested`. Nothing else happens then.
   A model call or fetch in flight keeps going.
2. Every runner method that starts a statement calls `pauseIfRequested`:
   `step`, `hook`, `pipe`, `thread`, `handle`, `ifElse`, `loop`, `whileLoop`,
   `branchStep`, `fork`, and `debugger`. The call comes after `shouldSkip()`
   and before the statement does any work. In `step` and `hook` it also comes
   after the guard-trip raise.
3. If the context is cancelled, `pauseIfRequested` throws the cancel reason.
   If the statement cannot take a pause (see below), it returns and leaves the
   flag set. Otherwise it calls `pauseAtStep` (`lib/runtime/pause.ts`).
4. `pauseAtStep` awaits pending async calls, stamps a checkpoint at this step,
   logs `checkpointCreated` with reason `pause`, clears the flag, and throws
   `PauseSignal`. The step counter has not advanced, so a resume runs this
   statement.
5. `runNodeCore` and `runResumeLoop` catch the signal and return
   `pausedReturnObject(execCtx, signal)`. That builds the return object and
   pauses the trace writer. No `agentEnd` is emitted, because the run is not
   over.

Handlers are not consulted. A pause is not an interrupt.

`withExternalSignals` detaches both listeners when the body returns or
throws. A controller that outlives the run holds no reference to it.

## Why pending async calls are awaited first

An assignment like `const x = async fetchThing()` stores a `Promise` in the
frame locals. The resolved value reaches the frame only when
`pendingPromises.awaitAll()` runs the resolver. A promise does not survive
serialization, so a checkpoint stamped before `awaitAll` would resume without
the result. The user-facing `checkpoint()` function awaits pending calls for
the same reason (`lib/runtime/checkpoint.ts`).

## Why a thrown signal

Interrupts halt by returning an `Interrupt[]` that every generated call site
checks and passes upward. A second value shape would touch generated code
everywhere. `restore()` already unwinds by throwing `RestoreSignal`, so
`PauseSignal` shares its base class, `RunControlSignal`.

Every catch site that must let these signals through tests the base class:

1. The generated catch in every function body (`functionCatchFailure.mustache`).
2. The generated catch in every node body (`typescriptBuilder.ts`).
3. The `catch` in `__tryCall` (`result.ts`), so `try` does not turn a restore
   or a pause into a failed result.
4. Callback errors in `hooks.ts`.
5. The thread-end hook in `runner.ts`.

## Statements that cannot take a pause

The flag stays set in each of these cases, and the next statement that can take
the pause does.

- A handler body is executing (`StateStack.hasExecutingHandlers()`). Handlers
  have no step address, so a checkpoint taken inside one cannot be resumed.
- A callback body is executing (`isInsideCallback()` in `hooks.ts`), for the
  same reason.
- The runner is on a branch stack, or inside a tool call. Tool calls, forks,
  and parallel blocks run on branch stacks. When a branch raises an interrupt,
  the join point saves the branch's threads and globals and then stamps the
  checkpoint against the parent stack. A thrown pause would skip that join,
  so the pause waits. A pause requested during an `llm()` tool loop lands on
  the node statement after the `llm()` call. Issue #1046 tracks letting a
  pause land inside a branch.
- A guard trip is due at the same step. The trip is raised first, so its
  answer is recorded before the pause lands.

## Resume

`resumeFromCheckpoint` (`lib/runtime/interrupts.ts`) takes the whole
`PausedCheckpoint`. It refuses a value with no `runId`, and it keeps that id so
both halves show as one run in statelog.

It calls `runResumeInvocation`, the resume lifecycle it shares with
`respondToInterrupts`. That goes through `restoreForResume`, which checks code
fingerprints and installs the root policy handler and budget from the
`invocation` option. A host that started the run with a per-invocation policy
passes the same one on every resume, as it does for `respondToInterrupts`.

The loop is `runResumeLoop`, so a resumed run can finish, raise interrupts, or
pause again. `resumeFromCheckpoint` accepts no overrides. `rewindFrom` exists
for that, and it does not take the signals.

## Cancel and pause together

`abortSignal` and `pauseSignal` can both be passed, and cancel wins:

- If the abort signal is already aborted when the call starts, the call throws
  `AgencyCancelledError`.
- If the context is cancelled when a statement starts, the statement throws the
  cancel reason before it looks at the pause flag.
- If the abort lands while a call is in flight, such as a `sleep`, the call
  stops and the run unwinds as an `AgencyAbort` with a `userKill` cause.

## Out of scope

Exported functions called through `__invokeFunction` cannot be paused. That
path never enters `graph.run`, so the state stack has no current node id, and
`Checkpoint.fromStateStack` refuses to create a checkpoint.
