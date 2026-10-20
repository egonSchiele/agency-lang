# Plan: attaching the debugger to a running program

Implements `docs/superpowers/specs/2026-10-20-attach-to-a-running-program.md`.
Linear: ADI-10, with one ticket per PR below.

Three PRs against `main`, each reviewed on its own and each useful alone.
PR 1 makes a debugger installed on a running program answer its own
stops inside the runtime, so any caller of a node function can have one.
PR 2 puts a channel between the driver and the UI and gives the host the
trigger and the socket. PR 3 is the `--attach` command, the listing, and
the docs. Smoke the built binary after each build, against a real
`agency run` in another terminal, not only the tests.

Reading before starting: the spec; `docs/dev/cli/debugger.md` and
`docs/dev/cli/debugger-tests.md`; `docs/dev/runtime/host.md`, the
sections on `system` and `makeHost`; `docs/dev/cli/logs-viewer.md`, the
"Sessions" section, whose socket code is the model for PR 2 and PR 3;
`docs/dev/runtime/concurrent-interrupts.md` for why a batch is answered
whole, which PR 1 depends on.

## One change to the spec first

Use `SIGUSR2`, not `SIGUSR1`. Node reserves `SIGUSR1` for its own
inspector. On Node 26 a `process.on("SIGUSR1")` listener runs and the
inspector stays quiet, but the Node docs promise only that a listener
"might interfere with the debugger", older versions behave differently,
and the inspector listens on a localhost TCP port that any local user can
reach. `SIGUSR2` has no owner in Node; `nodemon` uses it to restart a
child, which a run under `nodemon` would then no longer honour, a small
cost worth a line in the docs. The spec's reasoning is unchanged: the
signal is the opt-in, and only a same-user process can send it. The spec
is edited with this plan.

## PR 1. A debugger that answers its stops in place (ADI-10a)

Today the debugger is a loop around the node call: a stop makes the node
function return a paused result, and `DebuggerDriver.run` resumes it with
`respondToInterrupts`. After this PR a driver can be installed on a
module's context while a program is running, and a caller of the node
function, `agency run`, a TypeScript import, or serve, never sees a debug
stop: the runtime hands each stop batch to the driver and continues
before returning. No sockets yet. The driver and its `DebuggerIO` are in
the same process, which is also the shape every headless test uses.

The first version opens stopped at the next step. Watch mode, where the
UI follows a running program, is not in these PRs: it needs a throttled
checkpoint feed and a key loop while nothing is waiting for a command,
and the review on this plan recommended leaving it out. So the attached
state starts in `stepping`, the default, and nothing calls `running()`.

### Narrow `DebuggerIO` first

The driver reaches into `this.ui.state` for six things: `log`,
`setMode`, `getOverrides`, `resetOverrides`, `setOverride`, and
`lookupVariable`. That is a leak: the driver's logic depends on the UI's
state object, and a channel would have to carry the leak across a
process. Fix it as the first commit of the PR:

- Pending overrides are driver state. Move `setOverride`, `getOverrides`,
  and `resetOverrides` into `DebuggerDriver`. The UI keeps the copy it
  shows in the locals pane (`ValWithOverride`), fed by `render`.
- `print` reads the variable from the frame the UI is showing, which the
  user changes with `b`, so it belongs to the UI. `DebuggerUI` handles
  `p` and `:print` inside `waitForCommand`, logging the value and going
  on waiting; the `print` command leaves `DebuggerCommand` and the
  driver. `parseCommandInput` still parses it, since the UI uses it.
- `DebuggerIO` gains `log(line)` and `setMode(mode)`, and loses `state`.
  `DebuggerUI` implements the two by writing to its `UIState`;
  `TestDebuggerIO` records them.

After this the driver talks to the UI only through `DebuggerIO`'s
methods, so the channel in PR 2 is exactly that interface.

### The holder: a debugger installed mid-run must reach the run

`__setDebugger` writes `__globalCtx.debuggerState`, but a run copies that
field into its execution context once, when the leg starts
(`createExecutionContext`, `context.ts:539`), and every resume makes a
new execution context. So a state installed after the run started
reaches nothing, and one installed on a live execution context is lost
at the next resume.

1. `lib/runtime/state/context.ts`: the context holds one small object,
   `debugSlot: { state: DebuggerState | null }`, created in the
   constructor. `debuggerState` becomes a getter and setter over
   `debugSlot.state`, so every existing read and write (`debugStep`,
   `hasDebugger`, `__setDebugger`, `resumeSetup`) goes through the slot
   unchanged. `createExecutionContext` copies the slot by reference, the
   same object, not its contents. Every live and future execution
   context of the module then sees an install or a detach at its next
   step.

### The attached driver

2. `lib/debugger/debuggerState.ts`: `DebuggerState` gets an optional
   `attached: AttachedDebugger`. The runtime finds the attached driver
   through the slot, so no new generated export and no new context API
   is needed: the test and the attach server both install with
   `__setDebugger(driver.debuggerState)` as `agency debug` does today.
   The type lives in `lib/runtime/attachedDebugger.ts`:

   ```ts
   export type LegOptions = {
     invocation?: InvocationOptions;
     callbacks?: AgencyCallbacks;
     abortSignal?: AbortSignal;
     pauseSignal?: AbortSignal;
   };
   export type AttachedDebugger = {
     /** Answers a batch of debug stops with the user's commands, resuming
      *  with `leg`'s options each time, and returns when the program
      *  pauses on something else or finishes, with the usage of every
      *  leg it ran. */
     run(result: RunNodeCoreResult<any>, leg: LegOptions): Promise<AttachedRunResult>;
     /** The program finished while attached, without a stop. */
     finished(result: RunNodeCoreResult<any>): Promise<void>;
   };
   ```

3. The driver resumes with the caller's options, not its own. In
   `agency debug` the driver started the run, so `this.invocation` and
   its own callbacks are right. An attached driver did not, and a resume
   does not remember the policy, host, config, callbacks, or signals of
   the leg it resumes (`invocationOptions.ts`), so resuming with the
   driver's options would drop a caller's policy, a handler, after the
   first step. So `run(result, leg)` stores `leg`, and every resume and
   rewind in attached mode passes `leg.invocation`, `leg.abortSignal`,
   `leg.pauseSignal`, and `metadata.callbacks` composed from the caller's
   callbacks and the driver's own (`composeCallbacks` in
   `lib/runtime/hooks.ts`: each hook calls both), plus
   `metadata.debugger`. No `inputOverride` is added: a question goes to
   the run's terminal while attached. `ModuleFunctions.respondToInterrupts`
   gains `abortSignal` and `pauseSignal` in its options, which the
   generated wrapper already forwards.

4. The driver's resumes say they are the driver's. Every resume and
   rewind the attached driver issues carries `metadata.attachedResume:
   true`. The public wrappers (step 6) skip the settle for such a call.
   This is a per-call marker, not a shared flag, so two runs sharing one
   debugger in one process do not confuse it. It is what the previous
   draft's `driving` boolean got wrong.

5. `DriverOpts.attached?: boolean`. In attached mode `run()`: returns the
   result as soon as it is final or holds a program interrupt instead of
   asking about it; never intercepts the console; does not call
   `ui.destroy()` in its `finally`; treats `quit` as `continue` and then
   detaches; and catches `DebuggerDetached` (a small error class in
   `lib/debugger/types.ts` that PR 2's channel throws when the other side
   goes away) around `render`, `waitForCommand`, `showRewindSelector`,
   and `showCheckpointsPanel`, treating it as `continue`. `run` returns
   the result together with the summed usage of the legs it ran, which
   the driver reads off each resume's return value.
   `driver.detach()` resolves a pending `waitForCommand` with `continue`
   through a `cancelWait` the UI side provides, and clears
   `debuggerState.attached` and the slot's state, so the next step costs
   nothing again. Detach while the program is running and no command is
   pending is the same call with nothing pending.

### The settle, in the public wrappers

6. `lib/runtime/attachedDebugger.ts` also holds `settleStops(ctx,
   outcome, leg)`. It runs in the public entry points only: `runNode`,
   `runNodeForServe`, the exported `respondToInterrupts`, and
   `respondToInterruptsForServe`. Not inside `runNodeCore`: there the
   first leg's execution context is still open, and the final value
   would come back through its return path, so `onAgentEnd` and the
   usage would be the first leg's. In the wrapper each leg runs and
   finishes as it does today. The wrapper then loops:

   - While the outcome is a returned value whose interrupts are all debug
     stops (`isDebugger` from `interrupts.ts`, the driver's own check)
     and the slot holds a state with an `attached` driver: hand it to
     `attached.run(value, leg)` and take the result back as the outcome.
   - When the batch mixes stops and program interrupts: drop the stops
     and return the program interrupts. A resume never reads an answer
     for a debug stop (`validateResumeBatch` checks only that each
     interrupt given has a response; the stopped branch resumes from the
     `__dbg_` flag in its frame), so nothing has to be remembered. The
     user's stepping mode is left as it is, so if they were stepping,
     the branch stops at its next step.
   - When the outcome is final and a driver is attached, call
     `attached.finished(value)` so the UI can say so.
   - Usage is summed over the legs: a `RunUsage` for the first leg plus
     each `AttachedRunResult.usage`. Add `sumRunUsage(a, b)` beside
     `unwrapWithUsage` in `invocationUsage.ts`, adding the cost and token
     breakdowns, concatenating the entries, and-ing `complete`, and
     adding `unpricedCallCount`.

   The wrapper has `leg` already: `runNode` from its `RunNodeArgs`
   (`invocation`, `callbacks`, `abortSignal`, `pauseSignal`), and
   `respondToInterrupts` from its own arguments and `metadata.callbacks`.
   A call whose `metadata.attachedResume` is set is returned as it is.

### Tests for the PR

Every test calls the compiled node function as a TypeScript caller
would, with `freshImport` on a fixture compiled in `beforeAll`, and
installs the driver with `mod.__setDebugger(driver.debuggerState)` so
the driver and the fixture share the `dist` runtime copy
(`docs/dev/cli/debugger-tests.md` explains why the fixtures import
`dist`).

- `tests/debugger/awaits-helper.agency` and `awaits-helper.js` beside it:
  a node that calls a JavaScript helper which awaits a promise the test
  resolves, then runs a few statements. `lib/debugger/attached.test.ts`
  starts the node, attaches while the helper waits, resolves it, and
  checks the driver then stops at the next statement. This is the test
  that catches the holder bug: attaching before the call would pass
  without the slot.
- Attach between legs: `top-level-interrupt.agency`. The caller gets the
  program interrupt, attaches, answers it with `respondToInterrupts`,
  and the driver stops at the next statement of the new leg.
- Options survive: the caller passes `policy: { "std::env": [{ action:
  "reject" }] }` on a fixture that reads an environment variable after a
  few statements; attach, step twice, continue; assert the read is
  rejected. A second test passes `onAgentEnd` and asserts it fires once
  with the final value.
- Usage: with the mock model (`withLLMMocks`), a fixture that calls
  `llm()` after a statement the debugger steps past; assert the `usage`
  on the caller's return value counts that call.
- The mixed batch: a new fixture `tests/debugger/mixed-batch.agency`,
  a `parallel` block where one arm runs `debugger()` and the other
  raises an interrupt, attached and then `continue`d so the state is
  `running`; a `debugger()` stops in running mode and a plain statement
  does not, so the batch is mixed every time. Assert the caller sees
  only the program interrupt, answers it, and gets the final value, and
  that the arm with the `debugger()` carried on.
- `set` from the attached driver changes a local the program then
  returns.
- Detach while stopped: the program finishes and the slot is clear.
  Detach while running: attach, `continue`, detach during the run, and
  assert the program finishes and `hasDebugger()` is false.
- Two runs in one process: two nodes started with `Promise.all` on one
  module with one attached driver. This is a smoke of the per-call
  marker; the assertion is only that both callers get their final
  values and neither gets a stop.

### Docs in the PR

`docs/dev/cli/debugger.md`: a section "A debugger installed on a
running context": the slot, the two modes of `run()`, the per-call
marker, and the mixed-batch rule. `docs/dev/cli/debugger-tests.md`: how
to test with an attached driver. `:save` and `:load` resolve their path
in the program's process, which attached is the program's working
directory; say so there.

## PR 2. The channel, the platform trigger, and the run side (ADI-10b)

After this PR a program started with `agency run` or from TypeScript on
Node opens a socket when it receives `SIGUSR2`, and a `DebuggerIO` at the
other end drives it. No CLI yet; the test is the client.

Registration lives behind `#platform`, not the host. `lib/runtime` is
reachable from the browser bundle and may not import a Node module or
the attach server (`scripts/lint-browser-reach.mjs`), and attach is
Agency's own machinery rather than something the platform offers, which
is what `#platform` is for (`docs/dev/runtime/host.md`, "The lint
rule"). So `platform.node.ts` exports `registerAttach(ctx, program)` and
`platform.browser.ts` exports one that does nothing. The two optional
`HostSystem` functions from the first draft of the spec are not needed
and are not added.

### The channel and the protocol

1. `lib/debugger/attach/channel.ts`: the `Channel` type from the spec
   (`send`, `onMessage`, `onClose`, `close`) and `memoryChannelPair()`,
   two channels wired to each other for tests.
2. `lib/debugger/attach/protocol.ts`: the message types, as zod schemas
   the way `lib/logsViewer/session/protocol.ts` writes them. One request
   per `DebuggerIO` method in the spec's table, with a request id, plus
   `hello`, `finished`, and `detach`. `log` and `setMode` are
   `DebuggerIO` methods after PR 1, so they are rows in the same table,
   not a second kind of message. No `pause`: without watch mode nothing
   reads a key while the program runs. A checkpoint travels as
   `checkpoint.toJSON()` run through `nativeTypeReplacer`, the way
   `debugStep` prepares the `onCheckpoint` payload, and comes back
   through `Checkpoint.fromJSON`. `showRewindSelector` and
   `showCheckpointsPanel` do not send checkpoints at all: their
   `DebuggerIO` signatures change to take `CheckpointSummary[]` (id,
   location, label, pinned), which is what the two panels render, and
   the checkpoints stay in the run's process where the rewind happens.
   `DebugStopData`, `GuardTripData`, and `DebuggerCommand` are plain data
   already.
3. `lib/debugger/attach/channelIO.ts`: `ChannelDebuggerIO implements
   DebuggerIO`, the run side. Each method sends its request and returns a
   promise the matching reply resolves; the one-way methods (`log`,
   `setMode`, `appendStdout`, the spinner) send and return. `onClose`
   rejects every pending reply with `DebuggerDetached`, which the
   attached driver turns into `continue`.
4. `lib/debugger/attach/serveIO.ts`: `serveDebuggerIO(channel, io)`, the
   UI side. Turns each request into the matching call on a real
   `DebuggerIO` and sends the reply. The UI's `quit` sends `detach`.
   This is the function PR 3's command and this PR's tests both use.

### The platform pieces

5. `lib/debugger/attach/lineChannel.ts`: a `Channel` over a Node socket:
   newline-delimited JSON, one message per line, with a per-message cap
   of 64 MiB, since a checkpoint of an agent forty minutes in holds its
   message threads. Written here, not lifted from the logs viewer, whose
   framing is one request per connection with a 64 KiB cap and a
   five-second timeout, none of which fits a long-lived two-way channel.
   The logs viewer is not in the diff.
6. `lib/runtime/agencyHome.ts`: `agencyHomeDir(host)`, `AGENCY_HOME`
   read through `host.settings`, else `~/.agency` under
   `host.system.homeDir()`, the way `agentHomeDir` works. The sessions
   directory is `debug-sessions` under it. Test setup points
   `AGENCY_HOME` at a temporary directory, so no test touches the real
   home.
7. `lib/debugger/attach/registry.ts`: `writeRecord`, `removeRecord`,
   `listRecords`, `removeStale`, each one step, in the style of the logs
   viewer's registry but not sharing code with it, since that registry
   sets no directory mode and the two differ in what they protect. The
   record is `{ pid, program, node, startedAt }` with a zod schema.
   `startedAt` is `Date.now() - process.uptime() * 1000`, no child
   process. Before any read or write, `stat` the directory and refuse
   unless the current user owns it and `mode & 0o077` is zero; create it
   with `0o700` when it does not exist. The CLI runs the same check
   before trusting a record. The socket gets `chmod 0600` after `listen`
   as a second layer; the docs say the safety argument rests on the
   directory check, because `chmod` after `listen` leaves a short window
   at the umask's mode.
8. `lib/debugger/attach/server.ts`: `startAttachServer(ctx, record)`,
   Node only. Listens on `<pid>.sock`, removing a leftover at its own
   pid's path first, refuses on Windows and on an over-long path with a
   logged line, and calls `unref()` on the server and on every accepted
   socket so an open session never keeps a finished program alive. On
   the first connection: build a `DebuggerDriver` in attached mode with
   the functions `registerAttach` was handed and a `ChannelDebuggerIO`, send `hello`
   (program, node, pid), and install it with `ctx.debuggerState =
   driver.debuggerState`. A second connection is answered with
   `{ refused: "already attached since <time>" }` and closed; Node cannot
   read the peer's pid from a Unix socket. On close for any reason:
   `driver.detach()`. When the program finishes (`attached.finished`),
   send `finished` and close the connection.

### The run side

9. `lib/runtime/platform.node.ts`: `registerAttach(ctx, program)`, called
   from the public `runNode` in `node.ts`, not from `runNodeCore` and not
   from `runNodeForServe`, so `agency serve` never registers: one serve
   process runs many invocations at once and one shared `DebuggerState`
   would stop them all, and the spec puts hosted runs out of scope. It
   returns at once when: `ctx.host.name` is not `"node"`, so a memory
   host in a test never writes a record; a debugger is already installed
   (`agency debug` must not register its own process, and a second
   debugger must not attach over the first); or
   `ctx.host.system.parentChannel()` is non-null, an IPC child of
   `std::agency`'s `run`, which the first version leaves out so the
   listing shows only runs a person started. Otherwise, once per
   process: write the record with `program` from `process.argv[1]` and
   `node` the first node run, install the `SIGUSR2` listener, and
   remove the record and the socket in `host.system.onExit`. On the
   signal, `startAttachServer`. `platform.browser.ts` exports a
   `registerAttach` that does nothing. `attachFunctionsFor(ctx)` lives
   in `lib/runtime/attachedDebugger.ts`: the four functions the driver
   takes, bound to `ctx`, in the same runtime copy as the context.

### Tests for the PR

- `lib/debugger/attach/channel.test.ts`: the memory pair delivers in
  order and `close` fires `onClose` on both sides; the line channel
  round-trips a message larger than 64 KiB and refuses one over the cap.
- `lib/debugger/attach/attach.test.ts`, headless, no socket: run a
  fixture as a TypeScript caller would, call `startAttachServer`'s
  connection handler directly with one side of a `memoryChannelPair()`,
  serve a scripted `TestDebuggerIO` on the other, and assert: `hello`
  arrives with the program and node; the first stop renders; `step`
  advances; `set` changes a local the program then prints; closing the
  test's channel resumes a stopped run and clears `hasDebugger()`; a
  second connection is refused with the "already attached" message;
  `finished` arrives when the program ends.
- The same against `tests/debugger/agent-shaped.agency` with the mock
  model, stopped inside a tool call, asserting the branch and tool data
  of the stop reach the UI side through the JSON round trip.
- `lib/debugger/attach/registry.test.ts`: records round-trip under a
  temporary `AGENCY_HOME`; `listRecords` ignores files it did not write;
  `removeStale` deletes only records whose process is gone; a directory
  with group or world bits is refused.
- `lib/debugger/attach/server.test.ts`, Node only: a real socket in a
  temporary sessions directory, the socket's mode checked with
  `fs.stat`, a leftover socket removed, the refusal on an over-long
  path, and that a process with a finished program and an open session
  exits (the `unref`).
- `lib/runtime/platform.test.ts`: `registerAttach` returns without a
  record under a memory host, with a debugger installed, and with a
  parent channel.

### Docs in the PR

`docs/dev/runtime/host.md`: one line in the `#platform` list naming
`registerAttach`. `docs/dev/cli/debugger-attach.md` is PR 3's, but the
registry's directory check and the `unref` belong to this PR's code, so
start the doc here with those two sections and let PR 3 fill in the
rest.

## PR 3. `agency debug --attach` (ADI-10c)

### The command

1. `scripts/agency.ts`: `debug` takes `[file]` instead of `<file>`, and
   `--attach [pid]`. With `--attach` and no file, the file is not needed;
   with both, refuse with a message. `lib/cli/debugFlags.ts` gets the
   combination check, next to `compileChoice`, with a test.
2. `lib/cli/attach.ts`: `attachCommand(pid | undefined, flags)`. With no
   pid, print the listing from `listRecords` after `removeStale`, in the
   spec's format, and exit. With a pid: check the sessions directory the
   way the registry does; read the record, refuse when there is none;
   read the live process's start time with `ps -p <pid> -o lstart=`,
   parse it, and refuse, removing the record, when it is more than two
   seconds from the record's `startedAt`; send `SIGUSR2`; connect to
   `<pid>.sock`, retrying for up to two seconds since the socket appears
   after the signal; build the `DebuggerUI` on the terminal the way
   `lib/cli/debug.ts` does today; `serveDebuggerIO(channel, ui)`. On `q`
   send `detach`, destroy the UI, and exit 0. On the channel closing,
   say why (`finished`, or the run went away), destroy the UI, and exit
   0. Ctrl-C arrives as a key in raw mode, and `waitForCommand` already
   calls `cleanup()` and `process.exit` on it; the run side treats the
   socket closing as a detach, so no second path is needed. The `SIGINT`
   handler in `debug.ts` is on the bundle path only and is not involved.
3. `lib/debugger/ui.ts`: while attached, only `q` detaches. `escape`
   maps to `quit` today, so the attached UI drops that key. No pause key
   in this version, since nothing reads a key while the program runs.
   The status line reads `attached to <pid> <program>` and adds `window:
   n of N` while the checkpoint window is shorter than the configured
   size. After `continue` the command bar says `running; stops at the
   next debugger() statement, a question, or the end`.

### Tests for the PR

- `lib/cli/attach.test.ts`: the listing format from a fake records
  directory; the refusals (no record, start time more than two seconds
  off with the record removed, process gone, a directory with group or
  world bits); the retry gives up with a message; the `lstart` parser on
  the macOS and Linux formats.
- `lib/cli/debugFlags.test.ts`: the `--attach` combinations.
- A Node test that compiles `tests/debugger/step-test.agency` into a
  temporary directory (a stray `.js` beside the fixture breaks the other
  debugger tests' first resume; there is one in the tree now, ignored by
  git) and starts it as a child process with `AGENCY_HOME` pointed at a
  temporary directory, runs `attachCommand` against a
  `DebuggerTestSession` instead of a terminal, and checks the frames it
  recorded: a stopped frame with the attached status line, a frame after
  `step`, and that the child exits 0 after `q`.
- The smoke: `make build`, `agency run` on an example in one terminal,
  `agency debug --attach` with no argument to list it, then with the pid;
  step, `set`, continue, quit, and confirm the run finishes with its own
  output. Then the same against a program started from TypeScript, `node
  dist/main.js` on a compiled example whose caller passes a policy that
  rejects an effect the program raises after a few statements, and
  confirm the rejection still happens after stepping. Record both in the
  PR description.

### Docs in the PR

- `docs/site/cli/debug.md`: the user's view, from the spec's "The user's
  view" section, in the site's voice, with the `nodemon` line.
- `docs/dev/cli/debugger-attach.md`: the rest of the design from the
  spec's "The runtime's view" and "Access" sections, the message table,
  the mixed-batch rule, the start-time guard, and the file list. Add it
  to the `CLAUDE.md` index and the `agency-cli-docs` skill together.
- `docs/dev/cli/debugger.md`: a paragraph pointing at it.
- `CHANGELOG.md`: an Unreleased entry.

## Order and size

PR 1 touches the runtime's public entry points and must land first; its
tests are the proof that a TypeScript caller is never handed a stop and
that a caller's policy survives a step. PR 2 is the largest, but it is
new files plus one `#platform` function and one call in `runNode`. What
it changes for a program nobody signals: a record file under
`~/.agency/debug-sessions` and a `SIGUSR2` listener, in a Node process
that is not a serve, a test, an IPC child, or `agency debug`. PR 3 is
the CLI and docs. Each PR ends with `make`, the suites it adds, and
`pnpm run fmt:ts` on the named `.ts` files only.

The plan was checked against `docs/dev/contributing/anti-patterns.md`
and then reviewed (`2026-10-20-attach-to-a-running-program-review.md`).
The shape it settled on: the slot makes a mid-run install reach every
leg; the settle lives in the public wrappers, and a per-call marker, not
a shared flag, tells the driver's resumes apart; the mixed batch drops
the stops and remembers nothing; the driver resumes with the caller's
options; `DebuggerIO` is narrowed before a channel carries it; the
registry is its own small thing with a directory check; and one context
per process.

Things to watch, from the review rounds on the previous debugger PRs:
read the real return object a node call produces before writing the
settle, and build the mixed-batch test from a run that really produces
a mixed batch rather than a hand-made one; check the generated node
wrapper's option shape before spreading anything into it; and run the
exact test a reviewer names before pushing.
