# runPrompt State Stack Integration

## Summary

Make `runPrompt` participate in the state stack like any other Agency function. It gets its own frame, stores locals on it, creates branches for tool calls, and creates checkpoints when interrupts occur. This eliminates the `interruptData` passthrough from `respondToInterrupts` → `graph.run()` and lays groundwork for parallel tool calls.

## Motivation

Currently `runPrompt` is a runtime black box that doesn't participate in the state stack. It relies on `interruptData` passed from outside (through `respondToInterrupts` → `graph.run()` → node → `runPrompt`) to resume after tool call interrupts. This has several problems:

1. The `interruptData` passthrough is a single-interrupt bottleneck — it can only carry one tool call's context, blocking parallel tool calls.
2. `respondToInterrupts` has count-based branching (`if (interrupts.length === 1)`) to decide whether to build `interruptData`.
3. Non-tool-call interrupts crash with "Interrupt data is present but no tool call found" when `interruptData` is an empty object.
4. The debugger can't step through `runPrompt` — it's invisible.

The fix: `runPrompt` works like any other function. It pushes a frame, stores its state, creates branches for tool calls, and creates checkpoints. No special resume mechanism needed.

## Design

### runPrompt gets a frame

`runPrompt` calls `setupFunction` at entry to get its own frame on the state stack:

```typescript
const { stateStack, stack, step } = setupFunction({
  state: { stateStack: args.stateStack, ctx }
});
const self = stack.locals;

// Restore or initialize locals
self.messages = self.messages ?? initialMessages;
self.toolCallRound = self.toolCallRound ?? 0;
self.toolErrorCounts = self.toolErrorCounts ?? {};
self.removedTools = self.removedTools ?? removedTools;
```

On first run, locals initialize from function arguments. On resume from checkpoint, `setupFunction` deserializes the frame and locals are already populated.

The `stateStack` parameter comes from the caller (generated code passes `__stateStack`), falling back to `ctx.stateStack`. Fork threads pass their branch stack, so `runPrompt` pushes its frame onto the correct stack — just like any other function.

At exit, `stateStack.pop()` removes the frame. If halted due to interrupt, the frame stays (same as fork thread behavior).

### Tool calls get branches

Each tool call gets its own branch in `stack.branches` — the same data structure fork uses:

```typescript
if (!stack.branches) stack.branches = {};

for (const toolCall of toolCalls) {
  const branchKey = `tool_${toolCall.id}`;
  const existing = stack.branches[branchKey];

  if (existing?.result !== undefined) {
    // Already completed in a previous interrupt cycle — use cached result
    continue;
  }

  const branchStack = existing ? existing.stack : new StateStack();
  if (existing) branchStack.deserializeMode();
  else stack.branches[branchKey] = { stack: branchStack };

  // Execute tool function with the branch stack
  const result = await handler.invoke(args, {
    ctx,
    threads: new ThreadStore(),
    stateStack: branchStack,
    isForked: true,  // tells interrupt templates to just propagate
  });

  if (hasInterrupts(result)) {
    interrupts.push(...result);
    stack.branches[branchKey].interruptId = result[0].interruptId;
  } else {
    stack.branches[branchKey].result = { result };
    // send tool result message to LLM
  }
}
```

Key points:
- `isForked: true` replaces `isToolCall: true`. Interrupt templates just propagate — they don't create checkpoints or handle reject.
- Completed tool call results are cached in `branch.result` (survives interrupt cycles), same pattern as fork.
- On resume, branches with cached results are skipped; interrupted branches get their stack deserialized.
- Branch cleanup happens after all tool calls complete for a round.

### Checkpoint creation and interrupt handling

When any tool call produces an interrupt, `runPrompt` creates a single checkpoint (like fork) and attaches it to all interrupts:

```typescript
if (interrupts.length > 0) {
  const cpId = ctx.checkpoints.create(ctx, {
    moduleId: checkpointInfo?.moduleId ?? "",
    scopeName: checkpointInfo?.scopeName ?? "",
    stepPath: checkpointInfo?.stepPath ?? "",
  });
  const cp = ctx.checkpoints.get(cpId);
  for (const intr of interrupts) {
    intr.checkpoint = cp;
    intr.checkpointId = cpId;
  }
  return interrupts;  // propagate up — caller halts
}
```

The checkpoint captures the full state stack, which includes `runPrompt`'s frame (with `messages`, `toolCallRound`, `removedTools`, etc.) and each tool call's branch state.

**Reject handling** moves from the interrupt template into `runPrompt`. On resume, when re-entering a tool call's branch, `runPrompt` checks `ctx.getInterruptResponse(branch.interruptId)`:
- If reject: skip re-execution, push "tool call rejected" as a tool message to the LLM.
- If approve: re-execute the tool function (branch stack resumes at the interrupt point).

### MessageThread serialization

`runPrompt` stores `messages` (a `MessageThread`) in `stack.locals`. `State.toJSON()` uses `deepClone` which strips class identity — a `MessageThread` becomes a plain object. To handle this, store messages as JSON and reconstruct on access:

```typescript
// Store as JSON
self.messagesJSON = self.messagesJSON ?? messages.toJSON().messages;

// Reconstruct when needed
const messages = MessageThread.fromJSON(self.messagesJSON);
```

This follows the same pattern as `ThreadStore` in `setupNode` (node.ts lines 33-43).

### Loop resumption strategy

`runPrompt`'s outer loop is `while (toolCalls.length > 0)`. The pending tool calls must also be stored on the frame so the loop can resume correctly:

```typescript
self.toolCalls = self.toolCalls ?? [];  // pending tool calls for current round
```

On resume from checkpoint:
- `self.toolCalls` is populated from the previous run
- `runPrompt` skips the initial LLM call and re-enters the tool call loop
- Completed tool call branches (those with `branch.result`) are skipped
- Interrupted branches resume from their branch stack

This is analogous to how the current code uses `interruptData.toolCall` to skip the initial LLM call, but stored on the frame instead of passed from outside.

After all tool calls in a round complete, branch state is cleaned up and the next LLM call proceeds normally.

### Error path cleanup

`stateStack.pop()` goes in a `finally` block. On interrupt (frame returned to caller), the frame stays on the stack. On normal return or error, the frame is popped:

```typescript
try {
  // ... prompt loop ...
  stateStack.pop();
  return result;
} catch (e) {
  stateStack.pop();
  throw e;
}
// If returning interrupts, do NOT pop — frame must survive for checkpoint
```

This matches the fork thread pattern in `forkBlockSetup.mustache`.

### enterToolCall / exitToolCall

`ctx.enterToolCall()` / `ctx.exitToolCall()` is preserved around tool function execution. It suppresses debug hooks during tool execution — a separate concern from `isForked` (which controls state isolation and interrupt propagation). Both are set simultaneously for tool calls.

## Changes to other code

### respondToInterrupts (interrupts.ts)

- Remove the entire `interruptData` construction block (the `if (interrupts.length === 1)` section).
- Remove `interruptData` from the `graph.run()` call entirely — no interrupt-related data is passed.
- The response map via `ctx.setInterruptResponses()` is the only resume mechanism.

### Generated code (builder + templates)

- Stop passing `interruptData: __state?.interruptData` to `runPrompt`.
- Pass `stateStack: __stateStack` instead (already available at every call site).
- `checkpointInfo` stays — `runPrompt` needs it for checkpoint metadata.

### Interrupt templates (interruptReturn.mustache AND interruptAssignment.mustache)

Both templates get identical treatment:
- Remove `?? __state?.interruptData?.interruptResponse` fallback — response comes only from `ctx.getInterruptResponse()`.
- Remove `if (__state?.interruptData) __state.interruptData.interruptResponse = null` cleanup.
- The `!__state.isToolCall` guard on reject handling in `interruptReturn` goes away. (Note: `interruptAssignment` already lacks this guard — a pre-existing inconsistency that this change cleans up.)
- When `__isForked` is true, both templates just propagate the interrupt without creating checkpoints or handling reject. `runPrompt` handles reject for tool calls. The `__isForked` variable is already available in generated code — no new template variables needed.

### isToolCall removal from types

Remove `isToolCall` from `InternalFunctionState` in `types.ts`. Tool functions receive `isForked: true` instead, which is already part of the function state mechanism (passed via `__isForked` in generated code).

### prompt.ts

- `runPrompt` signature: drop `interruptData`, add `stateStack`.
- `executeToolCalls` becomes internal to `runPrompt`'s loop or stays as a helper, but no longer needs `interruptData`.
- Remove `interruptData.interruptResponse.type === "reject"` check from `executeToolCalls` — `runPrompt` handles this via `ctx.getInterruptResponse()`.
- `runPrompt` always creates the checkpoint itself (no separate checkpoint creation for non-debug single interrupts).

### isToolCall removal

- Remove from `executeToolCalls` state construction.
- Remove from interrupt template conditions.
- Tool functions receive `isForked: true` instead.

### graph.run() call in respondToInterrupts

- Remove `interruptData` parameter from the call. No interrupt-related data passes through `graph.run()`.

### InterruptData type

- Remove `interruptResponse` field from `InterruptData` type — responses go through `ctx.getInterruptResponse()` exclusively.
- `InterruptData` retains `messages` and `toolCall` fields, but these are stored on the interrupt object (set by `runPrompt` when a tool call interrupts) and captured in the checkpoint. They are not passed through `graph.run()`.

## Future: Parallel tool calls

This design directly enables parallel tool calls. The only change needed is running tool calls concurrently instead of sequentially:

```typescript
// Sequential (current):
for (const toolCall of toolCalls) { ... }

// Parallel (future):
await Promise.allSettled(toolCalls.map(async (toolCall) => { ... }));
```

Each tool call already has its own branch for state isolation. The checkpoint already captures all branches. `respondToInterrupts` already handles multiple responses. The fork pattern is fully in place — just change the execution from sequential to concurrent.
