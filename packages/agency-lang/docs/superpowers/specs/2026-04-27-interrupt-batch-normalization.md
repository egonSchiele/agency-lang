# Interrupt Batch Normalization

## Summary

Normalize all interrupt handling to use `Interrupt[]` (arrays) everywhere internally. Eliminate the dual single/array representation that causes bugs at every boundary.

## Motivation

The current codebase has interrupts represented as both `Interrupt` (single) and `Interrupt[]` (array) depending on context. Every boundary between these representations is a bug source — `isInterrupt` vs `hasInterrupts` checks, type casts, array wrapping/unwrapping. During the fork parallel interrupts work, we found ~10 places that needed patching for this duality.

## Design

### Core principle

Interrupts are always `Interrupt[]`. A single interrupt is `[interrupt]`. There is no concept of a "single interrupt" in the internal API.

### Handler functions

Handlers still process one interrupt at a time. `interruptWithHandlers` is called once per interrupt. The handler function signature doesn't change — handlers receive the interrupt's `data` payload, not the interrupt object or array.

### Debug interrupts

Debug interrupts are always single-element arrays `[debugInterrupt]`. There is no case where multiple debug interrupts occur simultaneously.

### `isInterrupt` becomes internal

`isInterrupt` is no longer part of the public API. Users use `hasInterrupts` to check `result.data`. `isInterrupt` remains as an internal utility (inside `hasInterrupts`, inside handler result checking, etc.).

## Changes needed

### Creation points — return `Interrupt[]`

| File | Line | What | Change |
|------|------|------|--------|
| `lib/runtime/interrupts.ts` | 129-179 | `interruptWithHandlers()` returns `Interrupt \| Approved \| Rejected` | Return `Interrupt[] \| Approved \| Rejected` |
| `lib/runtime/debugger.ts` | 117-122 | `debugStep()` creates single debug interrupt | Wrap in array |

The `interrupt()` and `createDebugInterrupt()` factory functions can still create single `Interrupt` objects — they're building blocks. The normalization to array happens at the boundary where interrupts are returned to callers.

### Propagation points — always `Interrupt[]`

| File | What | Change |
|------|------|--------|
| `lib/runtime/prompt.ts` `ExecuteToolCallsResult` | Type has `interrupt: Interrupt` | Change to `interrupts: Interrupt[]` |
| `lib/runtime/prompt.ts` `executeToolCalls` | Two branches: `isInterrupt(result)` and `hasInterrupts(result)` | Unify: normalize single to array, always return array |
| `lib/runtime/prompt.ts` `runPrompt` | `Array.isArray(interrupt)` branch for propagation | Remove branching, always handle array |
| `lib/runtime/runner.ts` pipe operation | Checks `isInterrupt(result)` | Change to `hasInterrupts` |
| Generated code (builder) | `isInterrupt(x) \|\| hasInterrupts(x)` checks | Simplify to `hasInterrupts(x)` |
| `lib/runtime/node.ts` `runNode` | Wraps single interrupt in array | Remove — upstream already returns array |

### Consumption points

| File | What | Change |
|------|------|--------|
| `lib/debugger/driver.ts` | Unwraps array, casts to single `Interrupt` | Work with `Interrupt[]` natively, process first element for debugger (always single-element) |
| `lib/debugger/driver.ts` `ModuleFunctions` | Type signatures accept single `Interrupt` | Update to `Interrupt[]` |
| Evaluate templates | Already handle arrays | No change |

### Interrupt templates (interruptReturn, interruptAssignment)

These run inside individual threads and create/handle one interrupt at a time. They should continue to work with single interrupts internally, but when propagating (the `runner.halt(...)` call), they should wrap in an array:

```
// Currently:
runner.halt(__handlerResult);

// After:
runner.halt([__handlerResult]);
```

### Public API

No change — `result.data` is already `Interrupt[]`, `respondToInterrupts` already accepts arrays, `hasInterrupts` is the public type guard.

### What to remove after normalization

- All `isInterrupt(x) || hasInterrupts(x)` dual checks → just `hasInterrupts(x)`
- All `if (isInterrupt(x)) { x = [x]; }` normalization patches
- `isInterrupt` from public exports (keep as internal utility)

## Known skipped tests that may be unblocked by this work

- `lib/debugger/driver.test.ts` — 37 tests skipped, debugger needs batch API migration
- `tests/agency/fork/fork-after-node-transition` — fork interrupts after node transition
- `tests/agency/fork/race-interrupt` — race with interrupt resume
- `tests/agency/fork/fork-llm-tool-nested` — fork interrupts inside LLM tool calls
- `tests/agency/fork/fork-llm-deep-loop` — deep nesting of LLM, tool, fork, interrupt

## Related docs

- `docs/superpowers/specs/2026-04-26-fork-parallel-interrupts-design.md` — original fork parallel interrupts spec
- `docs/superpowers/specs/2026-04-27-interrupt-consolidation-notes.md` — consolidation notes (interrupt response lookup, checkpoint creation, type unification)
