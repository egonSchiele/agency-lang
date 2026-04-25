# Threads, Sub-threads, and Thread Stores — Codebase Review

## Overview

Agency uses a **ThreadStore** + **MessageThread** system to manage LLM conversation history across prompts, functions, and parallel execution. Threads are the mechanism by which messages accumulate and flow through an agent's execution.

---

## How are threads implemented?

### Core classes

**`MessageThread`** (`lib/runtime/state/messageThread.ts`):
- Wraps a `smoltalk.Message[]` array (OpenAI-compatible message format)
- Each instance has a unique `id` (nanoid)
- Key methods: `addMessage()`, `push()`, `getMessages()`, `cloneMessages()` (deep clone via JSON round-trip)

**`ThreadStore`** (`lib/runtime/state/threadStore.ts`):
- Registry of `MessageThread` objects keyed by auto-incremented string IDs
- Maintains an **active stack** (`activeStack: string[]`) for nested thread scoping
- Key methods:
  - `create()` — new empty thread, returns ID
  - `createSubthread()` — new thread inheriting active thread's messages
  - `pushActive(id)` / `popActive()` — manage the active stack
  - `getOrCreateActive()` — lazy creation of the active thread
  - `toJSON()` / `fromJSON()` — serialization for interrupt/resume

### AST representation

**`MessageThread`** AST node (`lib/types/messageThread.ts`):
```typescript
type ThreadType = "thread" | "subthread" | "parallel";
type MessageThread = { type: "messageThread"; threadType: ThreadType; body: AgencyNode[] };
```

### Generated code for `thread { ... }`

Template: `lib/templates/backends/typescriptGenerator/messageThread.mustache`

```typescript
{
  const __tid = __threads.create();       // new empty thread
  __threads.pushActive(__tid);
  // ... body code (prompts accumulate messages on this thread) ...
  __threads.popActive();
}
```

A `thread` block creates a **fresh, isolated** message history. LLM calls inside it start with no prior context.

---

## How are sub-threads implemented?

Generated code for `subthread { ... }`:

```typescript
{
  const __tid = __threads.createSubthread();  // inherits parent messages
  __threads.pushActive(__tid);
  // ... body code ...
  __threads.popActive();
}
```

`createSubthread()` calls `this.threads[parentId].newSubthreadChild()`, which deep-clones the parent's messages into a new `MessageThread`. The subthread starts with the full conversation history of its parent, so LLM calls inside can reference prior context.

Key distinction: **thread = blank slate; subthread = fork of parent's conversation**.

---

## How are threads passed into prompts?

In `typescriptGenerator.ts` lines 741-748, when generating a prompt function call, the generator determines the thread expression:

```typescript
// typescriptGenerator.ts:741-748
if (this.parallelThreadVars[variableName]) {
  threadExpr = `__threads.get(${this.parallelThreadVars[variableName]})`;  // parallel: dedicated thread
} else if (prompt.async) {
  threadExpr = `new MessageThread()`;                                       // async: fresh isolated thread
} else {
  threadExpr = `__threads.getOrCreateActive()`;                             // normal: active thread
}
```

This thread expression is passed as `__metadata`:
```typescript
{ messages: ${threadExpr} }
```

Inside the generated prompt function (`promptFunction.mustache`), it reaches `runPrompt()`:
```typescript
messages: __metadata?.messages || new MessageThread()
```

The runtime (`lib/runtime/prompt.ts`) uses `messages.getMessages()` to build the LLM API call, and appends assistant/tool responses back to the same `MessageThread`.

---

## How are threads passed into functions?

When a function is called internally, the template `internalFunctionCall.mustache` passes the entire ThreadStore:

```typescript
functionName(args, {
  ctx: __ctx,
  threads: __threads,          // <-- whole ThreadStore passed through
  interruptData: __state?.interruptData
})
```

In `setupFunction()` (`lib/runtime/node.ts:42-71`):
- If `state.threads` exists (called from a node/function): uses the passed ThreadStore
- If `state` is undefined (called as an LLM tool): creates a new empty ThreadStore
- Fallback: `state.threads || new ThreadStore()`

This means **functions share the same ThreadStore as their caller**, so they participate in the same thread scoping. The active stack is shared.

---

## What happens if a function is called inside of a thread?

The function receives `__threads` (the caller's ThreadStore) via the internal function call template. Since the thread block already pushed a thread onto the active stack, the function's prompts will use `__threads.getOrCreateActive()` which returns that thread. So:

- The function's LLM calls accumulate messages on the **caller's active thread**
- The function can also create nested threads/subthreads (they push/pop on the same active stack)
- When the function returns, the active stack is unchanged (the caller's thread is still active)

**Exception — when called as a tool by the LLM** (`lib/runtime/prompt.ts:229-233`):
```typescript
params.push({
  ctx,
  threads: new ThreadStore(),   // <-- isolated ThreadStore
  interruptData,
  isToolCall: true,
});
```
Tool calls get a **fresh, isolated** ThreadStore. Their messages don't bleed into the parent prompt's thread.

---

## What happens if a variable is assigned to a thread?

For `msgs = thread { ... }` or `msgs = subthread { ... }`:

The template generates (after body, before popActive):
```typescript
msgs = __threads.active().cloneMessages();
```

The variable receives a **deep clone** of the thread's accumulated messages (`smoltalk.Message[]` array). The thread itself is popped from the active stack and remains in the ThreadStore but is no longer active.

---

## How do we handle synchronous versus asynchronous calls differently?

### Synchronous (default) prompts
- Thread expression: `__threads.getOrCreateActive()` — uses the current active thread
- Generated as `await _varName(...)` — blocks until complete
- Messages accumulate sequentially on the active thread
- After the call, checks for interrupts and returns early if needed

### Async prompts (`prompt.async = true`)
- Thread expression: `new MessageThread()` — **brand new isolated thread**, not connected to the ThreadStore
- Generated as `_varName(...)` (no `await`) — returns a Promise immediately
- No interrupt check (can't interrupt mid-flight)
- The promise is stored and must be awaited later

### Key files
| File | Role |
|------|------|
| `lib/runtime/state/messageThread.ts` | MessageThread class (message wrapper) |
| `lib/runtime/state/threadStore.ts` | ThreadStore class (thread registry + active stack) |
| `lib/runtime/node.ts` | setupNode/setupFunction (ThreadStore initialization) |
| `lib/runtime/prompt.ts` | runPrompt (uses thread for LLM calls), tool call isolation |
| `lib/backends/typescriptBuilder.ts` | processMessageThread |
| `lib/templates/backends/typescriptGenerator/promptFunction.mustache` | Prompt function template |
| `lib/templates/backends/typescriptGenerator/internalFunctionCall.mustache` | Function call with threads |
| `lib/templates/backends/typescriptGenerator/graphNode.mustache` | Node setup (threads init) |
| `lib/templates/backends/typescriptGenerator/functionDefinition.mustache` | Function setup (threads init) |
| `tests/typescriptGenerator/threadsAndSubthreads.agency` | Thread/subthread fixture |
| `tests/typescriptGenerator/parallelThread.agency` | Parallel thread fixture |
| `tests/agency/threads/` | End-to-end thread tests |
