# Threads, Sub-threads, and Thread Stores — Codebase Review

## Overview

Agency uses a **ThreadStore** + **MessageThread** system to manage LLM conversation history across prompts, functions, and parallel execution. Threads are the mechanism by which messages accumulate and flow through an agent's execution.

---

## How are threads implemented?

### Core classes

**`MessageThread`** (`lib/runtime/state/messageThread.ts`):
- Wraps a `smoltalk.Message[]` array (OpenAI-compatible message format)
- Each instance has a unique `id` (nanoid)
- Key methods: `addMessage()`, `push()`, `getMessages()`, `cloneMessages()` (deep clone via JSON round-trip), `labelAt()`
- Also carries the metadata a thread accumulates: `parentId`, `label`, `hidden`, `summary`, `repairs`, and `queuedMessages`. All of them round-trip through `toJSON` / `fromJSON`.

#### Per-message debug labels (`messageLabels`)

`messageLabels` holds an optional debug label per message, from `llm(label:)` / `userMessage(msg, label:)` and friends. It is observability-only: labels surface in statelog (see `docs/dev/hosting/statelog.md`) and are never sent to the provider. It is **not** the same field as the thread-level `label`, which comes from `thread(label: "...")` and names the whole thread.

Smoltalk messages have no id, so a label cannot be keyed to the message it describes. `messageLabels` is instead aligned with `messages` **by index** — `messageLabels[i]` labels `messages[i]`, and the lengths always match. An index-aligned array is also what lets labels serialize with the thread (a `WeakMap` keyed by message identity would survive slicing but not `toJSON`).

The tradeoff is that nothing in the type system enforces the alignment. It is enforced instead by keeping the writers few, and by giving every caller an operation that carries the labels along — so no caller has a reason to reach past them:

- **`push(message, label?)`** — the only append. `addMessage()` delegates to it.
- **`removeAt(index)`** — the only removal. Takes the message's label out with it.
- **`adoptFrom(other)`** — take on another thread's messages *and* labels, keeping this thread's identity (the resume path needs the alias).
- **the constructor and `setMessages(messages, labels?)`** — the only replacements. Both rebuild `messageLabels` to the new length.
- **Nothing else touches `this.messages`.**

Treat any new direct mutation of `this.messages` as a bug: a desync does not degrade gracefully, it shifts every later label onto the wrong message. Each writer has a test in `messageThread.test.ts` that fails on a desync.

This matters in practice. Before `removeAt` and `adoptFrom` existed, two callers reached for `setMessages` for jobs that were not rewrites and silently dropped every label: the memory layer removing its injected-facts message (on the **normal** path, so a labeled program lost its labels after the first `llm()` call), and the resume path overwriting the thread with the messages it had just restored.

Things worth knowing:
- **`setMessages` with no `labels` drops labels.** Wholesale rewrites that cannot say what the labels are — summarization, `threadRepair` — therefore lose them. Intended. Callers that *do* know the labels pass them.
- **A `labels` array whose length disagrees with `messages` is refused**, not padded or sliced: a disagreement means the source is already wrong, and guessing would put real labels on wrong messages. Unlabeled beats mislabeled.
- **`newSubthreadChild()` does not carry the parent's labels**: it seeds the child via `cloneMessages()`, which copies messages only, so the child starts correctly aligned with all-null labels.
- **`toJSON()` hands out a copy** of `messageLabels`, so a consumer mutating the JSON cannot mutate the thread.

Serialization: `messageLabels` round-trips through `toJSON`/`fromJSON`; legacy JSON without the field revives as all-null. `ThreadStore` serializes each thread with `thread.toJSON()`, so labels ride along there for free.

Anything that snapshots a thread for checkpoint/resume must persist the **full `MessageThreadJSON`**, not just `.messages` — a bare array revives through `fromJSON`'s legacy branch, which has no labels to read, so the labels would be gone after resume. `fromJSON` still accepts the bare array, so older checkpoints keep working.

Every bailout path in `runPrompt` stores a snapshot into `self.messagesJSON`: the PromptRunner callback, the tool loop, reply-attachment injection, and the validation retries. They all go through one local `snapshotThread()` rather than each calling `toJSON()` themselves. Same reasoning as the writers above, the shape decision is made once, so a path that isn't covered by a test is still correct by construction.

**`ThreadStore`** (`lib/runtime/state/threadStore.ts`):
- Registry of `MessageThread` objects keyed by auto-incremented string IDs
- Maintains an **active stack** (`activeStack: string[]`) for nested thread scoping
- Key methods:
  - `create(meta?)` — new empty thread, returns ID
  - `createSubthread(meta?)` — new thread inheriting active thread's messages
  - `createAndReturnSubthread()` — the same fork, returning the `MessageThread` itself
  - `pushActive(id)` / `popActive()` — manage the active stack
  - `getOrCreateActive()` — lazy creation of the active thread
  - `resumeExisting(id)` / `openSession(name, meta)` — reopen a thread for `thread(continue:)` and `thread(session:)`
  - `toJSON()` / `fromJSON()` — serialization for interrupt/resume

The registry itself (`threads`, `counter`, `sessions`) is shared. `forkBranchView()` builds a store that aliases the parent's registry but gets its own `activeStack`, so a fork, parallel, or race branch writes to a branch-local active thread without hiding new threads from anyone else.

### AST representation

**`MessageThread`** AST node (`lib/types/messageThread.ts`):
```typescript
type ThreadType = "thread" | "subthread";
type MessageThread = BaseNode & {
  type: "messageThread";
  threadType: ThreadType;
  body: AgencyNode[];
  label?: Expression | null;
  summarize?: Expression | null;
  continueExpr?: Expression | null;  // thread(continue: id)
  sessionExpr?: Expression | null;   // thread(session: "name")
  hidden?: Expression | null;
};
```

### Generated code for `thread { ... }`

`processMessageThread` in `lib/backends/typescriptBuilder.ts` emits a `runnerThread` IR node, which `lib/ir/prettyPrint.ts` prints as:

```typescript
await runner.thread(<id>, "create", async () => ({ label: ... }), async (runner) => {
  // ... body code (prompts accumulate messages on this thread) ...
});
```

The options are a thunk, not a plain object. A `return` earlier in the function halts the runner and skips the steps that assign the locals those option expressions read, so evaluating them eagerly would dereference an unset local.

`Runner.thread` in `lib/runtime/runner.ts` owns the whole lifecycle: it creates or reopens the thread, pushes it on the active stack, runs the callback, and pops in a `finally`. It also fires the `onThreadStart` and `onThreadEnd` callbacks. It remembers the thread id in a frame local (`__thread_<stepPath>`), because a debug pause inside the callback re-runs the whole method and the create must not happen twice.

A `thread` block creates a **fresh, isolated** message history. LLM calls inside it start with no prior context.

---

## How are sub-threads implemented?

`subthread { ... }` emits the same call with `"createSubthread"` as the method.

`createSubthread()` calls `newSubthreadChild()` on the active thread, which deep-clones its messages into a new `MessageThread` and records the parent's id in `parentId`. The subthread starts with the full conversation history of its parent, so LLM calls inside can reference prior context.

`subthread` rejects `continue` and `session` at codegen time. A subthread is bound to its parent's context at create time, so reopening it would either have to re-derive that parent or drop the linkage.

Key distinction: **thread = blank slate; subthread = fork of parent's conversation**.

---

## Reopen repair: abandoned turns cannot poison a session

A turn that parks on an unanswered interrupt leaves its thread ending on an
assistant message with unanswered tool calls. If the turn is resumed, the
gap closes naturally. If it is abandoned — the user starts a new turn on
the same session instead of answering — the gap would make the provider
reject every later request (`tool_use` ids without `tool_result` blocks),
killing the session permanently.

So reopening a thread for new work repairs it first. The seam is the
first-execution branch of `Runner.thread()`: on a `session:` second+ entry
or a `thread(continue: id)`, `repairReopenedThread`
(`lib/runtime/threadRepair.ts`) appends a synthetic tool result per
dangling call plus a breadcrumb assistant message, and fires a
`threadRepaired` statelog event. A checkpoint resume never travels through
that branch (the frame-locals guard skips the open side effect), so repair
cannot fire while a parked turn can still be resumed.

Each repair advances the thread's generation (`MessageThread.markRepaired`).
The prompt restore path (`restoreThreadForResume`) refuses a checkpoint
taken before a repair — a late answer to an abandoned turn would otherwise
overwrite the repaired thread and every newer turn, because the restore
writes the snapshot INTO the live aliased thread.

Design history: `docs/superpowers/specs/2026-07-22-orphaned-tool-use-on-guard-abort-design.md`.

---

## How are threads passed into prompts?

`lib/backends/typescriptBuilder.ts` picks the thread expression when it builds the `runPrompt` config:

```typescript
let threadExpr: TsNode = ts.threads.getOrCreateActive();
if (node.async) {
  threadExpr = ts.threads.createAndReturnSubthread();
}
```

An async prompt forks a subthread. It therefore sees the conversation so far, but its own messages never land on the shared active thread.

The expression becomes the `messages` field of the `runPrompt` config. `ctx` and `stateStack` are not passed at the call site; `runPrompt` reads them from the active ALS frame through `getRuntimeContext()`.

The runtime (`lib/runtime/prompt.ts`) uses `messages.getMessages()` to build the LLM API call, and appends assistant/tool responses back to the same `MessageThread`.

---

## How are threads passed into functions?

A call site no longer passes the ThreadStore. Since the AsyncLocalStorage migration, `setupFunction()` in `lib/runtime/node.ts` reads `threads` off the active `agencyStore` frame, which the caller seeded (a `runner.step` body, `runNode`'s top-level frame, or `runBatch.runInBranchAlsFrame`). See [async-context.md](./async-context.md).

This means **functions share the same ThreadStore as their caller**, so they participate in the same thread scoping. The active stack is shared. A direct JS caller of `__foo_impl` from outside an Agency frame has to wrap the call in `runInTestContext`.

---

## What happens if a function is called inside of a thread?

The function receives `__threads` (the caller's ThreadStore) via the internal function call template. Since the thread block already pushed a thread onto the active stack, the function's prompts will use `__threads.getOrCreateActive()` which returns that thread. So:

- The function's LLM calls accumulate messages on the **caller's active thread**
- The function can also create nested threads/subthreads (they push/pop on the same active stack)
- When the function returns, the active stack is unchanged (the caller's thread is still active)

**Exception — when called as a tool by the LLM** (`lib/runtime/prompt.ts`): the tool loop runs `handler.invoke` inside a copy of the parent ALS frame whose `threads` slot is a **fresh, isolated** `ThreadStore`. Everything else in the frame is inherited, because branch-aware cancellation and per-branch state depend on it.

The isolation is not cosmetic. Without it, an `llm()` call inside a tool body would push messages onto the outer prompt's thread, whose last message is `assistant(tool_calls=[this tool])`. OpenAI rejects that shape with "An assistant message with 'tool_calls' must be followed by tool messages".

The fresh store is lazy rather than `withDefaultActive`, so a leaf tool that never calls `llm()` does not emit a phantom `threadCreated` event.

**Second exception — handoff functions** (`handoff def`): the tool loop does not install a fresh store for these. The assistant message carrying the tool call is rewritten into a marker first, so nothing dangles, and the body's `llm()` calls append to the caller's active thread. See `docs/dev/language/handoff-functions.md`.

---

## What happens if a variable is assigned to a thread?

For `msgs = thread { ... }` or `msgs = subthread { ... }`:

Codegen appends the assignment to the END of the callback body:
```typescript
msgs = __threads.active().cloneMessages();
```

It has to be inside the callback, because `Runner.thread` pops the active stack in its `finally`.

The variable receives a **deep clone** of the thread's accumulated messages (`smoltalk.Message[]` array). The thread itself is popped from the active stack and remains in the ThreadStore but is no longer active.

---

## How do we handle synchronous versus asynchronous calls differently?

### Synchronous (default) prompts
- Thread expression: `__threads.getOrCreateActive()` — uses the current active thread
- Generated as `await _varName(...)` — blocks until complete
- Messages accumulate sequentially on the active thread
- After the call, checks for interrupts and returns early if needed

### Async prompts (`node.async === true`)
- Thread expression: `__threads.createAndReturnSubthread()` — a fork of the active thread, so the call sees prior context but writes back to its own thread
- Generated without an `await`, so it returns a Promise immediately
- No interrupt check (can't interrupt mid-flight)
- The promise is stored and must be awaited later

### Key files
| File | Role |
|------|------|
| `lib/runtime/state/messageThread.ts` | MessageThread class (message wrapper) |
| `lib/runtime/state/threadStore.ts` | ThreadStore class (thread registry + active stack) |
| `lib/runtime/node.ts` | setupNode/setupFunction (ThreadStore initialization) |
| `lib/runtime/prompt.ts` | runPrompt (uses thread for LLM calls), tool call isolation |
| `lib/runtime/runner.ts` | `Runner.thread()` — create/reopen, active stack, thread hooks |
| `lib/runtime/threadRepair.ts` | `repairReopenedThread` |
| `lib/backends/typescriptBuilder.ts` | `processMessageThread`, prompt thread expression |
| `lib/ir/prettyPrint.ts` | Prints the `runnerThread` IR node |
| `lib/templates/backends/typescriptGenerator/imports.mustache` | Imports `MessageThread` / `ThreadStore` / `__threads` into generated modules |
| `tests/typescriptGenerator/threadsAndSubthreads.agency` | Thread/subthread fixture |
| `tests/agency/threads/` | End-to-end thread tests |

## Accessing the active ThreadStore from stdlib TS

Stdlib helpers that push messages onto the active thread (e.g. `_systemMessage`, `_userMessage`, `_assistantMessage` in `lib/stdlib/thread.ts`) read the live `ThreadStore` from the AsyncLocalStorage frame via `getRuntimeContext().threads`. That's the same `ThreadStore` `setupNode` installs on the frame — see [async-context.md](./async-context.md) for the seeding points.
