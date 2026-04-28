# runPrompt State Stack Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `runPrompt` participate in the state stack so it can checkpoint/resume without `interruptData` passthrough, and lay groundwork for parallel tool calls.

**Architecture:** `runPrompt` calls `setupFunction` to get a frame, stores all locals on it, creates branches for each tool call (same pattern as `Runner.fork()`), and creates checkpoints when tool calls interrupt. The `interruptData` passthrough from `respondToInterrupts` → `graph.run()` is removed entirely. Interrupt templates lose the `interruptData` fallback and `isToolCall` guard.

**Tech Stack:** TypeScript, Agency runtime (StateStack, setupFunction, BranchState, checkpoints)

**Spec:** `docs/superpowers/specs/2026-04-28-runprompt-state-stack-design.md`

---

### Task 1: Remove interruptData from interrupt templates

Remove the legacy `interruptData` fallback from both interrupt templates. This is a clean, independent change — the templates already use `ctx.getInterruptResponse()` as the primary path.

**Files:**
- Modify: `lib/templates/backends/typescriptGenerator/interruptReturn.mustache`
- Modify: `lib/templates/backends/typescriptGenerator/interruptAssignment.mustache`

- [ ] **Step 1: Update interruptReturn.mustache**

Replace line 1-4:
```mustache
// Resume path: check for a response by interruptId, fall back to interruptData for legacy path
const __response = __ctx.getInterruptResponse(__self.{{{interruptIdKey:string}}}) ?? __state?.interruptData?.interruptResponse;
if (__response) {
  if (__state?.interruptData) __state.interruptData.interruptResponse = null;
```

With:
```mustache
// Resume path: check for a response by interruptId
const __response = __ctx.getInterruptResponse(__self.{{{interruptIdKey:string}}});
if (__response) {
```

Also replace line 7:
```mustache
  } else if (__response.type === "reject" && !__state.isToolCall) {
```
With:
```mustache
  } else if (__response.type === "reject" && !__isForked) {
```

- [ ] **Step 2: Update interruptAssignment.mustache**

Replace line 1-4 (same pattern):
```mustache
// Resume path: check for a response by interruptId, fall back to interruptData for legacy path
const __response = __ctx.getInterruptResponse(__self.{{{interruptIdKey:string}}}) ?? __state?.interruptData?.interruptResponse;
if (__response) {
  if (__state?.interruptData) __state.interruptData.interruptResponse = null;
```

With:
```mustache
// Resume path: check for a response by interruptId
const __response = __ctx.getInterruptResponse(__self.{{{interruptIdKey:string}}});
if (__response) {
```

Note: `interruptAssignment` already lacks the `!__state.isToolCall` guard on reject, so no change needed there.

- [ ] **Step 3: Compile templates**

Run: `pnpm run templates`

- [ ] **Step 4: Build and regenerate fixtures**

Run: `make fixtures`

- [ ] **Step 5: Run tests**

Run: `pnpm test:run`
Expected: All 2105 tests pass, 58 skipped (same as before)

- [ ] **Step 6: Commit**

```bash
git add lib/templates/backends/typescriptGenerator/interruptReturn.mustache \
       lib/templates/backends/typescriptGenerator/interruptAssignment.mustache \
       lib/templates/backends/typescriptGenerator/interruptReturn.ts \
       lib/templates/backends/typescriptGenerator/interruptAssignment.ts \
       tests/typescriptGenerator/ tests/typescriptBuilder/
git commit -m "remove interruptData fallback and isToolCall guard from interrupt templates"
```

---

### Task 2: Remove interruptData from generated code and types

Stop passing `interruptData` through function calls and `runPrompt` calls. Remove `isToolCall` from types.

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:1131-1134` — remove `interruptData` from `buildStateConfig`
- Modify: `lib/backends/typescriptBuilder.ts:2672` — remove `interruptData` from `processLlmCall`, add `stateStack`
- Modify: `lib/ir/builders.ts` — remove `interruptData` parameter from `functionCallConfig`
- Modify: `lib/runtime/types.ts:23,29-30` — remove `interruptData` and `isToolCall` from `GraphState` and `InternalFunctionState`, add `isForked`

- [ ] **Step 1: Remove interruptData from buildStateConfig**

In `lib/backends/typescriptBuilder.ts`, in `buildStateConfig` (around line 1131), remove the `interruptData` entry:

```typescript
// Before:
return ts.functionCallConfig({
  ctx: ts.runtime.ctx,
  threads: ts.runtime.threads,
  interruptData: ts.raw("__state?.interruptData"),
  stateStack: opts?.stateStack ?? ts.id("__stateStack"),
  isForked: opts?.isForked ?? ts.id("__isForked"),
  ...opts?.extra,
});

// After:
return ts.functionCallConfig({
  ctx: ts.runtime.ctx,
  threads: ts.runtime.threads,
  stateStack: opts?.stateStack ?? ts.id("__stateStack"),
  isForked: opts?.isForked ?? ts.id("__isForked"),
  ...opts?.extra,
});
```

- [ ] **Step 2: Update processLlmCall — replace interruptData with stateStack**

In `lib/backends/typescriptBuilder.ts`, in `processLlmCall` (around line 2672), replace:

```typescript
runPromptEntries.interruptData = ts.raw("__state?.interruptData");
```

With:

```typescript
runPromptEntries.stateStack = ts.id("__stateStack");
```

- [ ] **Step 3: Update types.ts — remove interruptData and isToolCall**

In `lib/runtime/types.ts`:

Remove `interruptData` from `GraphState` (line 23):
```typescript
// Remove this line:
interruptData?: InterruptData;
```

Remove `interruptData` and `isToolCall` from `InternalFunctionState`, add `isForked` (lines 29-31):
```typescript
// Remove these lines:
interruptData?: InterruptData;
isToolCall?: boolean;

// Add:
isForked?: boolean;
```

Remove the `InterruptData` import if it becomes unused.

- [ ] **Step 3b: Remove interruptData from functionCallConfig in builders.ts**

In `lib/ir/builders.ts`, find the `functionCallConfig` function and remove the `interruptData` parameter and its conditional inclusion in the output object. This is dead code now that `buildStateConfig` no longer passes it.

- [ ] **Step 4: Build and fix any type errors**

Run: `pnpm run build`

Fix any remaining references to `interruptData` or `isToolCall` in the codebase that fail type checking. The main ones will be:
- `lib/runtime/node.ts` — `setupNode` and `runNode` may reference `state.interruptData`
- `lib/runtime/interrupts.ts` — `respondToInterrupts` passes `interruptData` to `graph.run()`

For `respondToInterrupts`, remove the entire `interruptData` construction block and the `interruptData` field from the `graph.run()` call:

```typescript
// Remove lines 220-231 (the interruptData construction)
// Change the graph.run call to not include interruptData:
const result = await execCtx.graph.run(
  nodeName,
  {
    data: {},
    ctx: execCtx,
    isResume: true,
  },
  { onNodeEnter: (id) => execCtx.stateStack.nodesTraversed.push(id) },
);
```

- [ ] **Step 5: Regenerate fixtures and run tests**

Run: `make fixtures && pnpm test:run`

Some agency tests will fail (the interrupt tests that currently crash with "Interrupt data is present but no tool call found"). That's expected — we haven't yet updated `runPrompt` to use the state stack. The vitest unit/integration tests should pass.

- [ ] **Step 6: Commit**

```bash
git add lib/backends/typescriptBuilder.ts lib/runtime/types.ts \
       lib/runtime/interrupts.ts lib/runtime/node.ts \
       tests/typescriptGenerator/ tests/typescriptBuilder/
git commit -m "remove interruptData from generated code, types, and respondToInterrupts"
```

---

### Task 3: Make runPrompt use setupFunction and store locals on frame

The core change — `runPrompt` pushes its own frame, stores all locals on it, and restores them on resume.

**Files:**
- Modify: `lib/runtime/prompt.ts`

- [ ] **Step 1: Add stateStack parameter, call setupFunction**

Update `runPrompt` signature: add `stateStack` parameter, remove `interruptData`:

```typescript
export async function runPrompt(args: {
  ctx: RuntimeContext<GraphState>;
  prompt: string;
  messages: MessageThread;
  responseFormat?: any;
  clientConfig: Partial<smoltalk.SmolPromptConfig> & { tools?: any[] };
  maxToolCallRounds?: number;
  stateStack?: StateStack;
  removedTools?: string[];
  checkpointInfo?: SourceLocationOpts;
}): Promise<any> {
```

Add imports at the top of `prompt.ts`:

```typescript
import { setupFunction } from "./node.js";
import { StateStack } from "./state/stateStack.js";
```

At the start of `runPrompt`, call `setupFunction`:

```typescript
const { stateStack, stack } = setupFunction({
  state: args.stateStack
    ? { stateStack: args.stateStack, ctx: args.ctx, threads: new ThreadStore() }
    : undefined,
});
const self = stack.locals;
```

Note: `threads` is required by `setupFunction` when `state` is provided (it falls back to `new ThreadStore()` if missing). Passing it explicitly avoids a type cast.

- [ ] **Step 2: Move locals onto the frame**

Replace the local variable declarations with frame-backed storage. The pattern: on first run, initialize from args. On resume, the frame already has the values.

```typescript
const {
  ctx,
  prompt,
  responseFormat,
  maxToolCallRounds = 10,
  checkpointInfo,
} = args;

// Frame-backed locals (survive checkpoint/restore)
if (self.__initialized === undefined) {
  // First run — initialize from args
  self.__initialized = true;
  self.removedTools = args.removedTools || [];
  self.toolErrorCounts = {};
  self.toolCallRound = 0;
  self.messagesJSON = null; // will be set after first LLM call
  self.pendingToolCalls = null; // serialized tool calls for current round
}

const removedTools: string[] = self.removedTools;
const toolErrorCounts: Record<string, number> = self.toolErrorCounts;
```

- [ ] **Step 3: Rewrite the message initialization and LLM call logic**

Replace the `interruptData`-based message restoration with frame-based:

```typescript
// Restore or initialize messages
let messages: MessageThread;
if (self.messagesJSON) {
  // Resuming from checkpoint — restore from frame
  messages = MessageThread.fromJSON(self.messagesJSON);
} else if (clientConfig.messages) {
  messages = MessageThread.fromJSON(clientConfig.messages);
} else if (args.messages) {
  messages = args.messages;
} else {
  messages = new MessageThread();
}

// Tool calls: restore from frame or make initial LLM call
let toolCalls: smoltalk.ToolCallJSON[];
if (self.pendingToolCalls) {
  // Resuming — restore pending tool calls
  toolCalls = self.pendingToolCalls;
} else {
  // First run — send prompt to LLM
  messages.push(smoltalk.userMessage(prompt));
  const result = await _runPrompt({
    ctx,
    messages,
    tools: tools || [],
    prompt,
    responseFormat,
    clientConfig,
  });
  messages = result.messages;
  toolCalls = result.toolCalls;
  // Save to frame
  self.messagesJSON = messages.toJSON().messages;
  self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
}
```

- [ ] **Step 4: Rewrite the tool call loop with branches**

Replace `executeToolCalls` usage with direct branch-based tool call execution:

```typescript
while (toolCalls.length > 0) {
  if (ctx.aborted) throw new AgencyCancelledError();
  if (self.toolCallRound++ >= maxToolCallRounds) {
    throw new Error(`Exceeded maximum tool call rounds (${maxToolCallRounds})`);
  }

  if (!stack.branches) stack.branches = {};
  const interrupts: Interrupt[] = [];

  for (const toolCall of toolCalls) {
    if (ctx.aborted) throw new AgencyCancelledError();

    const handler = toolFunctions.find((fn) => fn.name === toolCall.name);
    if (!handler) {
      messages.push(smoltalk.toolMessage(
        `Error: No handler found for tool call ${toolCall.name}`,
        { tool_call_id: toolCall.id, name: toolCall.name },
      ));
      continue;
    }

    if (removedTools.includes(handler.name)) {
      messages.push(smoltalk.toolMessage(
        `Error: Handler for tool call ${handler.name} has been removed.`,
        { tool_call_id: toolCall.id, name: toolCall.name },
      ));
      continue;
    }

    const branchKey = `tool_${toolCall.id}`;
    const existing = stack.branches[branchKey];

    // Skip completed branches (cached result from previous interrupt cycle)
    if (existing?.result !== undefined) {
      messages.push(smoltalk.toolMessage(existing.result.result, {
        tool_call_id: toolCall.id,
        name: toolCall.name,
      }));
      continue;
    }

    // Check if this branch was interrupted and user rejected
    if (existing?.interruptId) {
      const response = ctx.getInterruptResponse(existing.interruptId);
      if (response?.type === "reject") {
        messages.push(smoltalk.toolMessage("tool call rejected", {
          tool_call_id: toolCall.id,
          name: toolCall.name,
        }));
        delete stack.branches[branchKey];
        continue;
      }
    }

    // Create or restore branch stack
    const branchStack = existing ? existing.stack : new StateStack();
    if (existing) branchStack.deserializeMode();
    else stack.branches[branchKey] = { stack: branchStack };

    const namedArgs = { ...toolCall.arguments };
    await callHook({
      callbacks: ctx.callbacks,
      name: "onToolCallStart",
      data: { toolName: handler.name, args: namedArgs },
    });

    const toolCallStartTime = performance.now();
    let result: any;
    ctx.enterToolCall();
    try {
      result = await handler.invoke(
        { type: "named", positionalArgs: [], namedArgs },
        { ctx, threads: new ThreadStore(), stateStack: branchStack, isForked: true },
      );
    } catch (error: unknown) {
      // Error handling (same as current executeToolCalls)
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Tool call "${handler.name}" crashed: ${errorMessage}`);
      toolErrorCounts[handler.name] = (toolErrorCounts[handler.name] || 0) + 1;
      messages.push(smoltalk.toolMessage(
        `Error: ${errorMessage}. This tool failed and cannot be retried.`,
        { tool_call_id: toolCall.id, name: toolCall.name },
      ));
      removedTools.push(handler.name);
      delete stack.branches[branchKey];
      continue;
    } finally {
      ctx.exitToolCall();
    }

    // Handle failure results
    if (isFailure(result)) {
      const errorMessage = typeof result.error === "string" ? result.error : String(result.error);
      toolErrorCounts[handler.name] = (toolErrorCounts[handler.name] || 0) + 1;
      if (result.retryable && toolErrorCounts[handler.name] < 5) {
        messages.push(smoltalk.toolMessage(
          `Error: ${errorMessage}. You may retry.`,
          { tool_call_id: toolCall.id, name: toolCall.name },
        ));
      } else {
        messages.push(smoltalk.toolMessage(
          `Error: ${errorMessage}. This tool can no longer be called.`,
          { tool_call_id: toolCall.id, name: toolCall.name },
        ));
        removedTools.push(handler.name);
      }
      delete stack.branches[branchKey];
      continue;
    }

    if (isRejected(result)) {
      const message = typeof result.value === "string" ? result.value : "Tool call rejected by policy";
      messages.push(smoltalk.toolMessage(message, {
        tool_call_id: toolCall.id,
        name: toolCall.name,
      }));
      delete stack.branches[branchKey];
      continue;
    }

    // Check for interrupts
    if (hasInterrupts(result)) {
      interrupts.push(...result);
      stack.branches[branchKey].interruptId = result[0]?.interruptId;
      continue;
    }

    // Success — cache result and add tool message
    result = result || `${handler.name} ran successfully but did not return a value`;
    stack.branches[branchKey].result = { result };

    const toolCallEndTime = performance.now();
    await callHook({
      callbacks: ctx.callbacks,
      name: "onToolCallEnd",
      data: { toolName: handler.name, result, timeTaken: toolCallEndTime - toolCallStartTime },
    });
    ctx.statelogClient.toolCall({
      toolName: handler.name,
      args: namedArgs,
      output: result,
      model: JSON.stringify(clientConfig.model),
      timeTaken: toolCallEndTime - toolCallStartTime,
    });

    messages.push(smoltalk.toolMessage(result, {
      tool_call_id: toolCall.id,
      name: toolCall.name,
    }));
    delete stack.branches[branchKey];
  }

  // If any tool calls interrupted, create checkpoint and return
  if (interrupts.length > 0) {
    // Save messages to frame before checkpoint
    self.messagesJSON = messages.toJSON().messages;
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
    return interrupts;
  }

  // All tool calls complete — clean up branches, update frame, next LLM round
  stack.branches = {};
  tools = tools.filter((t) => !removedTools.includes(t.name));
  toolFunctions = toolFunctions.filter((fn) => !removedTools.includes(fn.name));

  const nextResult = await _runPrompt({
    ctx, messages, tools: tools || [], prompt, responseFormat, clientConfig,
  });
  messages = nextResult.messages;
  toolCalls = nextResult.toolCalls;

  // Save to frame
  self.messagesJSON = messages.toJSON().messages;
  self.pendingToolCalls = toolCalls.length > 0 ? toolCalls : null;
}
```

- [ ] **Step 5: Add frame cleanup on exit**

After the tool call loop (normal completion), pop the frame and return:

```typescript
// Normal completion — pop frame
stateStack.pop();

const responseMessage = messages.getMessages().at(-1);
// ... rest of response extraction (same as current code)
```

Wrap the entire function body in try/finally with a flag:

```typescript
let shouldPop = true;
try {
  // ... all the above ...

  // When returning interrupts, frame must survive for checkpoint
  // (shouldPop stays true only for normal return or error)
  if (interrupts.length > 0) {
    shouldPop = false;
    return interrupts;
  }

  // Normal completion
  return result;
} catch (error) {
  if (isAbortError(error)) throw error;
  throw error;
} finally {
  if (shouldPop) stateStack.pop();
}
```

- [ ] **Step 6: Remove executeToolCalls function and ExecuteToolCallsResult type**

Delete the `executeToolCalls` function and `ExecuteToolCallsResult` type from `prompt.ts` — all that logic is now inline in `runPrompt`.

- [ ] **Step 7: Build**

Run: `pnpm run build`
Expected: Clean build with no type errors.

- [ ] **Step 8: Commit**

```bash
git add lib/runtime/prompt.ts
git commit -m "make runPrompt participate in state stack with frame and branches"
```

---

### Task 4: Remove interruptData from InterruptData type

Clean up the `InterruptData` type now that `interruptResponse` is no longer stored on it.

**Files:**
- Modify: `lib/runtime/interrupts.ts`

- [ ] **Step 1: Remove interruptResponse from InterruptData**

In `lib/runtime/interrupts.ts`, update the `InterruptData` type:

```typescript
// Before:
export type InterruptData = {
  messages?: smoltalk.MessageJSON[];
  toolCall?: smoltalk.ToolCallJSON;
  interruptResponse?: InterruptResponse;
};

// After:
export type InterruptData = {
  messages?: smoltalk.MessageJSON[];
  toolCall?: smoltalk.ToolCallJSON;
};
```

- [ ] **Step 2: Clean up respondToInterrupts**

Remove `interruptData` from the response map construction in `respondToInterrupts`:

```typescript
// Before:
const responseMap: Record<string, { response: InterruptResponse; interruptData?: InterruptData }> = {};
for (let i = 0; i < interrupts.length; i++) {
  responseMap[interrupts[i].interruptId] = {
    response: deepClone(responses[i]),
    interruptData: interrupts[i].interruptData ? deepClone(interrupts[i].interruptData) : undefined,
  };
}

// After:
const responseMap: Record<string, { response: InterruptResponse }> = {};
for (let i = 0; i < interrupts.length; i++) {
  responseMap[interrupts[i].interruptId] = {
    response: deepClone(responses[i]),
  };
}
```

Also update `RuntimeContext` in `lib/runtime/state/context.ts`:
- Remove `getInterruptData()` method — it's no longer needed (no callers).
- Update `_interruptResponses` type from `Record<string, { response: InterruptResponse; interruptData?: InterruptData }>` to `Record<string, { response: InterruptResponse }>`.
- Update `setInterruptResponses()` parameter type to match.

- [ ] **Step 3: Build and test**

Run: `pnpm run build && pnpm test:run`

- [ ] **Step 4: Commit**

```bash
git add lib/runtime/interrupts.ts lib/runtime/state/context.ts
git commit -m "remove interruptResponse from InterruptData type, clean up response map"
```

---

### Task 5: Regenerate fixtures and run full test suite

**Files:**
- Modify: `tests/typescriptGenerator/*.mjs` (auto-regenerated)
- Modify: `tests/typescriptBuilder/*.mjs` (auto-regenerated)

- [ ] **Step 1: Compile templates and rebuild**

Run: `pnpm run templates && pnpm run build`

- [ ] **Step 2: Regenerate fixtures**

Run: `make fixtures`

- [ ] **Step 3: Run full test suite**

Run: `pnpm test:run`
Expected: All vitest tests pass.

- [ ] **Step 4: Run agency tests that were previously failing**

Run:
```bash
node dist/scripts/agency.js test tests/agency/interrupts/interrupt.agency
node dist/scripts/agency.js test tests/agency/interrupts/interruptAssignment.agency
node dist/scripts/agency.js test tests/agency/result/pipe-interrupt.agency
```

These should now pass since `runPrompt` no longer relies on `interruptData` passthrough.

- [ ] **Step 5: Run fork agency tests**

Run:
```bash
node dist/scripts/agency.js test tests/agency/fork/fork-multi-interrupt.agency
node dist/scripts/agency.js test tests/agency/fork/fork-partial-interrupt.agency
node dist/scripts/agency.js test tests/agency/fork/fork-handler-resolve.agency
```

These should still pass — fork creates its own checkpoint which overwrites `runPrompt`'s.

- [ ] **Step 6: Commit**

```bash
git add tests/typescriptGenerator/ tests/typescriptBuilder/
git commit -m "regenerate fixtures for runPrompt state stack changes"
```

---

### Task 6: Remove isToolCall from prompt.ts executeToolCalls state

Since `executeToolCalls` is removed in Task 3, verify there are no remaining references to `isToolCall` anywhere in the runtime.

**Files:**
- Search: entire `lib/` directory

- [ ] **Step 1: Search for remaining isToolCall references**

Run: `grep -rn "isToolCall" lib/`

Any remaining references should be removed. Expected locations:
- `lib/runtime/prompt.ts` — already removed in Task 3
- `lib/runtime/types.ts` — already removed in Task 2
- Generated template code (`.ts` files in `lib/templates/`) — should be gone after template recompile

- [ ] **Step 2: If any remain, remove them**

- [ ] **Step 3: Build and test**

Run: `pnpm run build && pnpm test:run`

- [ ] **Step 4: Commit if changes were needed**

```bash
git commit -m "remove remaining isToolCall references"
```
