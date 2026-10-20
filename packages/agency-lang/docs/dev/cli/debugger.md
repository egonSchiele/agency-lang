# Interactive Debugger

The interactive debugger lets users step through `.agency` source code line by line, inspect and modify variables, and rewind execution to previous states. It runs as a terminal UI via the `agency debug` CLI command.

## Usage

```bash
agency debug <file> [--node <name>] [--rewind-size 30] [--trace <file>] [--checkpoint <file>] [--dist-dir <dir>] [run flags]
```

The command is hidden from `agency --help`, but it works. If the file has multiple nodes, the user picks one interactively. If the node has parameters, the debugger prompts for their values.

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

`agency debug` also sets `{ debugger: true }` on the config it compiles with. Nothing in the builder or runtime reads that field today; instrumentation is on by default, so the flag is currently inert.

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

The call stack pane still shows the hook-fed entries (`onFunctionStart`), not the branch path. `set` is refused at a stop on a branch stack (a tool call, a fork, or a parallel block), because a resume applies overrides to the root's last frame.

### User code interrupts

If the program hits a non-debug `interrupt()` while debugging, the driver detects it (`isInterrupt` but not `isDebugger`), shows the interrupt data, and asks for an answer: approve, reject, or resolve with a value. When several branches raised at once (parallel tool calls, a fork, a `parallel` block), the batch holds several interrupts and the runtime insists on one response per interrupt. The driver asks about each in turn, `Interrupt (1 of 2): A?` then `(2 of 2)`, and sends one `respondToInterrupts` call with the answers in the batch's order (`DebuggerDriver.respond`). A debug stop in the same batch is answered with an approve.

A guard trip (`std::guard`, see `docs/site/guide/guards.md`) is answered through a form (`showGuardTripForm` in `lib/debugger/overlays.ts`), since a bare approve would be refused by the runtime. The form says which guard tripped, what it spent against its limit, and what a reject may return (a preview of the saved draft, which a `finalize` can replace), then offers three choices: approve with more budget, remove the tripped limit, or reject. A grant asks for the amount, in dollars or as a duration (`30s`, `2m`, or milliseconds), and refuses it on screen while it would leave the budget still exceeded, which is the answer the runtime would throw on; both approvals then ask for an optional message to the model. The pieces the form is built from, the choices, the amount reader, the grant check, and the response (`approve({ maxCost | maxTime, disarm, message })` or `reject`), are plain functions in `lib/debugger/guardAnswer.ts`. Only the tripped dimension is asked about.

A raise used as a value (`const x = raise ...`, which the runtime marks `expectsValue`; `question` from `std::agent` is one) wants an answer rather than an approve or a reject. The activity log shows the question, the prompt is `answer:`, and the typed text is the answer, as a string, the way the CLI's approval prompt takes it. `resolve <json>` gives a JSON value when the rest parses as JSON, so `resolve 7` is the number and "resolve the conflict by hand" stays whole; `reject` (or `r`) rejects, `approve` (or `a`) resolves the variable to `true`, and an empty answer is asked for again. The raise's data is shown after the question when it says more than the message, such as the options of a choice.

### Source mapping

The builder records source locations in a `SourceMap` exported as `__sourceMap` from the compiled module. Keys are `"moduleId:scopeName"`, values map step paths to `{line, col}`. The UI uses this to highlight the current line in the source pane. For cross-file debugging, the UI loads the new file when the `moduleId` changes.

### Metadata plumbing

`DebuggerState` is passed via `metadata.debugger` on `respondToInterrupts` and `rewindFrom` calls. Two functions copy it onto the new `RuntimeContext`:

- `respondToInterruptsCore()` in `lib/runtime/interrupts.ts`
- `rewindFrom()` in `lib/runtime/rewind.ts`

`RuntimeContext.createExecutionContext()` also copies `this.debuggerState` to the new context, so `runNode()` execution contexts inherit the debugger state.

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
| `s` or `→` | step |
| `n` | next (step over) |
| `i` | step in |
| `o` | step out |
| `c` or `Space` | continue |
| `r` | rewind (checkpoint selector) |
| `d` | checkpoint panel |
| `k` | pin the current checkpoint, with an optional label |
| `p` | print variable |
| `z` | zoom the focused pane |
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
