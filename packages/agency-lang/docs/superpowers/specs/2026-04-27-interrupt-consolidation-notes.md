# Interrupt Consolidation Notes

Future work to reduce the number of code paths for interrupt handling.

## 1. Consolidate interrupt response lookup

Currently there are two ways a function finds its interrupt response on resume:
- `ctx.getInterruptResponse(interruptId)` — new path, used by fork threads
- `__state.interruptData.interruptResponse` — old path, used by non-fork calls and node transitions

Goal: single lookup path. All interrupt responses go through `ctx.getInterruptResponse()`. Remove `interruptData.interruptResponse` entirely. This requires ensuring the interruptId is always available on the frame at resume time, including for non-fork functions where the frame gets popped and recreated.

## 2. Consolidate checkpoint creation for interrupts

Currently checkpoints are created in multiple places:
- Per-interrupt checkpoint in the interrupt template (inside the function, before frame pop)
- Shared fork checkpoint in `Runner.fork()` (after all threads finish)
- Rolling checkpoints in the debugger

Goal: reduce to fewer, well-defined checkpoint creation points. Consider whether the per-interrupt checkpoint and fork checkpoint can be unified.

## 3. Consolidate handler result and interrupt response types

Handler builtins return `{ type: "approved" }` (past tense). Interrupt response constructors return `{ type: "approve" }` (imperative). These should be the same type: `"approve"`.

This requires updating `interruptWithHandlers` which checks for `result.type === "approved"` / `"rejected"` / `"propagated"`.
