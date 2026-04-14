# Rewind: Retrospective Human Override of LLM Decisions

**Date:** 2026-03-21
**Status:** Draft

## Problem

LLM calls are probabilistic. In a chain of LLM calls, an incorrect decision at step N corrupts all downstream steps. Today, the only way to address this is to re-run the entire program from scratch — losing all the (potentially expensive and correct) LLM calls that preceded the bad decision.

Consider:

```agency
node main(message: string) {
  mood: "happy" | "sad" = llm("Categorize the user's mood: ${message}")
  response: string = llm("Respond to the user who is feeling ${mood}: ${message}")
  return response
}
```

If the user says "I feel fine" and the LLM categorizes the mood as "sad", the response will be "What's wrong?" — confusing the user. Today, the user has no way to say "the mood should have been happy" and see the corrected response without re-running the entire program (and paying for all the LLM calls again).

Interrupts solve a related problem — prospective human intervention before an action happens. Rewind solves the retrospective problem — correcting an LLM decision after the fact and replaying from that point.

## Motivation

### Every Agency program becomes debuggable by default

Because the compiler emits checkpoint infrastructure automatically (like it does for audit logs), every Agency program is rewindable without the developer writing any extra code. This is a compiler guarantee, not an opt-in feature.

### Correcting errors is cheaper than re-running

When a 10-step chain goes wrong at step 3, rewind lets you fix step 3 and only re-run steps 4-10. Steps 1-2 are preserved. This saves both time and cost.

### Training signal

Every rewind is a labeled correction: "the LLM said X, but the right answer was Y." This data can be collected to improve prompts, build evaluation sets, or fine-tune models.

### Builds on existing infrastructure

Rewind reuses the checkpoint system (state serialization, step counters, deserialize mode) that already exists for `checkpoint()`/`restore()` and interrupts. The implementation is small because the hard parts are already built.

## Design

### Overview

Rewind has three parts:

1. **Automatic checkpoint emission** — the compiler emits checkpoint data at every LLM call, sent to the caller via an `onCheckpoint` callback
2. **Checkpoint metadata** — each checkpoint includes information about the LLM call (step number, target variable, prompt, response) so the caller can display it and override the value
3. **`rewindFrom()` runtime function** — takes a checkpoint and a set of overrides, mutates the checkpoint state to inject them, and resumes execution from that point

### 1. `onCheckpoint` callback

A new lifecycle callback registered in `CallbackMap` and `AgencyCallbacks`:

```typescript
// lib/runtime/hooks.ts (addition to CallbackMap)
onCheckpoint: RewindCheckpoint;
```

This follows the same pattern as `onAuditLog` and all other callbacks: the callback is invoked via `callHook()`, which handles the async call and catches errors. The caller decides what to do with the checkpoint — store it in a database, keep it in memory, send it to a frontend, or discard it. No checkpoints accumulate in memory inside the runtime.

### 2. `RewindCheckpoint` type

```typescript
// lib/runtime/rewind.ts
import type { Checkpoint } from "./state/checkpointStore.js";

export type RewindCheckpoint = {
  checkpoint: Checkpoint;       // serialized StateStack + GlobalStore + nodeId
  llmCall: {
    step: number;               // the step counter value for this LLM call
    targetVariable: string;     // which local variable received the result (e.g. "mood")
    prompt: string;             // the prompt that was sent to the LLM
    response: unknown;          // what the LLM returned
    model: string;              // which model was used
  };
};
```

The `checkpoint` field is the same `Checkpoint` type used by `CheckpointStore` — it contains the serialized `StateStack`, `GlobalStore`, and `nodeId`. The `llmCall` field contains metadata the caller needs to display the decision and construct an override.

### 3. Compiler changes: emitting checkpoints at LLM calls

The builder (`lib/backends/typescriptBuilder.ts`) emits checkpoint + callback code at every LLM call site. This is the same approach used for audit log emission — the compiler injects it automatically.

For an Agency LLM call like:

```agency
mood: "happy" | "sad" = llm("Categorize the user's mood: ${message}")
```

The builder currently generates something like:

```typescript
if (__step <= 3) {
  __self.mood = await runPrompt({ prompt: `Categorize the user's mood: ${__self.message}`, ... });
  __stack.step++;
}
```

With rewind, the builder would emit additional code after the LLM call to create a checkpoint and invoke the callback via `callHook`:

```typescript
if (__step <= 3) {
  __self.mood = await runPrompt({ prompt: `Categorize the user's mood: ${__self.message}`, ... });

  // Rewind checkpoint (compiler-emitted)
  if (__ctx.callbacks.onCheckpoint) {
    const __cpId = __ctx.checkpoints.create(__ctx);
    const __cp = __ctx.checkpoints.get(__cpId);
    await callHook({
      callbacks: __ctx.callbacks,
      name: "onCheckpoint",
      data: {
        checkpoint: __cp,
        llmCall: {
          step: 3,
          targetVariable: "mood",
          prompt: `Categorize the user's mood: ${__self.message}`,
          response: __self.mood,
          model: __smoltalkConfig.model,
        },
      },
    });
    __ctx.checkpoints.delete(__cpId);  // don't accumulate — caller has the data
  }

  __stack.step++;
}
```

Key details:
- The `if (__ctx.callbacks.onCheckpoint)` guard avoids creating a checkpoint (which deep-clones the full state) when no callback is registered — zero overhead when the caller doesn't care about rewind.
- The checkpoint is emitted through `callHook`, going through the same code path as every other callback (error handling, async support, etc.).
- The checkpoint is created *after* the LLM call completes, so the state includes the LLM result in the local variables. This means when we rewind and override, we only need to replace the one variable and increment the step counter.
- The checkpoint is immediately deleted from the `CheckpointStore` after being sent to the callback. The caller owns the checkpoint data; the runtime doesn't retain it.
- The `step` value, `targetVariable`, and `prompt` are compile-time constants that the builder knows. `response` and `model` are runtime values.

**Note on checkpoint timing:** The checkpoint is taken *after* the LLM call, meaning the serialized state already contains the LLM result in `locals.mood`. When rewinding, `rewindFrom()` overwrites `locals.mood` with the override value and increments the step past this statement. This is simpler than checkpointing *before* the LLM call, which would require re-executing the call or adding a skip mechanism.

### 4. `rewindFrom()` runtime function

```typescript
// lib/runtime/rewind.ts
import { StateStack } from "./state/stateStack.js";
import { GlobalStore } from "./state/globalStore.js";
import { RuntimeContext } from "./state/context.js";
import { ThreadStore } from "./state/threadStore.js";
import { RestoreSignal } from "./errors.js";
import { createReturnObject } from "./utils.js";
import type { GraphState } from "./types.js";

export async function rewindFrom(args: {
  ctx: RuntimeContext<GraphState>;
  checkpoint: RewindCheckpoint;
  overrides: Record<string, unknown>;
  metadata?: Record<string, any>;
}): Promise<any> {
  const { ctx, overrides, metadata = {} } = args;
  const checkpoint = deepClone(args.checkpoint);

  // Mutate the checkpoint to inject the overrides
  const frame = checkpoint.checkpoint.stack.stack[checkpoint.checkpoint.stack.stack.length - 1];
  for (const [key, value] of Object.entries(overrides)) {
    frame.locals[key] = value;
  }
  frame.step = checkpoint.llmCall.step + 1;

  // Create execution context and restore state
  const execCtx = ctx.createExecutionContext();
  execCtx.restoreState(checkpoint.checkpoint);

  if (metadata.callbacks) {
    execCtx.callbacks = metadata.callbacks;
  }

  let nodeName = checkpoint.checkpoint.nodeId;

  await execCtx.audit({
    type: "rewind",
    nodeName,
    step: checkpoint.llmCall.step,
    overrides,
  });

  try {
    while (true) {
      try {
        const result = await execCtx.graph.run(
          nodeName,
          {
            messages: new ThreadStore(),
            data: {},
            ctx: execCtx,
            isResume: true,
          },
          { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) },
        );
        await execCtx.pendingPromises.awaitAll();
        return createReturnObject({ result, globals: execCtx.globals });
      } catch (e) {
        if (e instanceof RestoreSignal) {
          const cp = e.checkpoint;
          execCtx.restoreState(cp);
          await execCtx.audit({
            type: "restore",
            checkpointId: cp.id,
            nodeName: cp.nodeId,
          });
          nodeName = cp.nodeId;
          execCtx.stateStack.nodesTraversed = [cp.nodeId];
          continue;
        }
        throw e;
      }
    }
  } finally {
    execCtx.cleanup();
  }
}
```

The core of the override mechanism:

```typescript
for (const [key, value] of Object.entries(overrides)) {
  frame.locals[key] = value;
}
frame.step = checkpoint.llmCall.step + 1;
```

The `overrides` parameter is `Record<string, unknown>` — it can override any value in the checkpoint's locals, not just LLM call results. Since the checkpoint contains the full serialized state at that point (all local variables, computed values, function results, etc.), the caller can modify any of them. There is no distinction between LLM-derived and deterministic values in the serialized state.

This works because:
1. The checkpoint was taken *after* the LLM call, so all locals up to that point are in the serialized state
2. Setting `step` to `step + 1` causes the `if (__step <= N)` guard to skip the LLM call statement
3. The override values are placed directly in `locals`, where the generated code expects them to be
4. Execution continues from the next statement, making fresh LLM calls for all subsequent steps

No changes to `runPrompt`, `setupNode`, `setupFunction`, or the step counter mechanism are needed. The overrides are invisible to the rest of the runtime — it looks exactly like a normal checkpoint restore.

### 5. Audit logging

A new audit entry type for rewind events:

```typescript
// lib/runtime/audit.ts (addition to AuditEntry union)
export type RewindAudit = AuditBase & {
  type: "rewind";
  nodeName: string;
  step: number;
  overrides: Record<string, unknown>;
};
```

This is emitted by `rewindFrom()` before resuming execution. It records which values were overridden, providing a complete trail for debugging and analysis.

### 6. Export from runtime

`rewindFrom` is exported from `lib/runtime/index.ts` alongside `approveInterrupt`, `rejectInterrupt`, etc. It is a public API for TypeScript callers.

## Usage

### TypeScript API

```typescript
import { run, rewindFrom } from './mood-agent.agency.ts'

// Collect checkpoints during execution
const checkpoints = [];
const result = await run({
  args: { message: "I feel fine" },
  callbacks: {
    onCheckpoint(cp) {
      checkpoints.push(cp);
    }
  }
});

// result.output === "What's wrong?"
// checkpoints[0].llmCall === { step: 3, targetVariable: "mood", prompt: "...", response: "sad", model: "gpt-4o" }
// checkpoints[1].llmCall === { step: 5, targetVariable: "response", prompt: "...", response: "What's wrong?", model: "gpt-4o" }

// User sees "What's wrong?" and wants to correct the mood classification
const corrected = await rewindFrom({
  ctx,
  checkpoint: checkpoints[0],
  overrides: { mood: "happy" },
});
// corrected.output === "Glad to hear it!"
```

The `overrides` object can modify any value in the checkpoint's saved state — not just LLM results. For example, if a chain has multiple steps:

```typescript
// checkpoints[1] was taken after step 2, with entities and mood both in locals
const corrected = await rewindFrom({
  ctx,
  checkpoint: checkpoints[1],
  overrides: {
    mood: "happy",
    entities: ["dog", "sunny park"],  // also override a value from an earlier step
  },
});
```

### Web frontend integration

A developer building a chat UI would:

1. Register `onCheckpoint` to send checkpoints to the backend (or store in session)
2. Display an agent response to the user
3. Offer a "Why did you say that?" or "Debug" button that shows the checkpoint trail — each LLM decision with its prompt and response
4. Let the user select a checkpoint, modify the value, and hit "Redo"
5. Call `rewindFrom()` via an API endpoint and display the new response

The developer builds only the UI. The checkpoint data, serialization, and replay mechanics are provided by Agency. Because the checkpoint format is standardized (every Agency program produces the same `RewindCheckpoint` shape), reusable UI components could be built that work with any Agency agent.

### Rewind during a rewind

When `rewindFrom()` executes, it makes new LLM calls for all steps after the override point. The `onCheckpoint` callback fires for these new LLM calls, producing fresh checkpoints. This means the user can rewind a rewind — correcting a second decision after correcting the first. Each rewind produces a new set of checkpoints for the replayed portion. No special handling is needed; it falls out of the design naturally.

## Side effects

The main concern with rewind: what happens when execution replays past a side-effecting step?

```agency
node main(message: string) {
  mood = llm("Categorize: ${message}")
  sendEmail("Alert: user mood is ${mood}")
  response = llm("Respond to ${mood} user")
  return response
}
```

If the user rewinds to the `mood` checkpoint and overrides it, the `sendEmail` call will re-execute with the new mood value. The original email was already sent.

This is a known limitation that is inherent to any rewind/replay system (database point-in-time recovery has the same constraint — it can't unsend external effects). Three mitigations:

1. **Combine with interrupt gates.** If Agency enforces (via compiler guarantee or convention) that side-effecting operations go through interrupts, then rewinding is safe — side effects either haven't happened yet, or were explicitly approved and the user understands the consequences of replaying.

2. **Audit trail.** The rewind audit entry records exactly what was changed. The `onCheckpoint` callbacks during replay record what side effects re-executed. The user has full visibility.

3. **Documentation.** `rewindFrom` docs should note that side effects between the rewind point and the original execution endpoint will re-execute.

## Interaction with existing features

### Interrupts

Rewind and interrupts are complementary. Interrupts are prospective ("should I do this?"), rewind is retrospective ("you should have done something different"). They share the same underlying checkpoint/restore mechanism but serve different purposes.

If an LLM call that was overridden originally triggered an interrupt, the replayed execution may or may not trigger the same interrupt depending on the new value and code path.

### Message threads

When the checkpoint is taken after an LLM call, the thread state at that point is included in the serialized `StateStack`. Rewinding restores the thread to its state at the checkpoint. Subsequent LLM calls in the same thread will have the correct message history up to the rewind point, plus the overridden value, plus any new messages generated during replay.

### Async calls / parallel execution

Checkpoints call `pendingPromises.awaitAll()` before snapshotting (this is existing behavior from the checkpoint system). This means all parallel LLM calls have completed before the checkpoint is taken. Rewinding to a checkpoint that was taken after a parallel block will replay from after the block, not from within it.

If the overridden LLM call was one of several parallel calls, rewinding overrides only that one call's result. The other parallel calls' results are preserved in the checkpoint state.

### `checkpoint()` / `restore()`

These are orthogonal. `checkpoint()`/`restore()` is an in-language primitive for the developer to use explicitly. Rewind is an automatic, external mechanism. They share the same `CheckpointStore` and `restoreState()` infrastructure but don't interact directly.

## Interrupt state overrides

### Motivation

The same override mechanism that powers rewind can be applied to interrupts. When a user sees an interrupt, they may realize the agent's state is wrong — not just the interrupted action, but an upstream value. Currently they can only approve, reject, modify tool arguments, or resolve with a value. With state overrides, they can inspect the full program state and fix any variable before resuming.

The interrupt's checkpoint already contains the full serialized state (all locals, args, globals). This data is already available to the caller — it just needs a way to modify it before resumption.

### Design

Add an optional `overrides` parameter to `respondToInterrupt()` and thread it through the public API functions:

```typescript
export async function respondToInterrupt(args: {
  ctx: RuntimeContext<GraphState>;
  interrupt: Interrupt;
  interruptResponse: InterruptResponse;
  overrides?: Record<string, unknown>;  // NEW
  metadata?: Record<string, any>;
}): Promise<any> {
```

After retrieving the checkpoint but before calling `restoreState()`, apply the overrides:

```typescript
if (args.overrides) {
  const frame = checkpoint.stack.stack[checkpoint.stack.stack.length - 1];
  for (const [key, value] of Object.entries(args.overrides)) {
    frame.locals[key] = value;
  }
}

const execCtx = ctx.createExecutionContext();
execCtx.restoreState(checkpoint);
```

This is the same mutation pattern as `rewindFrom()`. Both should use a shared helper:

```typescript
// lib/runtime/rewind.ts
export function applyOverrides(
  checkpoint: Checkpoint,
  overrides: Record<string, unknown>,
): void {
  const frame = checkpoint.stack.stack[checkpoint.stack.stack.length - 1];
  for (const [key, value] of Object.entries(overrides)) {
    frame.locals[key] = value;
  }
}
```

### Public API

All four interrupt response functions gain an optional `overrides` parameter:

```typescript
await approveInterrupt({
  ctx,
  interrupt,
  overrides: { mood: "happy", confidence: 0.95 },
});

await resolveInterrupt({
  ctx,
  interrupt,
  value: "custom result",
  overrides: { previousAttempt: "sad" },
});
```

`rejectInterrupt` also accepts overrides for completeness, though it's less likely to be used (the caller might fix state and then reject, expecting the rejection path to use the corrected values).

## Implementation plan

### Files to create
- `lib/runtime/rewind.ts` — `RewindCheckpoint` type, `rewindFrom()` function, and `applyOverrides()` helper

### Files to modify
- `lib/runtime/hooks.ts` — add `onCheckpoint` to `AgencyCallbacks`
- `lib/runtime/audit.ts` — add `RewindAudit` to `AuditEntry` union
- `lib/runtime/index.ts` — export `rewindFrom` and `RewindCheckpoint`
- `lib/backends/typescriptBuilder.ts` — emit checkpoint + callback code after each LLM call
- `lib/runtime/interrupts.ts` — add `overrides?` parameter to `respondToInterrupt`, `approveInterrupt`, `rejectInterrupt`, `modifyInterrupt`, `resolveInterrupt`; use `applyOverrides()` helper
- `lib/ir/audit.ts` — add `"rewind"` case to `auditNode()` if needed

### Files that do NOT change
- `lib/runtime/prompt.ts` — no changes to `runPrompt`
- `lib/runtime/node.ts` — no changes to `setupNode` or `runNode`
- `lib/runtime/state/stateStack.ts` — no changes to step counter mechanism
- `lib/runtime/state/checkpointStore.ts` — used as-is
- `lib/runtime/state/context.ts` — `restoreState()` used as-is

## Testing strategy

### Unit tests

- `RewindCheckpoint` type construction and serialization
- `rewindFrom()` with a simple checkpoint and override value
- `rewindFrom()` audit entry emission
- `rewindFrom()` with invalid checkpoint (error handling)

### Integration tests (fixture pairs in `tests/agency/`)

1. **Basic rewind** — two-step chain, rewind to step 1, override value, verify step 2 re-executes with overridden input
2. **Rewind with message threads** — verify thread state is correctly restored and subsequent LLM calls in the same thread have correct history
3. **Rewind to first of N steps** — three-step chain, rewind to step 1, verify steps 2 and 3 both re-execute
4. **Rewind to middle step** — three-step chain, rewind to step 2, verify step 1 result is preserved and step 3 re-executes
5. **Rewind with function calls** — LLM call inside a `def` called from a node, verify checkpoint captures full call stack
6. **`onCheckpoint` callback fires for each LLM call** — verify callback is called N times for N LLM calls
7. **`onCheckpoint` not registered** — verify no errors and no overhead when callback is not set
8. **Rewind produces new checkpoints** — verify `onCheckpoint` fires during replay, producing fresh checkpoints for the replayed steps
9. **Rewind with parallel LLM calls** — verify only the targeted call is overridden, other parallel results are preserved
10. **Rewind with interrupts in replayed code** — verify interrupts in replayed steps still fire correctly

## Alternatives considered

### Storing checkpoints in the runtime

Instead of an `onCheckpoint` callback, accumulate checkpoints in a list on `RuntimeContext` and return them with the result. Rejected because it couples storage lifetime to execution lifetime and can consume unbounded memory for programs with many LLM calls. The callback pattern puts the caller in control of storage.

### Overriding via `runPrompt` interception

Instead of mutating the checkpoint state, store the override on `RuntimeContext` and have `runPrompt` check for it before making the LLM call. Rejected because it adds a check to the hot path of every LLM call and introduces new runtime state. The checkpoint mutation approach uses only existing mechanisms (step counters, state deserialization) with zero runtime changes.

### Checkpointing before the LLM call instead of after

Take the checkpoint before `runPrompt` executes, so the override would be applied by replacing the LLM call entirely. Rejected because it requires a mechanism to skip the LLM call during replay (either a flag on the context or a generated conditional), whereas checkpointing after the call means the step counter handles the skip naturally — incrementing the step past the LLM call statement is sufficient.

## Future work

- **Rewind UI component** — a reusable trace viewer / decision inspector that works with any Agency agent, since the `RewindCheckpoint` format is standardized
- **Correction collection** — automatically collect rewind overrides as labeled training data (original LLM output vs human correction) for prompt improvement or fine-tuning
- **Cost tracking** — show the user how much the rewind saved compared to a full re-run (sum of skipped LLM call costs from the checkpoint's token stats)
- **Conditional rewind** — programmatic rewind based on downstream validation failure (e.g., "if the final output fails validation, automatically rewind to the most impactful checkpoint and retry")
- **Override future LLM calls** — currently overrides only apply to values already in the checkpoint state (set at or before the checkpoint step). Overriding LLM calls at later steps would require storing pending overrides on the context and intercepting `runPrompt`
