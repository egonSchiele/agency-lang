# Debugger Keyword and Debugger Mode

## Overview

Add a `debugger` keyword to Agency that functions as a special interrupt, plus a debugger mode that auto-inserts breakpoints before every step. This enables step-through debugging where callers can inspect and modify execution state at each pause.

## Design Principle

The debugger is implemented as a thin layer on top of the existing interrupt system. A `debugger` statement compiles to the same code as `return interrupt(label)`, with a `debugger: true` flag on the interrupt object. No new runtime resumption machinery is needed — callers use `approveInterrupt` with `overrides` to modify variables and continue, exactly as with regular interrupts.

## Syntax

```agency
debugger              // bare breakpoint
debugger("label")     // breakpoint with a label message
```

The `debugger` keyword can appear as a standalone statement anywhere a regular statement can: inside nodes, functions, if/else bodies, loops, handle blocks.

## AST Node Type

```typescript
type DebuggerStatement = {
  type: "debuggerStatement"
  label?: string
}
```

Added to the `AgencyNode` union in `lib/types.ts`. Parser lives in `lib/parsers/debuggerStatement.ts`.

## Debugger Mode

Activated via a compile-time config option:

```json
{
  "debugger": true
}
```

Adds `debugger?: boolean` to `AgencyConfig`.

When enabled, the builder's `processBodyAsParts()` inserts a `DebuggerStatement` node before each statement whose type is NOT in `TYPES_THAT_DONT_TRIGGER_NEW_PART`. This reuses the existing list that determines which statements create new steps (excluding `typeHint`, `comment`, `newLine`, `importStatement`, etc.), so debugger insertion is automatically consistent with step boundaries.

## Code Generation

The builder handles `debuggerStatement` in `processNode` by compiling it as an interrupt return with `debugger: true` set on the interrupt data object. It reuses the existing interrupt return code generation.

A bare `debugger` passes `undefined` as the data argument to the interrupt. `debugger("label")` passes the label string.

**Handlers are bypassed.** Unlike regular interrupts, debugger interrupts do NOT go through `interruptWithHandlers()`. They always create a checkpoint and return directly to the caller. This prevents `handle` blocks from silently auto-approving breakpoints, which would defeat the purpose of debugging.

The builder sets `debugger: true` on the interrupt object in the generated code after creating it. Example generated code for `debugger("checking mood")`:

```typescript
if (__step <= 3) {
  if (!__state.interruptData?.interruptResponse) {
    const __checkpointId = __ctx.checkpoints.create(__ctx);
    const __debugInterrupt = interrupt("checking mood");
    __debugInterrupt.debugger = true;
    __debugInterrupt.checkpointId = __checkpointId;
    __debugInterrupt.checkpoint = __ctx.checkpoints.get(__checkpointId);
    return { messages: __threads, data: __debugInterrupt };
  }
  // Resumed via approveInterrupt — clear response and continue
  __state.interruptData.interruptResponse = undefined;
  __stack.step++;
}
```

Each `debuggerStatement` gets its own step block. In debugger mode, this doubles the step count — this is acceptable since debugger mode is a development tool, not a production path.

`debuggerStatement` is NOT added to `TYPES_THAT_DONT_TRIGGER_NEW_PART` — each debugger gets its own step with its own checkpoint.

## Runtime Changes

### `Interrupt` type

Add an optional `debugger?: boolean` field to the existing `Interrupt` type:

```typescript
type Interrupt<T = any> = {
  type: "interrupt"
  data: T
  debugger?: boolean           // NEW
  interruptData?: InterruptData
  checkpointId?: number
  checkpoint?: Checkpoint
  state?: InterruptState
}
```

### `isDebugger()` function

A convenience function exported from the runtime:

```typescript
function isDebugger(value: unknown): value is Interrupt {
  return isInterrupt(value) && value.debugger === true
}
```

## Caller Usage

From the caller's perspective, a debugger breakpoint looks like a regular interrupt with extra metadata:

```typescript
import { main, approveInterrupt, isDebugger, isInterrupt } from "./agent.js"

const result = await main("hello")

if (isDebugger(result.data)) {
  // Inspect checkpoint state (locals, globals, etc.)
  console.log(result.data.checkpoint)

  // Optionally modify variables, then continue
  const resumed = await approveInterrupt(result.data, {
    overrides: { mood: "happy" }
  })
}
```

The caller controls the UI — this works in CLI, web, or any other context. The runtime just pauses and returns data.

## Changes by File

| Area | Files | Change |
|------|-------|--------|
| **AST type** | `lib/types/debuggerStatement.ts`, `lib/types.ts` | New `DebuggerStatement` node type, add to `AgencyNode` union |
| **Parser** | `lib/parsers/debuggerStatement.ts`, `lib/parser.ts` | Parse `debugger` keyword with optional string arg |
| **Config** | `lib/config.ts` | Add `debugger?: boolean` to `AgencyConfig` |
| **Builder** | `lib/backends/typescriptBuilder.ts` | Handle `debuggerStatement` in `processNode` (compile as interrupt with `debugger: true`). In `processBodyAsParts`, insert debugger steps when config flag is on, reusing `TYPES_THAT_DONT_TRIGGER_NEW_PART` |
| **Runtime** | `lib/runtime/interrupts.ts` | Add `debugger?: boolean` to `Interrupt` type. Add `isDebugger()` function |
| **Runtime exports** | `lib/runtime/index.ts` | Export `isDebugger` |
| **Formatter** | `lib/backends/agencyGenerator.ts` | Handle `debuggerStatement` in formatting |
| **Type checker** | `lib/typeChecker.ts` | Recognize `debuggerStatement` as a valid statement (no type produced) |
| **Audit** | `lib/runtime/interrupts.ts`, `lib/runtime/rewind.ts` | Emit audit entry when overrides are applied — covers interrupt overrides, debugger variable modifications, and rewind overrides |
| **Tests** | `tests/agency/`, `tests/agency-js/` | See Testing section |

## Testing

### Explicit debugger keyword tests

- `debugger` bare statement — pauses, returns interrupt with `debugger: true`, resumes on approve
- `debugger("label")` — same but with label in interrupt data
- `debugger` with variable override on resume — approve with overrides, verify modified value is used
- `debugger` inside if/else, loops, threads — works with substeps
- `debugger` inside a function called from a node — works across call stack
- Multiple `debugger` statements in sequence — each pauses and resumes correctly
- `debugger` inside a `handle` block — verify the handler is NOT invoked and the breakpoint pauses as expected

### Debugger mode tests

- Config `debugger: true` — every step gets a breakpoint before it
- Verify step count matches expected number of breakpoints
- Resume through all breakpoints with approve — produces same result as without debugger mode
- Resume with variable override mid-execution — changes subsequent behavior

### `isDebugger()` tests

- Returns `true` for debugger interrupts
- Returns `false` for regular interrupts
- Returns `false` for non-interrupt values
