# Interactive Debugger

The interactive debugger lets users step through `.agency` source code line by line, inspect and modify variables, and rewind execution to previous states. It runs as a terminal UI via the `agency debug` CLI command.

## Usage

```bash
agency debug <file> [--node <name>] [--rewind-size 30] [--trace <file>] [--checkpoint <file>] [--dist-dir <dir>]
```

The command is hidden from `agency --help`, but it works. If the file has multiple nodes, the user picks one interactively. If the node has parameters, the debugger prompts for their values.

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

To avoid re-triggering on resume, it stores a flag in `frame.locals` under a per-step key. First entry sets the flag and fires the hook. On resume the flag is present, so the hook is skipped and the step body runs. `step()` deletes the flag only after the callback completes without halting, so a step that halts on a nested interrupt keeps its flag for the next resume.

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

A step's depth is how many Agency calls deep the run is, read from `run.callDepth`, the counter `withCallDepth` keeps on every call (see `lib/runtime/callDepth.ts`). The node's statements are at 0, a called `def`'s at 1, and a tool's at one more than the function that called `llm()`, so `step in` from an `llm()` line lands on the tool's first statement. The counter follows the lineage of calls, not a global count, so two tools running at once each have their own depth, and a resume rebuilds it as the calls re-enter. If/else, loops, match blocks, `thread` blocks, and the branches of a `fork` or `parallel` block are at their enclosing block's depth and are stepped through normally: `next` at a `fork` statement stops at the first statement of a branch, as it does for a loop body.

### Stops inside a tool call

A tool is a `def` called by the loop `runPrompt` runs for `llm()`. Its body runs on a branch stack under the `runPrompt` frame, and its statements are steps like any other, so the hook fires there and a stop inside it is an ordinary debug interrupt. It travels the path a tool's own interrupt travels: the tool loop records it on the branch, `runBatch` stamps the shared checkpoint at the join, `PromptRunner` bails out, and the node halts. On resume the `__dbg_` flag in the stopped frame makes the hook skip, so the tool finishes and its result reaches the thread once.

Two things make the driver work at such a stop:

- **The branch path.** Every checkpoint records `branchPath`, the branch keys from the root down to the stack the step ran on (`["tool_0_call_abc"]` for a tool, `["tool_0_call_abc", "fork_1"]` for a fork inside it). `Checkpoint.getCurrentFrame()` follows it, so the locals pane, `print`, `removeDebugFlagsFor`, and the rewind list all find the frame the step ran in. A branch stack derives the path from `parent`, the link to the stack it branched from that `runBatch` sets when it starts the branch; the path is serialized on the checkpoint only.
- **The stop record.** After the join, the interrupt's `checkpoint` is the shared one, whose location is the loop's. The interrupt's `data` (`DebugStopData` in `lib/runtime/debugger.ts`) says where the stop really is and how deep it is. The driver sets `stopDepth` from it when it shows the stop, and passes it to `UIState.setCheckpoint(checkpoint, stop)`, which reads the source line from the stop and the frame from `checkpoint.frameAt(stop.branchPath)`. A rolling checkpoint carries its own path, so the rewind list and `step back` need no stop record.

Rolling checkpoints inside a tool are keyed by location including the path, so two calls of the same tool in different rounds each keep their rewind entries, bounded by the store's eviction limit. `removeDebugFlagsFor` strips the flags of the stopped frame only: `main` keeps its flag for the `llm()` statement so a rewind replays through it into the loop and the tool, and a sibling branch keeps its flag so it replays past its own stop. `step back` (`CheckpointStore.findBefore`) rewinds to a step on the stopped stack or on a stack above it, so from inside one tool of a round it never lands in the other tool.

A rolling checkpoint taken inside a tool must carry the replies of the tools that have already finished, or a rewind would send the model a call with no reply. The tool loop keeps the thread in its frame as `messagesJSON`, refreshed when it checkpoints; for a checkpoint built from elsewhere, `runPrompt` registers a refresher in `ctx.beforeCheckpoint` for the life of the call, and `CheckpointStore.create` runs the list before it copies the stack.

Several branches can stop at once: in stepping mode every Agency tool in a round stops at its next step, so the batch holds one debug interrupt per tool. Until the driver can answer a batch (ADI-18), it keeps the first and drops the rest. That is safe, since the resume never looks up a debug interrupt's answer and an unanswered real interrupt is asked again when its tool replays, but the person sees one stop out of several.

The call stack pane still shows the hook-fed entries (`onFunctionStart`), not the branch path. `set` is refused at a stop on a branch stack (a tool call, a fork, or a parallel block), because a resume applies overrides to the root's last frame.

### User code interrupts

If the program hits a non-debug `interrupt()` while debugging, the driver detects it (`isInterrupt` but not `isDebugger`) and shows the interrupt data. The user can approve (step/continue), reject (`:reject`), resolve (`:resolve <value>`), or modify (`:modify key=value`).

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
- **Between tool calls**: the loop's own steps, one per model request and one per tool call, do not call the hook yet, so there is no stop between "the model answered" and "the next tool runs". `step` from the `llm()` line lands on the first statement of the first Agency tool that runs.
- **Several stops at once**: one is shown (see "Stops inside a tool call").
- **`set` on a branch stack**: refused inside a tool call, a fork, or a parallel block.
- **`debugger()` inside a handler body**: does not stop. A handler body has no step address a resume could re-enter, so the hook skips it, as it skips a callback body. A tool called from an `llm()` inside a handler body does not stop either.
- **Trace replay inside a tool call**: a trace records root-stack steps only.
