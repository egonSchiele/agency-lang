# Default Shared Message Thread

## Problem

Currently, every top-level LLM call in Agency is isolated by default — each call gets its own fresh message history. To share history, users must explicitly wrap calls in `thread { }` blocks. This makes building conversational agents harder than it should be, since most agent use cases want LLM calls to share context.

## Design

Flip the default: all LLM calls share a common message history by default, as if the entire graph execution were wrapped in a `thread { }` block. The `thread { }` and `subthread { }` blocks become tools for opting *out* of shared history.

### New mental model

- **Default:** All LLM calls across all nodes share a single message thread. History persists across node transitions.
- **`thread { }`:** Creates an isolated scope with a fresh message history. Useful for sub-agents or side tasks that shouldn't see or pollute the main conversation.
- **`subthread { }`:** Forks from the current history at that point, then diverges independently. Useful for sub-agents that need prior context but shouldn't add back to the parent.

### What stays the same

- `thread { }` and `subthread { }` block semantics are unchanged.
- Tool-invoked functions (functions called by the LLM as tools) remain isolated — they get a fresh `ThreadStore`.
- Functions called internally share the caller's `ThreadStore`, same as today when inside a thread block.

## Changes

### 1. Runtime: Persist ThreadStore across node transitions

**File: `lib/runtime/node.ts` — `runNode()`**

Currently (line 114):
```ts
const threadStore = new ThreadStore();
const result = await execCtx.graph.run(nodeName, {
  messages: threadStore,
  data,
  ctx: execCtx,
  isResume,
}, ...);
```

Change: Create a `ThreadStore` with a pre-pushed active thread. This ThreadStore persists across all node transitions during graph execution.

**File: `lib/runtime/node.ts` — `setupNode()`**

Currently (lines 35-38):
```ts
const threads = stack.threads
  ? ThreadStore.fromJSON(stack.threads)
  : new ThreadStore();
```

Change: When not resuming from an interrupt, use the `ThreadStore` from `state.messages` (the one passed through graph transitions) instead of creating a new one. The fallback (for the very first node) creates a new ThreadStore with a pre-pushed active thread via `getOrCreateActive()`.

**File: `lib/simplemachine/graph.ts`**

The graph execution loop currently only carries `data` between nodes. The `messages` field returned by each node (`{ messages: __threads, data: ... }`) must also be carried forward to the next node.

### 2. Builder: Always use shared thread path

**File: `lib/backends/typescriptBuilder.ts`**

Three locations use the `insideMessageThread` flag to decide between shared vs isolated behavior. All three should always use the shared path:

**Prompt thread expression (line 2025-2032):**
```ts
// Before:
if (this.insideMessageThread || isInFunction) {
  threadExpr = ts.threads.getOrCreateActive();
} else {
  threadExpr = ts.threads.createAndReturnThread();
}

// After:
threadExpr = ts.threads.getOrCreateActive();
```

**Function call threads (line 1503-1505):**
```ts
// Before:
const threadsExpr = this.insideMessageThread
  ? ts.runtime.threads
  : ts.newThreadStore();

// After:
const threadsExpr = ts.runtime.threads;
```

**Pipe state args (line 2459-2461):**
```ts
// Before:
const threadsExpr = this.insideMessageThread
  ? ts.runtime.threads
  : ts.newThreadStore();

// After:
const threadsExpr = ts.runtime.threads;
```

The `insideMessageThread` flag is still needed for `processMessageThread` body processing, but no longer drives thread expression decisions.

### 3. Async prompts (nice-to-have)

Currently async prompts get `new MessageThread()` (completely isolated). Ideally they should fork the current history via a new `createAndReturnSubthread()` method on `ThreadStore`, so they have context but don't write back to the shared thread.

If this adds significant complexity, skip and document the needed change in `docs/dev/async.md` instead.

**If implemented — File: `lib/runtime/state/threadStore.ts`:**
```ts
createAndReturnSubthread(): MessageThread {
  const id = this.createSubthread();
  return this.get(id);
}
```

### 4. Serialization for interrupts

The existing serialization path in `setupNode()` already handles this correctly — `ThreadStore.fromJSON` restores threads and the active stack. The only change needed is that the `new ThreadStore()` fallback (when not resuming) should also pre-push an active thread.

## Test impact

- **Generator/builder fixtures** (`tests/typescriptGenerator/`, `tests/typescriptBuilder/`): Many fixtures reference `createAndReturnThread()` in generated code. Regenerate with `make fixtures`.
- **Thread tests** (`tests/agency/threads/`): Should still pass — `thread { }` and `subthread { }` still create nested threads on the active stack.
- **Existing agency tests** (`tests/agency/`): Tests with multiple LLM calls in a node will now share history. Review for any that depend on isolation.
