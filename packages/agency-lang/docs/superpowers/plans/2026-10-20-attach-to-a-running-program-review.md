# Review: attaching the debugger to a running program (plan)

Reviews `docs/superpowers/plans/2026-10-20-attach-to-a-running-program.md`
against `main` at `ef4872b8f`. Some findings correct the spec as well;
those are collected at the end so the spec edit can happen in one place.

## Summary

The three-PR split is right. Moving to `SIGUSR2` is right. The order
(runtime first, then the channel and host, then the CLI) is right.

PR 1 needs a different design before it starts. Five problems:

1. Installing a debugger on a program that is already running does not
   reach it. A run copies `debuggerState` when it starts, and every
   resume starts a new copy.
2. The driver resumes the program with its own options. For a caller
   that passed a policy, a host, a budget, callbacks, or a cancel
   signal, those are gone after the first debug step. Dropping the
   policy drops a handler, so this one is a safety issue.
3. Settling stops inside `runNodeCore` runs the rest of the program
   inside the first leg's lifecycle. `onAgentEnd`, the usage total, and
   the cancel signal all end up wrong. Settling in the public entry
   points fixes this and removes the `driving` flag.
4. The held-stops mechanism is not needed. A resume never reads an
   answer for a debug stop.
5. Watch mode does not exist. In running mode nothing calls the driver
   and nothing reads keys, so the pause key cannot work and the "renders
   in running mode" tests cannot pass.

PR 2 has four problems that would break CI or other people's runs:
the runtime cannot import the attach server (browser reach lint), every
Agency run would write to the real home directory and spawn `ps`, the
open socket keeps the process from exiting, and the logs viewer's
framing has a 64 KiB cap that a checkpoint will exceed.

PR 3 is mostly fine. It has a few small fixes, listed at the end.

## PR 1

### 1. A debugger installed mid-run does not reach the run

The plan's step 2 puts `attachDebugger` on "the context", and step 9
builds the driver "from the current context". Neither says which
context. It matters, because there are two kinds:

- The module's `__globalCtx`. `__setDebugger` writes here
  (`imports.mustache:78`).
- The execution context each leg runs on. `createExecutionContext`
  builds it with `Object.create(RuntimeContext.prototype)`, not from the
  global context, and copies fields one by one. `debuggerState` is
  copied once, at `context.ts:539`.

So for a run that is already going, writing to `__globalCtx` does
nothing: the run's execution context copied `null` when it started. The
spec's second "fact" ("A `DebuggerState` installed between two
statements takes effect at the next `debugStep`") is only true when the
state is installed before the run starts, which is what `agency debug`
does today (`debug.ts:257`, before the node call).

Writing to the live execution context instead reaches the current leg,
but not the next one. Every resume creates a new execution context
(`interrupts.ts:928`). That context's `debuggerState` comes from the
global context, or from `metadata.debugger` when the resume passes one
(`resumeSetup.ts:173`). `agency run` answering a program interrupt
passes no such metadata. So after the first program interrupt is
answered, the attached debugger silently stops seeing anything.

The same applies to the new `attachedDebugger` field: unless
`createExecutionContext` copies it, `runNodeCore`'s return path never
sees it.

A design that covers both cases: give the global context one small
holder object, for example `debugSlot: { state: DebuggerState | null }`,
and have `createExecutionContext` copy the reference to the holder (the
same object, not a copy of its contents). Attach writes `slot.state`.
Every live and future execution context of that module sees the change
at its next step, because they all point at the same holder. Detach
clears it the same way. `hasDebugger()` and `debugStep` read through the
holder. This replaces the per-context `attachDebugger`/`detachDebugger`
pair in step 2.

Add a PR 1 test that attaches after the run has started. Every test in
the plan attaches before calling the node, which is the case that
already works and would not catch this. A fixture whose node calls a
TypeScript helper that awaits a promise the test resolves is enough:
attach while it waits, then resolve.

### 2. Driver resumes drop the caller's options

The driver resumes with `this.invocation` and `metadata: { callbacks:
this.getCallbacks(), debugger }` (`driver.ts:364`, `driver.ts:598`). In
`agency debug` that is correct, because the driver started the run. An
attached driver did not start the run, so it does not know what the run
was started with. What each resume loses:

- `invocation.policy`. A resume installs the root policy from the
  options it is given (`resumeSetup.ts`, `installRunPolicyHandler(execCtx,
  request.policy)`). A TypeScript caller or `agency serve` that passed
  `policy: { "std::write": [{ action: "reject" }] }` would have that
  rule gone after the first debug step. A later `std::write` interrupt
  would then not be rejected by it. `agency run` is safe by accident: it
  passes its policy through `AGENCY_RUN_POLICY`, which every leg reads
  from the environment again.
- `invocation.host`, `invocation.inputOverride`, and `invocation.config`
  (the budget). `invocationOptions.ts:29-38` says a resume does not
  remember these and the caller must pass them again.
- The caller's callbacks. A resume merges `metadata.callbacks` into a
  fresh, empty `execCtx.callbacks`. The caller's `onCheckpoint`,
  `onAgentEnd`, and so on are not there.
- `abortSignal` and `pauseSignal`. Cancelling from the caller would not
  reach any leg after the first.
- `inputOverride` is worse than lost. The driver's own invocation routes
  `input()` to the debugger UI. The spec says a question goes to the
  run's terminal while attached.

The fix: when the runtime hands a stop batch to the attached driver, it
also hands over the options the current leg was started with
(invocation, callbacks, signals). The driver resumes and rewinds with
those, adding only `metadata.debugger`, and composes its own callbacks
with the caller's instead of replacing them. Remove `inputOverride` from
the attached driver's invocation.

PR 1 needs tests for this: a TypeScript caller passes a policy that
rejects an effect, attaches, steps past a few statements, and the
program then raises that effect. Assert it is rejected. A second test
checks that a caller's `onAgentEnd` fires once, with the final value.

### 3. Settle in the public entry points, not inside `runNodeCore`

Step 3 puts `settleStops` at `node.ts:503`, inside `runNodeCore`'s
`try`, inside `withExternalSignals`, before `finishServedInvocation`.
At that point the first leg's execution context is still open. The
driver's resumes each run as a complete leg of their own, and the final
value comes back to the first leg's return path. Then:

- The "final result" branch runs for the first leg: `agentEnd` and
  `onAgentEnd` fire from the first leg's context, with the first leg's
  token stats.
- `finishServedInvocation` reports the first leg's usage only, so
  `result.usage` and the cost a hosted caller sees are low.
- The caller's signals are wired to the first leg only (see 2).

Settling in the public wrappers avoids all of this: `runNode`,
`runNodeForServe`, the exported `respondToInterrupts`, and `rewindFrom`.
Each leg runs and finishes as it does today. The wrapper then loops:
while the result is a batch of debug stops and a debugger is attached,
hand it to the driver. The driver calls the core functions, which do not
settle. With that split the `driving` flag is not needed.

The `driving` flag has a bug of its own. It is one boolean per
debugger, and it answers "is a resume on the stack" when the question
is "is this resume the driver's". Two runs in one process share the
debugger: a TypeScript program running two nodes with `Promise.all`, or
`agency serve` with two requests in flight. While the driver is stepping
run A, run B reaches a stop. `driving` is true, so `settleStops` hands
B's stop batch to B's caller. Preventing that is the purpose of PR 1.

Usage across legs needs summing in the wrapper. Add a test that the
`usage` on the value a TypeScript caller gets back covers a model call
made after a debug step.

### 4. Held stops are not needed

The plan strips the stops from a mixed batch, keeps them in
`heldStops`, and merges them back in when the caller resumes. A resume
does not need them:

- `validateResumeBatch` only checks that there is one response per
  interrupt passed in and that the ids are unique (`interrupts.ts:662`).
  It does not check that the batch is complete.
- A branch stopped at a debug step resumes from the `__dbg_` flag in its
  frame, not from a response. On resume the runner sees the flag and
  skips the hook (`runner.ts:439`). When no debugger is installed it
  does not look at all (`runner.ts:428`).
- The previous plan review found the same thing for the in-process
  driver ("The resume does not look up answers for debug interrupts").

So stripping the stops is enough. The caller answers the program
interrupts, the branch at the debug stop carries on, and if the
debugger is still stepping it stops at that branch's next step. That
removes `heldStops`, the checkpoint-id matching, and the stale-hold
question. It also removes the problem that `heldStops` on a shared
object would be overwritten by a second concurrent run.

Keep the mixed-batch test, since it is what proves this.
`tests/debugger/parallel-interrupts.agency` does not produce a mixed
batch: both arms raise program interrupts. The simplest fixture that
does: a `parallel` block where one arm runs `debugger()` and the other
raises an interrupt, attached in running mode. A `debugger()` statement
stops in running mode, a plain statement does not, so the batch is
mixed every time.

The spec says the run side answers the stop with `continue`. Stripping
it leaves the user's stepping mode alone, which is better: the user who
was stepping stays stepping. Update the spec to match.

### 5. Watch mode needs its own mechanism

The spec's user view opens in watch mode: "the source pane follows the
current statement, the variables pane updates as it passes". The plan
starts the attached driver in running mode. In running mode `debugStep`
records a rolling checkpoint and returns (`debugger.ts`, the
`shouldPause` check). No stop is raised, so `settleStops` never runs, so
the driver never calls `render`. The UI shows nothing until a pause.

Two things follow:

- The PR 1 test "rendered at least three checkpoints" passes only
  because the script starts with `pause`. The PR 2 test "checkpoints
  render in running mode" cannot pass as designed.
- Nothing reads keys while running. `DebuggerUI` reads keys only inside
  `waitForCommand` (`ui.ts:584`), and the driver calls that only at a
  stop. So in watch mode the pause key, `q`, and Ctrl-C do nothing. The
  plan's `serveDebuggerIO` turns "the pause key" into a `pause` message,
  but no code reads that key.

Watch mode needs:

- A way for `DebuggerState` to report a new rolling checkpoint, and a
  throttle on the run side so the UI gets at most a few updates a
  second, each the latest one. Sending every statement's checkpoint
  over the socket would cost a full stack copy plus serialization per
  statement, and an agent's checkpoint includes its message threads.
- The driver's callbacks (`getCallbacks`, which fill the activity log
  with model calls and tool calls) installed on the live run at attach.
  Today they reach a run only through the node call's options and
  `metadata.callbacks` on a resume.
- A key loop on the UI side that runs while no `waitForCommand` is
  pending, and hands over to `waitForCommand` when one arrives.

If this is too much for the first version, say so in the spec: the
first version opens paused at the next step (attach sends `pause`
itself), and watch mode comes later. That would cut the throttle and
the second key loop from these PRs. I would take that cut.

### 6. The driver's reads of `ui.state`

The plan asks for this list before coding. Here it is from
`driver.ts`: `log`, `setMode`, `setOverride`, `getOverrides`,
`resetOverrides`, and `lookupVariable`.

The first five fit the plan: `log` and `setMode` are sent to the UI,
and the overrides are written and read on the driver's side, so they can
stay in a local `UIState`. `lookupVariable` does not fit. `print`
(`driver.ts:449`) reads the variable from the frame the UI is showing,
which the user can change with `b`. That frame lives in the UI process.
Either move `print` into the UI side (it does not touch the program) or
give it a request and reply. A local `UIState` on the run side would
answer from the wrong frame, or from nothing.

### 7. Smaller points in PR 1

- `run()` ends with `this.ui.destroy()` in a `finally` (`driver.ts:248`).
  In attached mode `run()` returns every time the program reaches a
  program interrupt, so this would tear down the remote UI on the first
  one. Attached mode must skip it.
- `run()` has no `try`/`catch` around its IO calls, on purpose. The
  plan's `Detached` error (PR 2, step 3) needs one, around
  `waitForCommand`, `render`, `showRewindSelector`, and
  `showCheckpointsPanel`, turning `Detached` into `continue`.
- Detach during a resume, while the program is running and no command
  is pending, is not covered. With the holder object from point 1,
  detach clears the holder and the next step costs nothing again. Add a
  test for it.
- `DebuggerState` starts in `stepping` mode (`debuggerState.ts:8`). The
  plan says attached mode starts in `running`. Make the attach code call
  `running()` explicitly before installing.
- `settleStops` should recognise a stop with `isDebugger(intr)`, the
  check the driver uses, rather than `isDebugStop(intr.data)`.
- `:save` and `:load` resolve their path against the working directory
  of the process the driver runs in (`driver.ts:528`, `:539`). Attached,
  that is the program's directory, not the user's. Say so in the docs,
  or send the path through the UI side.

## PR 2

### 8. The runtime cannot import the attach server

`lib/runtime` is reachable from the browser bundle. A file there may not
import a Node module or use `process` (`docs/dev/runtime/host.md`, "The
lint rule"), and `scripts/lint-browser-reach.mjs` fails when the bundle
reaches one. Step 9 calls `registerAttach` from `runNodeCore`. That
module builds a `DebuggerDriver` (which imports `fs` and `path`), uses
the registry (`fs`, `process.pid`), and opens sockets. `lint:structure`
would fail.

Two places it could go instead:

- `#platform`. The host doc lists the runtime's own hooks that differ by
  platform there. `platform.node.ts` would register, and
  `platform.browser.ts` would do nothing. This fits best, since attach
  is about Agency's machinery, not about what the platform offers.
- Behind the host, as the spec has it, with `runNodeCore` calling only
  `host.system.onAttachRequest`. Then the record, the socket, and the
  driver construction all have to be reached through host functions.

Decide which before writing PR 2. With `#platform`, the two optional
`HostSystem` functions may not be needed at all, which would make the
`host.md` section in PR 2 unnecessary.

### 9. Registering on every run changes every run

The plan says "nothing in it changes behaviour for a program nobody
signals". After PR 2, every run in every process does this:

- Writes `~/.agency/debug-sessions/<pid>.json` in the real home
  directory. That includes the vitest suite, `agency test`, evals, and
  CI. Under `memoryHost`, `homeDir()` is `/home/agency`
  (`memoryHost.ts:544`). The registry uses `fs` directly, as the logs
  viewer's does, so it would try to create `/home/agency/.agency/...` on
  the real disk. On macOS that throws inside `runNodeCore` and fails
  every memoryHost test.
- Spawns `ps -p <pid> -o lstart=` to read its own start time. That is a
  child process per Agency process, it fails where `ps` is missing (slim
  containers), and the runtime would be spawning a program on behalf of
  a run that may not have the `subprocess` capability.
- Installs a `SIGUSR2` listener. That changes what `SIGUSR2` does to the
  process: its default action is to terminate, and with a listener it
  does not. `nodemon` restarts its child with `SIGUSR2`, so "has no
  owner" is not quite true, though the effect is small.

Fixes:

- Read the run's own start time without a child process:
  `Date.now() - process.uptime() * 1000`. The CLI side runs `ps` once,
  parses the date, and compares with a tolerance of two seconds, since
  `lstart` has one-second resolution. The guard still works.
- Add the directory override in PR 2, not PR 3. An `AGENCY_HOME`-style
  variable read through `host.settings`, the way `AGENCY_AGENT_HOME`
  works. Point the test setup at a temporary directory with it.
- Skip registration under a memory host, and when a debugger is already
  installed. Otherwise `agency debug` registers its own process, and a
  second debugger can attach on top of the first.
- Decide what `agency serve` does. One process runs many invocations at
  once. The plan's "a later context replaces the current one" would
  attach to whichever request started last, and one shared
  `DebuggerState` would stop all of them. Not registering under serve
  is the simplest choice and matches the spec's "hosted runs are out of
  scope".
- Decide whether IPC subprocess children (`std::agency` `run`)
  register. They are separate processes, so each would show up in the
  listing. That may be what you want; the listing should say it is a
  child, and the spec should say which.

### 10. The socket keeps the process alive

A listening `net.Server` and an open connection keep Node's event loop
alive. A program that finishes while a debugger is attached would not
exit. Step 9 closes the server when the debugger disconnects, not when
the program ends. Call `unref()` on the server and on each accepted
socket, and send the UI a "program finished" message before the
process exits, so the UI can say why the connection closed.

### 11. Do not lift the logs viewer's framing

Step 6 lifts the socket framing out of `lib/logsViewer/session/` into a
shared `jsonSocket.ts`. That code reads one request per connection, with
a 64 KiB cap on the request (`server.ts:19`) and a five-second timeout,
then ends the connection. The attach channel is one long-lived
connection carrying messages in both directions, and a checkpoint of an
agent forty minutes in is megabytes. The shared part would be about ten
lines, and moving it puts the logs viewer in the diff for no gain.
Write a line reader for the channel and leave the logs viewer alone.

The cap still matters. Set it per message type, or size it from the
checkpoint window. `showRewindSelector` and `showCheckpointsPanel` send
the whole window, which is `rewindSize` checkpoints. Better: send those
two a list of summaries (id, location, label, pinned) and keep the
checkpoints in the run process, where the rewind happens anyway. The
selector returns an id, so it does not need the full checkpoints.

The plan says checkpoints travel as `checkpoint.toJSON()`. The trace
writer uses the same call, so that is consistent with the spec. Check
what a checkpoint holds that JSON loses: `debugStep` runs the
`onCheckpoint` payload through `nativeTypeReplacer` (`debugger.ts`, the
`onCheckpoint` block), which suggests some values need it.

### 12. Directory and socket modes

`fs.mkdirSync(dir, { recursive: true, mode: 0o700 })` applies the mode
only to directories it creates. `~/.agency` already exists on machines
that used `std::oauth` (`oauth.ts:19`), created with the default mode,
and a `debug-sessions` directory left by an earlier build would keep
its mode. The logs viewer's registry sets no mode at all
(`registry.ts:28`), so it is not a model for this part. On every open,
`stat` the directory and refuse unless it is owned by the current user
and `mode & 0o077` is zero. The CLI should check the same before
trusting a record.

`chmod` on the socket after `listen` leaves a short window with the
umask's mode. The directory check is what protects the socket. Keep the
`chmod` as a second layer and say in the docs which one the safety
argument rests on.

### 13. Smaller points in PR 2

- "Refuse a second connection with a message naming the first": Node
  cannot read the peer's pid from a Unix socket. Say "already attached
  since 10:42" instead.
- The record's `program` field has no source. `runNodeCore` is not
  given a file path. The generated module knows its own path; pass it
  through, or read `process.argv[1]` on the Node side.
- "Once per process" with the record naming one node: a TypeScript
  program that runs several nodes in turn will list the first one. Fine
  for a first version, but write the record's `node` as "the first node
  run" in the docs.
- PR 2's Node socket test is named `attachSocket.test.ts` under
  `lib/host/node/`, but the plan builds the socket code in `nodeHost.ts`
  and `jsonSocket.ts`. If 8 moves it under `#platform`, rename the test
  to match.

## PR 3

- `escape` maps to `quit` (`ui.ts:93`). Attached, `quit` is detach, so
  pressing Escape to back out of something detaches. Map only `q` to
  detach while attached.
- Ctrl-C in `waitForCommand` calls `cleanup()`, which calls
  `process.exit` (`ui.ts:586`). The debugger process exits without
  sending `detach`. The run side treats the socket closing as a detach,
  so the result is the same. Say that in the plan rather than "send
  `detach`", or the implementer will add a second path.
- The `SIGINT` handler in `debug.ts:79` is installed only on the bundle
  path (`--trace` with a bundle). The attach path never reaches it, so
  that instruction can go.
- Pick the pause key now, in the spec, so PR 1's test and docs can name
  it. Free letters in `SIMPLE_KEYS` and `handleInteractiveKey` include
  `w`, `x`, `h`, `e`, `f`, `g`, `j`, `l`, `m`, `u`, `v`, `y`. Another
  option: while running, `s` pauses. The user who wants to stop wants
  to step, and no new key is needed.
- The child-process test compiles `tests/debugger/step-test.agency`.
  Compile it into a temporary directory. A stray `step-test.js` beside
  the fixture breaks the other debugger tests' first resume. There is
  one in the working tree now (ignored by git, dated 2026-10-19).
- The smoke test step is good. Add one run started from TypeScript
  (`node dist/main.js` on a compiled example that passes a policy), since
  that is where points 2 and 3 show up.

## Changes to the spec

Collected from above, for the spec edit:

1. The second "fact" is wrong. A `DebuggerState` installed after a run
   starts does not reach it (point 1).
2. The mixed-batch rule: the stop is dropped from the batch, not
   answered with `continue`, and the user's stepping mode is kept
   (point 4).
3. "A debug stop that reached a policy would be rejected": debug stops
   do not go through the handler chain, so a policy never sees one. The
   real risk is a debug stop reaching a caller's loop, or a parent
   process through IPC. Reword.
4. `SIGUSR1` becomes `SIGUSR2`, with the `nodemon` caveat (point 9).
5. Watch mode: either describe the mechanism (point 5) or move it to a
   later version and open paused.
6. Where registration lives: `#platform` or the host (point 8).
7. What registers: not under a memory host, not when a debugger is
   already installed, not under `agency serve`, and a decision for IPC
   children (point 9).
8. The `Files` section names `client.ts`; the plan names `serveIO.ts`
   and `lib/cli/attach.ts`. Make them agree.
