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

`maybeDebugHook(id, label, isUserAdded)` runs before each step body. It returns early when the context has neither a debugger nor a trace writer, and when the runner is inside a tool call.

To avoid re-triggering on resume, it stores a flag in `frame.locals` under a per-step key. First entry sets the flag and fires the hook. On resume the flag is present, so the hook is skipped and the step body runs. `step()` deletes the flag only after the callback completes without halting, so a step that halts on a nested interrupt keeps its flag for the next resume.

When `debugStep()` returns an interrupt, the hook halts the runner. In node context it halts with `{ messages, data }`; in function context it halts with the raw interrupt.

### The `debugStep()` function (`lib/runtime/debugger.ts`)

Signature: `debugStep(ctx, info)`, where `info` carries `moduleId`, `scopeName`, `stepPath`, `label`, `nodeContext`, and `isUserAdded`. On every call it:

1. Returns `undefined` when the stack has no current node id. Global initialization runs outside any graph node, so there is nothing to checkpoint against.
2. Writes a trace checkpoint, independent of whether a debugger is attached. This is how `agency debug --trace` gets its recording.
3. Returns `undefined` if `ctx.debuggerState` is null (not in debug mode).
4. Takes a rolling checkpoint via `DebuggerState.createRollingCheckpoint()` for rewind history.
5. Decides whether to pause. When stepping, it pauses if the runner is at or below the target call depth. When running, it pauses only on a user-added `debugger()` breakpoint.
6. If pausing: creates a checkpoint on the regular `CheckpointStore` for interrupt resumption and returns a debug interrupt.

`debugStep()` does not advance the step counter. An earlier design called `StateStack.advanceDebugStep()` here so the resumed step guard would skip past the debug block. The `frame.locals` flag in `maybeDebugHook()` replaced it. `advanceDebugStep()` still exists on `StateStack` but the debugger no longer calls it.

### DebuggerState (`lib/debugger/debuggerState.ts`)

A class that encapsulates all debugger state. Owned by the driver, passed to the runtime via `metadata.debugger` on each interrupt resume. Stored on `RuntimeContext.debuggerState`.

Key state:
- `mode`: "stepping" or "running"
- `callDepth`: tracked via `onFunctionStart`/`onFunctionEnd` hooks
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

- **step/stepIn**: `mode = "stepping"`, no target. Pauses at the next `debugStep()`.
- **next**: `mode = "stepping"`, `targetDepth = callDepth`. Skips over function calls.
- **stepOut**: `mode = "stepping"`, `targetDepth = callDepth - 1`. Runs until current function returns.
- **continue**: `mode = "running"`. Runs until a user-placed `debugger()` statement.

Only Agency function calls (`def`) change call depth. If/else, loops, and match blocks are stepped through normally — they are not step-in targets.

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
- **Tool calls**: `maybeDebugHook()` returns early while the runner is inside a tool call, so the debugger does not step into tool dispatch.
