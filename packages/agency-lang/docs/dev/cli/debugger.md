# Interactive Debugger

The interactive debugger lets users step through `.agency` source code line by line, inspect and modify variables, and rewind execution to previous states. It runs as a terminal UI via the `agency debug` CLI command.

## Usage

```bash
agency debug <file> [--node <name>] [--rewind-size 30] [--trace <file>] [--checkpoint <file>] [--dist-dir <dir>] [run flags]
```

If the file has multiple nodes, the user picks one interactively. If the node has parameters, the debugger prompts for their values.

`agency debug` takes the run flags `agency run` takes (`addRunOptions` in `scripts/agency.ts`): `--policy`, `--approve`, `--reject`, `--max-cost`, `--max-time`, `--model`, `--local`, `--max-tool-call-rounds`, `--log-file`, `--observability`, `--strict`, `--agency-only`, and the rest. The compile settings are folded onto the config before compiling, as `run` does. The policy and the budget become an `InvocationOptions` (`invocationFromRunFlags` in `lib/cli/debugFlags.ts`), passed on the node call and, since a resume installs the root policy and budget again, on every `respondToInterrupts` and `rewindFrom` the driver makes; `rewindFrom` takes an `invocation` for this. `run` carries the same values to its child process as environment variables; the debugger runs the program in its own process, so they travel as options instead. The invocation is spread onto the node call, because the generated node function takes its options flat; under an `invocation:` key it would be dropped without an error, and the leg before the first stop, which runs the file's top-level code, would run with no policy and no budget. `--agency-only` applies the sandboxed compile (`compileAgencyOnly`, which takes no config, so `--model`, `--strict`, and the other compile flags are dropped under it) but not the Node process flag `run` adds to its child, and it is checked before `distDir`, so a `distDir` in `agency.json` cannot turn the sandboxed compile off; naming `--dist-dir` as well is refused. Three flags belong to `run` and `resume` only (`addRunAndRecordingOptions`): `-i`, since the debugger prompts for every interrupt no handler answers, and the recording flags `--trace`, `--trace-file`, and `--capture-workdir`, since the debugger's own `--trace` loads a recording. The budget counts one timeline: a rewind restores the root guard's spending as recorded at the checkpoint, so money spent on an abandoned timeline is not counted against the cap.

`input()` in the debugged program is answered in the debugger's text field: the driver puts an `inputOverride` on the invocation, which the node call spreads (the generated node function takes its options flat and forwards `inputOverride` to `runNode`) and every resume and rewind takes whole, and the runtime installs it on that execution's context (`RuntimeContext.inputOverride`), so two runs in one process never see each other's. No process-wide global is set; `AGENCY_DEBUGGER`, which `agency debug` once set for stdlib UI components, had no readers left and is gone. Nothing stops a stdlib TUI component from drawing over the debugger today; that was already so, since nothing read the variable.

`agency debug` takes the run flags `agency run` takes (`addRunOptions` in `scripts/agency.ts`): `--policy`, `--approve`, `--reject`, `--max-cost`, `--max-time`, `--model`, `--local`, `--max-tool-call-rounds`, `--log-file`, `--observability`, `--strict`, `--agency-only`, and the rest. The compile settings are folded onto the config before compiling, as `run` does. The policy and the budget become an `InvocationOptions` (`invocationFromRunFlags` in `lib/cli/debugFlags.ts`), passed on the node call and, since a resume installs the root policy and budget again, on every `respondToInterrupts` and `rewindFrom` the driver makes; `rewindFrom` takes an `invocation` for this. `run` carries the same values to its child process as environment variables; the debugger runs the program in its own process, so they travel as options instead. The invocation is spread onto the node call, because the generated node function takes its options flat; under an `invocation:` key it would be dropped without an error, and the leg before the first stop, which runs the file's top-level code, would run with no policy and no budget. `--agency-only` applies the sandboxed compile (`compileAgencyOnly`, which takes no config, so `--model`, `--strict`, and the other compile flags are dropped under it) but not the Node process flag `run` adds to its child, and it is checked before `distDir`, so a `distDir` in `agency.json` cannot turn the sandboxed compile off; naming `--dist-dir` as well is refused. Three flags belong to `run` and `resume` only (`addRunAndRecordingOptions`): `-i`, since the debugger prompts for every interrupt no handler answers, and the recording flags `--trace`, `--trace-file`, and `--capture-workdir`, since the debugger's own `--trace` loads a recording. The budget counts one timeline: a rewind restores the root guard's spending as recorded at the checkpoint, so money spent on an abandoned timeline is not counted against the cap.

`--trace` and `--checkpoint` load a recorded run instead of executing one. If the file is a bundle, `agency debug` extracts its sources to a temp directory and debugs those. `--dist-dir` imports pre-compiled JS from a directory rather than compiling on the fly.

## Architecture

Three layers:

```
+-----------------------------------------+
|  UI                   lib/debugger/ui.ts     |
+-----------------------------------------+
|  Driver               lib/debugger/driver.ts |
+-----------------------------------------+
|  Runtime              lib/runtime/debugger.ts |
+-----------------------------------------+
```

**Runtime**: Every `Runner` step method calls `maybeDebugHook()`, which calls `debugStep()`. `debugStep()` takes rolling checkpoints and conditionally returns a debug interrupt to pause execution.

**Driver**: A loop that catches debug interrupts, feeds state to the UI, waits for user commands, and resumes execution via `respondToInterrupts()`.

**UI**: A terminal application built on `lib/tui/` with panes for source code, threads, locals/globals, call stack, activity log, and stdout.

## How it works

### Compilation

The debugger does not need special compilation. Generated code already routes every step through a `Runner` method, and every one of those methods calls `maybeDebugHook()` first. The hook is a no-op unless the run has a debugger or a trace writer attached.

Instrumentation is controlled by one compiler flag, `instrument`. When `agencyConfig.instrument === false`, `processDebuggerStatement()` emits nothing and no step records a source-map entry. Otherwise the `debugger` keyword compiles to:

```typescript
await runner.debugger(0, "some-label");
```

`agency debug` compiles with `instrument` forced on, since the debugger stops at `debugStep()` calls. `--dist-dir` compiles nothing, so it warns when the imported module has an empty source map.

### The `maybeDebugHook()` hook (`lib/runtime/runner.ts`)

`maybeDebugHook(id, run, label, isUserAdded)` runs before each step body. It returns early when the context has nothing that wants a checkpoint at this step (`recordsStepCheckpoints()`: a debugger on any stack; a trace writer or an `onCheckpoint` consumer on the root stack only), and inside a handler body or a callback body, which have no step address a resume could re-enter. A tool call is ordinary stepped code on a branch stack, so the hook fires there; see "Stops inside a tool call" below.

To avoid re-triggering on resume, it stores a flag in `frame.locals` under a per-step key. First entry sets the flag and fires the hook. On resume the flag is present, so the hook is skipped and the step body runs. The flag stays set for as long as the step runs, whether or not the hook halted, and `step()` deletes it once the body completes. So any checkpoint taken while the body runs, by a nested interrupt or by a rolling checkpoint inside a called function or a tool, carries the flag in this frame, and a resume or a rewind from it passes through the statement without stopping. Under `continue` the hook does not halt at the `llm()` line, but the flag it set still lets `step back` from a breakpoint inside a tool land on the tool's previous statement rather than on the `llm()` line.

When `debugStep()` returns an interrupt, the hook halts the runner. In node context it halts with `{ messages, data }`; in function context it halts with the raw interrupt.

### The `debugStep()` function (`lib/runtime/debugger.ts`)

Signature: `debugStep(run, info, stack)`, where `info` carries `moduleId`, `scopeName`, `stepPath`, `label`, `nodeContext`, and `isUserAdded`, and `stack` is the runner's own stack: the root stack at the top level, a branch stack inside a tool call, fork, or parallel block. On every call it:

1. Returns `undefined` when the stack has no current node id. Global initialization runs outside any graph node, so there is nothing to checkpoint against.
2. On the root stack only, writes a trace checkpoint, independent of whether a debugger is attached. This is how `agency debug --trace` gets its recording. A trace checkpoint is a copy of the whole root stack, so one per step inside every tool would multiply an agent run's trace by its tool statements; a trace therefore cannot replay a step inside a tool.
3. Returns `undefined` if `ctx.debuggerState` is null (not in debug mode).
4. Reads the step's depth from the run (`run.callDepth`, the call counter `withCallDepth` keeps for every Agency call) and asks `DebuggerState.shouldStopAt(depth)`. When running, it stops only on a user-added `debugger()` breakpoint.
5. Takes a rolling checkpoint via `DebuggerState.createRollingCheckpoint()` for rewind history. It is stamped from the root stack, which holds every live branch stack, with the location's `branchPath` naming the stack the step ran on.
6. If stopping: creates the halting checkpoint on the regular `CheckpointStore` from the runner's own stack, as a tool's interrupt and a guard trip do (the slice rule in `docs/dev/runtime/concurrent-interrupts.md`), and returns a debug interrupt whose `data` is a `DebugStopData`: the location, the branch path, the depth, and the label.

`debugStep()` does not advance the step counter. An earlier design called `StateStack.advanceDebugStep()` here so the resumed step guard would skip past the debug block. The `frame.locals` flag in `maybeDebugHook()` replaced it. `advanceDebugStep()` still exists on `StateStack` but the debugger no longer calls it.

### DebuggerState (`lib/debugger/debuggerState.ts`)

A class that encapsulates all debugger state. Owned by the driver, passed to the runtime via `metadata.debugger` on each interrupt resume. Stored on `RuntimeContext.debuggerState`.

Key state:
- `mode`: "stepping" or "running"
- `stopDepth`: the depth of the step it is stopped at, set by the driver from the stop it shows
- `stepTarget`: for next/stepIn/stepOut commands — stores the target depth
- `checkpoints`: a `DebugCheckpointStore` with rolling window

### Debug checkpoints

The debugger uses the regular `CheckpointStore` for its rolling checkpoint window. The `DebuggerState` class manages rolling checkpoint creation with a configurable window size (default 30). Pinned checkpoints are exempt from eviction.

### The driver loop (`lib/debugger/driver.ts`)

```
run program → hits debugStep() → interrupt returned
  → extract interrupt from result.data (runNode wraps in { messages, data, tokens })
  → render UI
  → wait for user command
  → handle command (resume, rewind, set variable, etc.)
  → loop
```

The driver uses four wrapper functions the compiled module exports (`respondToInterrupts`, `rewindFrom`, `__setDebugger`, `__getCheckpoints`) rather than accessing `__globalCtx` directly.

### Stepping commands

- **step**: `mode = "stepping"`, no target. Pauses at the next `debugStep()`, at any depth.
- **stepIn**: `mode = "stepping"`, `targetDepth = stopDepth + 1`.
- **next**: `mode = "stepping"`, `targetDepth = stopDepth`. Skips over function calls.
- **stepOut**: `mode = "stepping"`, `targetDepth = stopDepth - 1`. Runs until current function returns.
- **continue**: `mode = "running"`. Runs until a user-placed `debugger()` statement.

A step's depth is how many Agency calls deep the run is, read from `run.callDepth`, the counter `withCallDepth` keeps on every call (see `lib/runtime/callDepth.ts`). The node's statements are at 0, a called `def`'s at 1, and a tool's at one more than the function that called `llm()`, so `step in` from an `llm()` line lands on the tool's first statement. The counter follows the lineage of calls, not a global count, so two tools running at once each have their own depth, and a resume rebuilds it as the calls re-enter. If/else, loops, match blocks, `thread` blocks, and the branches of a `fork` or `parallel` block are at their enclosing block's depth and are stepped through normally: `next` at a `fork` statement stops at the first statement of a branch, as it does for a loop body. The tool loop that runs for `llm()` is one call deeper than the statement that called it (`runPrompt` runs under `withCallDepth`), and a tool it calls one deeper again.

What the commands do around an `llm()` call, with that depth rule:

| Command | At the `llm()` statement | At a `round` or `tool` stop | Inside a tool's body |
|---|---|---|---|
| `step` | stops at `round 1` | the next stop of any kind | the next step anywhere |
| `next` | runs the whole `llm()` | the next `tool` or `round` stop, over the tool's body | the tool's next statement |
| `step in` | stops at `round 1` | the tool's first statement | the first statement of a called `def` |
| `step out` | runs to the caller | the statement after `llm()` | the loop's next stop |
| `continue` | runs to a breakpoint | the same | the same |

### Stops between tool calls

The tool loop `runPrompt` runs for `llm()` has stops of its own, taken on the `runPrompt` frame by `PromptRunner` (`lib/runtime/promptRunner.ts`). The loop names what a step is, and the runner owns what the debugger does with it:

- **`pr.llmCall(which, body)`** runs a model request as a step. `which` says which request it is, `{ first: true }`, `{ afterToolRound: n }`, or `{ validationRetry: n }`, and the runner derives the step key (`initialLlmCall`, `round.N.nextLlmCall`, `validation.N.llmCall`, unchanged so recorded checkpoints still resume) and the label, `round N` or `validation retry N`. The stop comes before the request rather than after, so a person can change the thread before the model sees it.
- **`pr.beforeToolCall(invocationKey, toolCall)`** is the stop before a tool call, labelled `search(query: "grant")` with each argument cut to 40 characters. The loop calls it for each call whose gate verdict is `proceed`, in order, before the round's batch starts (a refused call gets no stop), for a handoff right before its own second batch, and for an intrinsic call such as `saveDraft`. The stops sit on the frame rather than inside each call's branch because a stop inside each branch would raise one debug interrupt per call in a single batch, which the driver shows one of (see below). Without a debugger it returns at once and records no step, so a run without one pays nothing per call. To make the verdicts known before the batch, the loop decides them in a step of their own, `round.N.gateVerdicts`, in call order; a branch that finds no verdict (a checkpoint from before that step) decides its own.

`PromptRunner.debugStop` works like `maybeDebugHook`: it fires only when a debugger is attached, skips a handler body and a callback body, keeps a `__dbg_<key>` flag in the `runPrompt` frame's locals so a resume that re-enters the step skips the stop, and clears the flag when the step's body completes. The checkpoint `debugStep` stamps is the one the interrupt carries; the runner does not stamp a second. The stop is located under the `llm()` statement, in its module and scope, at the statement's step path plus a slash and the step key, and both the stop record and the checkpoint carry `loopStop: "round" | "tool"`. That marker is how the UI knows the location is not a statement: the source pane shows the `llm()` line (`statementStepPath` takes the part before the slash), the locals pane and `print` show the frame that called `llm()` (`Checkpoint.shownFrame`, the frame under the loop's, on the stack the branch path leads to, so a subagent's stop shows its tool's frame), the activity log says `Stopped before round 2` or `Stopped before search(query: "grant")`, and `set` is refused there. The rewind list marks a checkpoint with `loopStop: "round"` "(replays a model request)".

A subagent, a tool that calls `llm()` itself, runs its own loop with its own stops, so `round 1` can appear once per loop.

### Stops inside a tool call

A tool is a `def` called by the loop `runPrompt` runs for `llm()`. Its body runs on a branch stack under the `runPrompt` frame, and its statements are steps like any other, so the hook fires there and a stop inside it is an ordinary debug interrupt. It travels the path a tool's own interrupt travels: the tool loop records it on the branch, `runBatch` stamps the shared checkpoint at the join, `PromptRunner` bails out, and the node halts. On resume the `__dbg_` flag in the stopped frame makes the hook skip, so the tool finishes and its result reaches the thread once.

Two things make the driver work at such a stop:

- **The branch path.** Every checkpoint records `branchPath`, the branch keys from the root down to the stack the step ran on (`["tool_0_call_abc"]` for a tool, `["tool_0_call_abc", "fork_1"]` for a fork inside it). `Checkpoint.getCurrentFrame()` follows it, so the locals pane, `print`, `removeDebugFlagsFor`, and the rewind list all find the frame the step ran in. A branch stack derives the path from `parent`, the link to the stack it branched from that `runBatch` sets when it starts the branch; the path is serialized on the checkpoint only.
- **The stop record.** After the join, the interrupt's `checkpoint` is the shared one, whose location is the loop's. The interrupt's `data` (`DebugStopData` in `lib/runtime/debugger.ts`) says where the stop really is and how deep it is. The driver sets `stopDepth` from it when it shows the stop, and passes it to `UIState.setCheckpoint(checkpoint, stop)`, which reads the source line from the stop and the frame from `checkpoint.frameAt(stop.branchPath)`. A rolling checkpoint carries its own path, so the rewind list and `step back` need no stop record.

Rolling checkpoints inside a tool are keyed by location including the path, so two calls of the same tool in different rounds each keep their rewind entries, bounded by the store's eviction limit. `removeDebugFlagsFor` strips the flags of the stopped frame only: `main` keeps its flag for the `llm()` statement so a rewind replays through it into the loop and the tool, and a sibling branch keeps its flag so it replays past its own stop. `step back` (`CheckpointStore.findBefore`) rewinds to a step on the stopped stack or on a stack above it, so from inside one tool of a round it never lands in the other tool.

A rolling checkpoint taken inside a tool must carry the replies of the tools that have already finished, or a rewind would send the model a call with no reply. The tool loop keeps the thread in its frame as `messagesJSON`, refreshed when it checkpoints; for a checkpoint built from elsewhere, `runPrompt` registers a refresher in `ctx.beforeCheckpoint` for the life of the call, and `Checkpoint.fromStateStack` runs the list before it copies the stack. A `fork` or `parallel` branch registers one the same way for its own copy of the globals, written into the branch as `globalsJSON`, so a rewind into the branch after it changed a module-level variable replays with the changed value. `Checkpoint.globalsAt(branchPath)` returns that copy, and `print` and the globals pane read through it; a tool call shares the root's globals and has no copy.

Several branches can stop at once: in stepping mode every Agency tool in a round stops at its next step, so the batch holds one debug interrupt per tool. The driver shows the first, says in the activity log where the others stopped, and the next stepping command answers the whole batch (every debug stop gets an approve, which the resume never reads), so all the branches move.

The call stack pane is read from the checkpoint's frames on every render (`UIState.getCallStack`): one entry per frame from the root stack down the branch path to the stack the program is stopped on, so inside a tool it reads `main`, `llm()` (the tool loop's own frame), `search`. The compiler-named frame of a fork or parallel arm, or of a block argument, reads `block`, and a frame with no scope name `(unknown)`. Nothing is pushed or reset on a resume or a rewind, since the checkpoint is the stack. Only Agency code and the TypeScript that claims a resumable scope (`withResumableScope`, as the MCP gate does) have frames; other TypeScript functions do not appear. A debug stop carries its branch path. A user interrupt raised inside a tool, a fork, or a parallel arm does not: it is stamped on the shared checkpoint at the join, whose location has no branch path, so `UIState.setCheckpoint` takes the interrupt's id and finds the branch whose state records it (`Checkpoint.branchPathOf`). An interrupt bubbles out through every enclosing branch, each of which records the same id, so the deepest match is taken. The pane then ends at the tool or the arm that asked, and the locals pane shows its frame; the source pane still highlights the `llm()` line the interrupt came out of, and the globals pane shows the caller's module, so for a tool from another module the locals are the tool's while the source and globals are the caller's. When several interrupts arrive in one batch, the panes are set again for each one as it is asked about. `set` is refused at a stop on a branch stack (a tool call, a fork, or a parallel block), because a resume applies overrides to the root's last frame.

### What the program is waiting on

While the program runs, the debugger is told what it is waiting on, a model request or a tool call the model made, so the UI can say so instead of showing a spinner with nothing behind it (`lib/runtime/waits.ts`). Nothing else is reported: a program visits thousands of statements a second between its slow parts, so a report per statement would show nothing and cost more than the step, and the other slow things (`fetch`, `bash`, `sleep`, a subprocess, an interrupt the caller is answering) are each one call away when wanted.

A wait is a `BusyEntry`: a `token` the run hands out, `kind` (`model` or `tool`), the `location` as a loop stop locates it (`StopLocation`, the five fields a `DebugStopData` also carries: module, scope, the statement's step path plus the loop's key, the branch path, and the depth), the loop's own `label` (`round 2`, or the tool call with its arguments cut short), the run's `debugRun` key, and `elapsedMs` as of the send. No checkpoint travels with it: a checkpoint per model call would make the locals and stack panes a second-old picture presented as current, and a stop's render does that job when the person asks for one.

A site does not open and close a wait itself. It passes its body through `whileBusy(run, stack, wait, body)` in `lib/runtime/debugger.ts`, which opens the wait, runs the body, and closes the wait however the body leaves, by a return, a throw, or a bail-out; a handler's or a callback's body runs plain, the exclusions `maybeDebugHook` and `PromptRunner.debugStop` make, since neither has a step a stop could show. Two sites: `PromptRunner.llmCall` wraps the request's body, inside the stop before it, so a person stopped before a request is not shown waiting on it; and `PromptRunner.invokeTool` runs the tool loop's `.invoke` step with its body wrapped, as `llmCall` does the request's. The tool site is the invoke step and not the `.start` and `.end` steps beside the tool hooks: those are steps of their own, skipped on a resume, while the invoke step re-runs when the tool's own interrupt is answered, and the tool is then running again, so a resumed tool reports a second wait. The model step's body does memory recall before the request itself, so its elapsed time is the step's, not the request's alone.

The open waits live on the module's debug slot (`DebugSlot.waits` in `state/context.ts`), with or without a debugger installed: two small pushes per model call, and nothing when nothing is open. That is what makes the moment this exists for work. A person attaches to a program forty seconds into a model call; the wait began before any debugger existed, but it is on the slot, so the moment the debugger is installed the run reports it, `elapsedMs` included, and the UI backdates its clock.

The record reaches the driver through a plain call, not the way stops do. A stop is an interrupt because it pauses the program; a wait pauses nothing, so it must not be one. `DebuggerState` has `onWait`, which both drivers set when built, and `reportWaits(slot)` builds the list to show and calls it with the whole list of open waits each time, so the UI never applies an enter and a leave in order and a close for a wait it never saw is nothing to handle. The same list twice is not sent (`reportedWaits`). Three things report: `whileBusy` when a wait opens and when it closes; the `debuggerState` setter on the context, so a debugger installed mid-wait is told at once; and `debugStep` when a run takes the debugger, so the list narrows to that run. Reporting never claims the debugger: `DebuggerState.owns` makes the asking run the owner and resets the window, which a wait must never do, so `reportWaits` filters by the read-only `showsRun`: not attached, every run's waits; attached with no owner yet, every run's, since the debugger is nobody's and what the process is doing is what it should show; attached with an owner, that run's only. A driver that detaches and attaches again forgets its last report (`reportedWaits`) in `attach`, so a wait still open from before the detach is reported to the new session; and when the owned run lets go of the debugger (`letGoOfDebugRun`), the waits of the other runs, hidden while it was debugged, are reported at once.

At a stop the list is nearly always empty. `PromptRunner.parallel` settles every tool branch before the shared checkpoint is stamped, so a stop that comes out of a tool round has no open wait. The one exception is an `async` call: the halt a debug stop takes through `maybeDebugHook` does not await the pending promises (the halt for a program's own interrupt does), so a stop at a root statement can be shown while an `async foo()` is still in a model call. The list crosses the attach channel as the `setBusy` notice, and `DebuggerIO.setBusy` is how the UI receives it. The UI side checks each entry with `isBusyEntry` and drops one of the wrong shape, so a bad notice costs an entry rather than the debugger.

On the UI side (`lib/debugger/busy.ts`, `uiState.ts`, `ui.ts`) the list is kept with the time each wait was first seen: `withSince(previous, entries, now)` is a pure function of the previous list, the new entries, and the clock, keeping a held wait's time by its token, backdating a new one by the `elapsedMs` it arrived with, and dropping one that is gone. The clock is the UI's own, injected for tests (`DebuggerUI`'s `now` option), so the two processes need not agree about the time. While the program runs, the command bar's spinner text is `▶ running · ` and `busyText` of the wait that began last, `in llm() at story.agency:11 · 4s · round 1, waiting on model`, with `· +N more` when others are open; the spinner's 80ms redraw is what makes the figure tick, and the random phrases it used to show are gone. At a stop with a wait still open, the `async` case, the stats bar carries the same text after the usual figures. The source pane marks every open wait's line in the module on screen with `▶` and a second background, the elapsed figure beside the line the bar names, and the stop's highlight wins on a shared line; before any stop, the pane shows the module the program is waiting in and centres on that line. A wait's line comes from the same source map lookup as a stop's (`UIState.lineFor`, over the per-module cache that `loadSourceMap` fills; `setBusy` loads a module not seen yet and redraws when it has). `getCurrentLine` no longer logs on every redraw: `setSourceMap` says once why a line is missing. The spinner runs whenever the program is running and not only during a leg the driver resumed: the driver starts it in `attach`, before the install reports the open waits, and again when it hands a batch with the program's own interrupt back to the caller, and `attendStop` stops it before the stop is shown; that is what makes an attach in the middle of a long call show the call, ticking, from the first frame. A tool wait carries its `round` from the run (`PromptRunner.invokeTool`, counted as the person counts), so the UI parses nothing out of the step key. `loadSourceMap` catches an import that fails, which can happen in the attached UI's process, and logs one line; the pane then has no line for that module and the debugger goes on.

The pause key goes with this. While the program runs, `s` or `n` asks it to stop at its next statement: `DebuggerIO.onPause` registers the driver's listener once, and the listener calls `DebuggerState.stepping()` when a leg is running (`legRunning`, set around `resumeInterrupt`) and logs `Pausing at the next statement`; at a stop, or after the run ended, it does nothing. The run side changes nothing else: the next `debugStep` sees stepping mode and stops, with the step target cleared so `next` over a call stops inside it too. A call in flight is not interrupted. Attached, the UI's listener sends the `pause` message, the one message the UI side sends unprompted, and the run side's `ChannelDebuggerIO` calls the driver's listener. Reading the key while the program runs needed one change in the UI: `TerminalInput.nextKey()` queues its waiters, so a second reader beside `waitForCommand` would hand a key at the next stop to a stale waiter. `DebuggerUI` therefore has one in-flight `nextKey()` (`armReader`) and one `dispatch` that gives each key to whoever is current: the person waiting in `readKey`, which every read for the person goes through (`waitForCommand`, the text input, and the overlays through `OverlayContext.nextKey`), else the pause listeners when the spinner runs and the key is `s` or `n`, else a held list that the person's next read drains first, so `q` pressed while running still detaches at the next stop, in order. The pause is keyed on the spinner, not the UI's mode: the mode is stale while the program runs, since the driver sends `setMode` at the next stop and nothing on `continue`. `DebuggerTestSession` waits on `DebuggerUI.waitForPerson`, which fires when the UI reads a key for the person, rather than `TestInput.waitForIdle`, which fires for the pause reader too.

### The threads pane

The pane shows one thread, the active one until the person picks another with `t` (a picker listing every thread by label, with its parent, its message count, and a mark on the active one) or cycles with `[` and `]`. A picked thread stays shown on later checkpoints while it is still listed, so a person can follow it while stepping. The threads come from two places in the checkpoint (`Checkpoint.listThreads`).

The node frame carries the thread store. The active thread is the top of the active stack: the store's own, or, inside a `fork` or `parallel` arm, the branch's, since an arm runs on a view of the store whose active stack is serialized with the branch (`BranchStateJSON.activeStack`).

A tool loop's frame carries `messagesJSON`, the thread it is working on. Since #1215 it is refreshed on every checkpoint. When its `id` matches a store thread, the loop's copy is the one shown, whatever the lengths: a resume continues from it (`restoreThreadForResume`), so after memory compaction the shorter loop copy is the conversation the program goes on with. A loop inside a tool runs on a fresh store that is not serialized, so its copy is the only record of the subagent's thread. It is listed under the thread's own `id`, named after the function that called `llm()`, and marked active. Its `parentId` names a thread of the unserialized store, so it is dropped. In the list, a store thread is identified by its store key and a tool thread by its id; only the match between a loop copy and a store thread goes by `id`.

### The branches and guards panes

Two panes appear when the checkpoint has something for them (`UIState.listBranches`, `listGuards`, `loopState`, each read from the checkpoint on every render):

- **branches**: every branch in the checkpoint, from the root stack down through the branches' own stacks, so a person stopped inside one tool sees its siblings: a tool call, a fork branch, or a parallel item, each with the scope it runs, its status, and the frame that owns it. This is where a subagent appears. The status is `done` when the branch has a result, `interrupted` when it stopped on an interrupt and has none (a branch keeps the id of an interrupt it stopped on earlier, so the result is checked first), else `running`. A finished branch has no frames, since a function pops its frame when it returns; a finished tool is named from the tool loop's record of the call (`toolCallName`), and the picker's cursor skips it. `b` opens the picker; choosing a branch makes the locals and globals panes show its last frame, and `print` reads that frame, while the source pane keeps the stop's line and module. Choosing "the stopped frame" returns. `set` still applies to the stopped frame, not the viewed one. The call stack pane follows the chosen branch too, since it reads the location's branch path.
- **guards**: the tool loop the stopped code is in (its round, counted from 1, and the tools the loop has removed), then one line per guard along the branch path, outermost first: `research · cost $0.42 of $0.5`, `root budget · time 4m10s of 30m`, marked `(disarmed)` when it is. The loop counts a round when its request returns, so at the loop's own stop before a request the round comes from the stop's label. A branch stack serializes the time guards it inherited, each a clone with the parent's guard id, the parent's remaining time as its limit, and the branch's own working time; a guard is listed once, in the place of its outermost copy, with the figures of the deepest copy and the note `(this branch)`. A cost guard is shared by reference and is listed once as the parent's. The run's tokens and cost stay in the stats bar.

### User code interrupts

If the program hits a non-debug `interrupt()` while debugging, the driver detects it (`isInterrupt` but not `isDebugger`), shows the interrupt data, and asks for an answer: approve, reject, or resolve with a value. When several branches raised at once (parallel tool calls, a fork, a `parallel` block), the batch holds several interrupts and the runtime insists on one response per interrupt. The driver asks about each in turn, `Interrupt (1 of 2): A?` then `(2 of 2)`, and sends one `respondToInterrupts` call with the answers in the batch's order (`DebuggerDriver.respond`). A debug stop in the same batch is answered with an approve.

A guard trip (`std::guard`, see `docs/site/guide/guards.md`) is answered through a form (`showGuardTripForm` in `lib/debugger/overlays.ts`), since a bare approve would be refused by the runtime. The form says which guard tripped, what it spent against its limit, and what a reject may return (a preview of the saved draft, which a `finalize` can replace), then offers three choices: approve with more budget, remove the tripped limit, or reject. A grant asks for the amount, in dollars or as a duration (`30s`, `2m`, or milliseconds), and refuses it on screen while it would leave the budget still exceeded, which is the answer the runtime would throw on; both approvals then ask for an optional message to the model. The pieces the form is built from, the choices, the amount reader, the grant check, and the response (`approve({ maxCost | maxTime, disarm, message })` or `reject`), are plain functions in `lib/debugger/guardAnswer.ts`. Only the tripped dimension is asked about.

A raise used as a value (`const x = raise ...`, which the runtime marks `expectsValue`; `question` from `std::agent` is one) wants an answer rather than an approve or a reject. The activity log shows the question, the prompt is `answer:`, and the typed text is the answer, as a string, the way the CLI's approval prompt takes it. `resolve <json>` gives a JSON value when the rest parses as JSON, so `resolve 7` is the number and "resolve the conflict by hand" stays whole; `reject` (or `r`) rejects, `approve` (or `a`) resolves the variable to `true`, and an empty answer is asked for again. The raise's data is shown after the question when it says more than the message, such as the options of a choice.

### Source mapping

The builder records source locations in a `SourceMap` exported as `__sourceMap` from the compiled module. Keys are `"moduleId:scopeName"`, values map step paths to `{line, col}`. The UI uses this to highlight the current line in the source pane. For cross-file debugging, the UI loads the new file when the `moduleId` changes.

### How the runtime finds the debugger

The module installs the debugger once, with `__setDebugger`, and every leg finds it from there. The context keeps the state in a holder, `debugSlot`, that every execution context of a module shares by reference: `RuntimeContext.createExecutionContext()` copies the holder, not its contents, and `debuggerState` is a getter and setter over it. So a debugger installed while a run is going, or between two legs of a resume, is seen by every live and future leg at its next step, and clearing it makes every leg cheap again. A resume takes no debugger in its metadata: the holder is shared, and a metadata field written to it would install the debugger on every concurrent run of the module.

One rule in `maybeDebugHook` goes with the holder. On a resume the runner re-enters the statement that was in progress in every restored frame: the caller's call, whose callee's frame is restored too, and the callee's interrupt, whose answer is waiting. A frame that stopped at a debug step keeps its `__dbg_` flag, so the hook skips it; a frame restored from a checkpoint taken with no debugger has no flag. So a resume from an interrupt marks every restored frame (`StateStack.markReentry`, which records the counters the frame was restored with in `State.restoredCounters`: its `step` and every `__substep_`), and the hook skips the statement at a restored counter, consuming the entry so a loop that brings the same statement round again stops as usual. The skipped statement gets its `__dbg_` flag as a stop would give it, so a checkpoint taken while its call runs carries the flag and a rewind to that checkpoint passes through it too. A rewind marks nothing: it replays the statement it lands on, and the stop there is the point. Without that rule a debugger attached between two legs stopped at the caller's statement while the callee's frame was still waiting to be claimed, and the resume from that stop desynced.

The tool loop's own stops follow the same rule, through `PromptRunner.resumesInto`. The loop's steps have no counters, so the signs are different: the step whose body raised the interrupt is recorded in the frame (`runnerState.pendingStep`, set by `bailOut`), and a tool call that was running when the frame paused has its branch restored with the frame, waiting to be claimed. On a frame that `markReentry` marked, the stop before such a step is skipped. Otherwise a debugger attached between the legs would stop before the tool call the caller just answered, the driver's resume would start a leg with no answer for it, and the tool would raise the same interrupt again.

### A debugger installed on a running program

`agency debug` starts the program itself, so the driver is the caller: a debug stop makes the node function return a paused result and `DebuggerDriver.run` resumes it. A debugger can also be installed on a program something else is running, such as `agency run`, a TypeScript program that imported the compiled module, or a serve. That caller knows nothing about debug stops, so it must never see one.

A driver built with `attached: true` and installed with `driver.attach()` sets `DebuggerState.attached`, an `AttachedDebugger` (`lib/runtime/attachedDebugger.ts`). Every public entry point of the runtime passes its leg's outcome through `settleStops` after the leg has finished and cleaned up: `runNode`, `respondToInterrupts`, `resumeFromCheckpoint`, `rewindFrom`, `resumeCliFromCheckpoint`, the serve twins, and `runExportedFunction` with its twin, whose bare `Interrupt[]` value goes through `settleFunctionStops`:

- A batch of nothing but debug stops goes to `attached.run`, which shows the stop, takes the person's commands, and resumes; the leg it ends on becomes the outcome, with that leg's usage. A resume seeds its meter from the checkpoint it restores, so each leg's figure is the run's total so far, and the last leg's is the whole run's; adding the legs would count every earlier call once per later leg.
- A batch that mixes stops with the program's own interrupts is returned with the stops dropped, and the activity log says the stop was passed. A resume never reads an answer for a debug stop (the stopped branch carries on from the `__dbg_` flag in its frame), so nothing is remembered, and the person's stepping mode is left as it is.
- A final value is reported through `attached.finished`, unless the debugger ran the leg that produced it.
- A leg the debugger ran that threw (a cancelled run, for one) comes back as a thrown outcome with its usage, as it would with no debugger: the driver resumes through the module's serve-style `respondToInterruptsForServe` when it has one, and the serve entry points keep the outcome while `runNode` throws the error.
- A paused checkpoint, from the caller's own pause signal, goes back as it is: the program has not ended.
- A batch of nothing but stops that reaches the settle with no debugger installed at all was stopped while one was attached and detached since; it is let go with the leg's own options (`letStopsGo`), the way the debugger's `quit` lets a stop go, so the caller is never handed one. A debugger that is installed but not attached (`agency debug` in its own process) gets its stops back whole.

The settle runs in the public wrappers rather than inside `runNodeCore`, so each leg's usage and cleanup happen as they do today. `onAgentEnd` fires from the leg that ends the run, while its execution context is alive, through `callHook` (`fireAgentEnd` in `agentEnd.ts`): the global hooks, the program's own `callback("onAgentEnd")`, the caller's callback, and the relay to a parent all fire, and a callback that throws is logged, as with no debugger. `runNodeCore` fires it when its own leg ends; a leg the attached debugger resumed fires it when the run began in `runNode`, which `agentEnd` in the leg options and `attachedAgentEnd` on the resume's metadata carry. A resume the caller issued itself fires nothing, as it never did.

In attached mode the driver resumes with the caller's options rather than its own. A resume does not remember the policy, host, budget, callbacks, or signals of the leg it resumes, so the runtime hands them to the driver with each stop (`LegOptions`) and the driver passes them back, with its own callbacks composed onto the caller's (`composeCallbacks`). A rewind takes the same signals and returns its usage, so a leg that starts with `stepBack` is cancelled and metered like one that starts with `step`. No `inputOverride` is added: a question goes to the run's own terminal. Every resume and rewind the attached driver issues carries `metadata.attachedResume`, and the public wrappers return such a call as it is; the marker is on the call, not on the debugger, because two runs in one process share a debugger even though only one is debugged. The leg options travel with the call (`AttachedSession`), never on the driver. A run whose caller cancels it while it waits at a stop is answered with `continue` at once, so the resume lands the cancel the usual way; a `waitForCommand` left pending by that is kept for the next stop (`commandInFlight`), so the person is not asked twice. A rewind that throws comes back as a thrown outcome too, with the checkpoint's usage. The attached driver never intercepts the console, never destroys its UI when `run` returns, and treats `quit` as detach: the slot is cleared before the resume so the new leg raises no stop. Detaching while the driver waits at a stop answers it with `continue`; the UI reporting the other side gone, from any call the driver makes on it, is a detach too (`uiCall`), and a render from a callback after that does nothing.

One run at a time is debugged (`lib/runtime/debugRun.ts`). The rule: the debugger owns a run from its first stop until the leg goes back to anyone outside the debugger, whether the caller gets a value, the program's own interrupt, a paused checkpoint, or a throw (`releaseDebugRunAfter`, from `finishServedInvocation` and from a rewind's replay; a leg that paused on nothing but debug stops stays with the debugger). A run that comes back from outside, through a caller's resume, gets a fresh key (`restoreForResume` mints one unless the resume carries `attachedResume`), so two resumes of one checkpoint are two runs. The key is minted in `initFreshExecCtx` and kept in the root stack's `other` bag, which a checkpoint carries, so the debugger's own resumes and rewinds keep it; the trace id would not do, since a caller can pass one and `AGENCY_TRACE_ID` gives a whole process tree one. The first run to reach a debug step while the debugger is attached owns it (`DebuggerState.owns`), and a step in any other run neither stops nor records a checkpoint: that run goes on as if no debugger were attached, under its own options, and the activity log says so once per ownership. A nested run of the same module, started from the debugged run's own JavaScript, is another run too, and is stepped over whole. When a run other than the last takes the debugger, the rolling window, the step target, and the pending overrides start empty, so a step back from its first stop cannot land in the last run's state. The last run's own continuation is not another run: a caller's resume mints a new key but remembers the one the checkpoint carried (`debugRunResumedFrom`), and a run resumed from the last owner keeps the window, so a step back from its first stop reaches before the interrupt the caller answered, and the replay raises that interrupt again. A checkpoint the attached debugger rewinds to becomes the stopped run's (`stampDebugRun` in `rewindTo`), whichever run recorded it, so `:load` of a file saved in an earlier session works attached; the key is the one thing the debugger tells runs apart by, and the replay installs the handlers and the policy as any resume does, so nothing else about the rewind changes. The stamp goes on a copy: a checkpoint the program pinned stays in the store as it was, with its signature, for a later resume, and the restore re-signs the copy it replays. The end of a run is reported to the person only when that run owned the debugger (`debugOwner` on the outcome). Two failures let the run go without an outcome to judge (`letGoOfDebugRun`, in `settleStops`, by the stop's key): the debugger's own UI throwing at a stop, and a leg the debugger resumed throwing before it had a context of its own, as a rewind whose restore throws does because the program's code changed since the checkpoint for one; without that the run would hold the debugger with no one to answer its stops, and no other run in the process would stop until a detach. The release lives in `settleStops` and not in the rewind, because the driver decides what a failed rewind means: a failed `:load` goes back to the stop, which still owns the debugger, so a run that starts meanwhile runs through rather than entering the same stop. Three rounds of review found a shared field each time runs were allowed to interleave on one driver: the leg options, then the window, then the overrides, the depth, and the `:save` target. Debugging two runs at once, with every per-stop field on one session object per run, is a follow-up (`debugger-future-work.md`).

One limit of the first version: `:save` and `:load` resolve their path in the program's process, which attached is the program's working directory. The channel, the trigger, the socket, and the `agency debug --attach` command are in `debugger-attach.md`.

### Module wrapper functions

The generated code exports wrapper functions bound to `__globalCtx` (see `imports.mustache`):

- `__setDebugger(dbg)` — sets `__globalCtx.debuggerState`
- `__getCheckpoints()` — returns `__globalCtx.checkpoints`
- `respondToInterrupts(interrupts, responses, opts)` — bound to `__globalCtx`
- `rewindFrom(checkpoint, overrides, opts)` — bound to `__globalCtx`

This avoids exporting `__globalCtx` directly.

## File layout

| File | Purpose |
|------|---------|
| `lib/cli/debug.ts` | CLI command: compile, load module, pick node, launch driver |
| `lib/debugger/driver.ts` | Driver loop, command handling, hook subscriptions |
| `lib/debugger/ui.ts` | Terminal UI (`lib/tui/`), keyboard input, rendering |
| `lib/debugger/uiState.ts` | UI state management (locals, globals, call stack, activity log) |
| `lib/debugger/overlays.ts` | Full-screen overlays (rewind selector, checkpoint panel) |
| `lib/debugger/util.ts` | `parseCommandInput()`, `formatValue()`, `coerceArg()` |
| `lib/debugger/types.ts` | `DebuggerCommand`, `DebuggerIO` types |
| `lib/debugger/debuggerState.ts` | `DebuggerState` class |
| `lib/debugger/testSession.ts` | Headless test harness — see [debugger-tests.md](./debugger-tests.md) |
| `lib/runtime/debugger.ts` | `debugStep()` function |
| `lib/runtime/runner.ts` | `maybeDebugHook()`, `Runner.debugger()` |

## Keyboard commands

| Key | Command |
|-----|---------|
| `s` or `→` | step; while the program runs, `s` stops it at its next statement |
| `n` | next (step over); while the program runs, `n` stops it at its next statement |
| `i` | step in |
| `o` | step out |
| `c` or `Space` | continue |
| `r` | rewind (checkpoint selector) |
| `d` | checkpoint panel |
| `k` | pin the current checkpoint, with an optional label |
| `p` | print variable |
| `z` | zoom the focused pane |
| `b` | pick a branch (a tool call, a fork branch, a parallel item) to look at |
| `t` | pick which message thread the threads pane shows |
| `[` / `]` | cycle which message thread the threads pane shows |
| `↑` / `↓` | scroll the focused pane; in the source pane, step back and step |
| `Tab` | cycle pane focus (`Shift+Tab` goes backwards) |
| `1`–`9` | focus a pane by position |
| `q` or `Esc` | quit |
| `:` | command mode |

Command mode accepts `set x = 42`, `checkpoint "label"`, `print x`, `reject [value]`, `resolve <val>`, `modify k=v`, `save <path>`, and `load <path>`. `parseCommandInput()` in `lib/debugger/util.ts` is the grammar.

## Known limitations

- **Async debugging**: out of scope. The debugger steps through the main execution path only.
- **TypeScript functions**: cannot step into them. The driver detects them (not in source map) and shows "Executing TypeScript: functionName()" in the activity log.
- **Conditional breakpoints**: not supported. Use `debugger("label")` statements in code for manual breakpoints.
- **Checkpoint rewind vs resume**: rolling checkpoints capture state before the step advances, while the interrupt checkpoint captures state after. This means rewinding to a checkpoint re-enters at that step, while resuming from an interrupt advances past it.
- **Several stops at once**: one is shown; the next command moves all of them (see "Stops inside a tool call").
- **`set` on a branch stack**: refused inside a tool call, a fork, or a parallel block.
- **`set` at one of the loop's own stops**: refused before a model request or a tool call. The frame shown there is the caller's, but an override would land on the loop's frame, the last one on the stack.
- **`debugger()` inside a handler body**: does not stop. A handler body has no step address a resume could re-enter, so the hook skips it, as it skips a callback body. A tool called from an `llm()` inside a handler body does not stop either.
- **Trace replay inside a tool call**: a trace records root-stack steps only.
