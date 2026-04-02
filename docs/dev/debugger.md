# Interactive Debugger

The interactive debugger lets users step through `.agency` source code line by line, inspect and modify variables, and rewind execution to previous states. It runs as a terminal UI via the `agency debug` CLI command.

## Usage

```bash
agency debug <file.agency> [--node <name>] [--rewind-size 30]
```

If the file has multiple nodes, the user picks one interactively. If the node has parameters, the debugger prompts for their values.

## Architecture

Three layers:

```
+-----------------------------------------+
|  UI (blessed)         lib/debugger/ui.ts |
+-----------------------------------------+
|  Driver               lib/debugger/driver.ts |
+-----------------------------------------+
|  Runtime              lib/runtime/debugger.ts |
+-----------------------------------------+
```

**Runtime**: The builder inserts `debugStep()` calls at every step boundary in the generated code. `debugStep()` takes rolling checkpoints and conditionally fires interrupts to pause execution.

**Driver**: A loop that catches debug interrupts, feeds state to the UI, waits for user commands, and resumes execution via `approveInterrupt()`.

**UI**: A blessed terminal application with panes for source code, locals/globals, call stack, activity log, and stdout.

## How it works

### Compilation

When `agency debug` runs, it compiles the `.agency` file with `{ debugger: true }` in the config. This triggers two things in the builder:

1. `processDebuggerStatement()` emits a `debugStep()` call (via the `debugger.mustache` template) instead of a no-op.
2. `insertDebugSteps()` inserts synthetic `debuggerStatement` AST nodes before every step-triggering statement in all body processors: `processBodyAsParts`, `processIfElseWithSteps`, `processForLoopWithSteps`, `processWhileLoopWithSteps`, `processMessageThread`, and `processHandleBlockWithSteps`.

The synthetic nodes borrow the `loc` of the statement they precede so the source map points to the line about to execute. This is intentional and non-standard — normally a node's `loc` reflects its own position. This should be documented in code comments wherever `insertDebugSteps` is called.

The generated code looks like:

```typescript
if (__step <= 1) {
  const __dbg = await debugStep(__ctx, __state, {
    moduleId: "foo.agency",
    scopeName: "main",
    stepPath: "1",
    label: null,
    nodeContext: true,
  });
  if (__dbg) {
    return { messages: __threads, data: __dbg };
  }
  __stack.step++;
}
```

### The `debugStep()` function (`lib/runtime/debugger.ts`)

This is the core runtime function. On every call it:

1. Clears any `interruptData.interruptResponse` left from a previous resume (prevents downstream code like `runPrompt` from mistaking it for a tool call response).
2. Returns `undefined` if `ctx.debugger` is null (not in debug mode).
3. Takes a rolling checkpoint via `DebuggerState.createRollingCheckpoint()` for rewind history.
4. Decides whether to pause based on mode (stepping vs running), labels (user breakpoints), and step targets (for next/stepOut).
5. If pausing: advances the step counter via `StateStack.advanceDebugStep()`, creates a checkpoint on the regular `CheckpointStore` for interrupt resumption, and returns a debug interrupt.

### Step/substep advancing (`StateStack.advanceDebugStep`)

When `debugStep()` pauses, it needs to advance the step counter so that on resume the generated code's step guard (`if (__step <= N)`) skips past the debug step block. The counter to increment depends on the nesting level:

- `stepPath "3"` → top-level step → increments `frame.step`
- `stepPath "4.0"` → substep inside step 4 → sets `frame.locals.__substep_4 = 1`
- `stepPath "4.0.2"` → nested substep → sets `frame.locals.__substep_4_0 = 3`

The naming convention matches the builder's generated code: all path segments except the last form the variable name (`__substep_` + segments joined by `_`), and the value is set to `lastSegment + 1`.

### DebuggerState (`lib/debugger/types.ts`)

A class that encapsulates all debugger state. Owned by the driver, passed to the runtime via `metadata.debugger` on each interrupt resume. Stored on `RuntimeContext.debugger`.

Key state:
- `mode`: "stepping" or "running"
- `callDepth`: tracked via `onFunctionStart`/`onFunctionEnd` hooks
- `stepTarget`: for next/stepIn/stepOut commands — stores the target depth
- `checkpoints`: a `DebugCheckpointStore` with rolling window

### DebugCheckpointStore (`lib/runtime/state/debugCheckpointStore.ts`)

Separate from the regular `CheckpointStore` so that user-code `rewind` (which calls `invalidateAfter()`) doesn't wipe debugger history. Uses a rolling window (default 30). Pinned checkpoints are exempt from eviction.

Methods: `createRolling()`, `createPinned()`, `pin()`, `get()`, `getAll()`.

### The driver loop (`lib/debugger/driver.ts`)

```
run program → hits debugStep() → interrupt returned
  → extract interrupt from result.data (runNode wraps in { messages, data, tokens })
  → render UI
  → wait for user command
  → handle command (resume, rewind, set variable, etc.)
  → loop
```

The driver uses the compiled module's exported wrapper functions (`approveInterrupt`, `respondToInterrupt`, `rewindFrom`, `__setDebugger`, `__getCheckpoints`) rather than accessing `__globalCtx` directly.

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

`DebuggerState` is passed via `metadata.debugger` on `approveInterrupt`, `respondToInterrupt`, and `rewindFrom` calls. The following functions copy it onto the new `RuntimeContext`:

- `respondToInterrupt()` in `lib/runtime/interrupts.ts`
- `resumeFromState()` in `lib/runtime/interrupts.ts`
- `rewindFrom()` in `lib/runtime/rewind.ts`

`RuntimeContext.createExecutionContext()` also copies `this.debugger` to the new context, so `runNode()` execution contexts inherit the debugger state.

### Module wrapper functions

The generated code exports wrapper functions bound to `__globalCtx` (see `imports.mustache`):

- `__setDebugger(dbg)` — sets `__globalCtx.debugger`
- `__getCheckpoints()` — returns `__globalCtx.checkpoints`
- `approveInterrupt(interrupt, opts)` — bound to `__globalCtx`
- `respondToInterrupt(interrupt, response, opts)` — bound to `__globalCtx`
- `rewindFrom(checkpoint, overrides, opts)` — bound to `__globalCtx`

This avoids exporting `__globalCtx` directly.

## File layout

| File | Purpose |
|------|---------|
| `lib/cli/debug.ts` | CLI command: compile, load module, pick node, launch driver |
| `lib/debugger/driver.ts` | Driver loop, command handling, hook subscriptions |
| `lib/debugger/ui.ts` | Blessed terminal UI, keyboard input, rendering |
| `lib/debugger/uiState.ts` | UI state management (locals, globals, call stack, activity log) |
| `lib/debugger/types.ts` | `DebuggerState` class |
| `lib/runtime/debugger.ts` | `debugStep()` function |
| `lib/runtime/state/debugCheckpointStore.ts` | Rolling checkpoint store with pinning |

## Keyboard commands

| Key | Command |
|-----|---------|
| `s` | step |
| `n` | next (step over) |
| `i` | step in |
| `o` | step out |
| `c` | continue |
| `r` | rewind (checkpoint selector) |
| `k` | pin checkpoint |
| `p` | print variable |
| `Tab` | cycle pane focus |
| `q` | quit |
| `:` | command mode (`set x = 42`, `checkpoint "label"`, `reject`, `resolve <val>`, `modify k=v`) |

## Known limitations

- **Async debugging**: out of scope. The debugger steps through the main execution path only.
- **TypeScript functions**: cannot step into them. The driver detects them (not in source map) and shows "Executing TypeScript: functionName()" in the activity log.
- **Conditional breakpoints**: not supported. Use `debugger("label")` statements in code for manual breakpoints.
- **Checkpoint rewind vs resume**: rolling checkpoints capture state before the step advances, while the interrupt checkpoint captures state after. This means rewinding to a checkpoint re-enters at that step, while resuming from an interrupt advances past it.
- **interruptResponse clearing**: when resuming from a debug interrupt, `debugStep()` clears `state.interruptData.interruptResponse` to prevent downstream code (like `runPrompt`) from interpreting it as a tool call response.
