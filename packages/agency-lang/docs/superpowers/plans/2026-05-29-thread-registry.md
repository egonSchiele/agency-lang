# Cross-Thread Context Sharing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent discover, read, and *continue* sibling `thread {}` blocks within the same run, so "separate but related" tasks can share context without dissolving thread isolation. Persists across node transitions; no interaction with the long-term memory layer.

**Primary use case:** the categorize-and-route pattern. A top-level categorizer (see `tests/agency/categorize.agency` for the three-line LLM form) sends each user message to a specialized agent node. Each agent has its own thread. The registry + continuation primitives let the third user message that re-visits a category (e.g., "back to the coding task") resume the *original* thread, not start fresh.

**Core design bet:** Instead of building the registry as a black-box feature, ship it as four small **extensibility primitives** plus a **stdlib module** that uses them. The stdlib module is *the same code a user would write themselves* given those primitives — so the same APIs that ship the feature also unlock users building "tag threads by topic", "diff two threads", and similar variants in user space.

---

## User-visible API (final)

Three new exports added to a new module `stdlib/threads.agency` (separate from `std::thread`, which today only handles cost/tokens/messages within the active thread):

```agency
import { listThreads, getThread } from "std::threads"

type ThreadInfo = {
  id: string,                          // ordinal slug — "t1", "t2", ...
  label?: string,                      // user-supplied (thread template purpose)
  summary?: string,                    // auto-generated (per-instance content)
  parentId?: string,                   // for subthreads
  threadType: "thread" | "subthread",
  messageCount: number,
  isActive: boolean,                   // true iff this is the currently active thread
}

// Returns all threads in the registry. If a thread has no cached
// summary yet, generates one lazily on first call (one LLM round-trip
// per thread that needs it). `label` is returned as-is.
def listThreads(): ThreadInfo[]

type ThreadMessage = {
  role: "system" | "user" | "assistant" | "tool",
  content: string,
}

// Paginated read of a closed thread's messages. `offset` defaults to
// 0, `limit` defaults to 50. Returns the active thread's messages
// too, so an agent can introspect itself.
def getThread(id: string, offset: number = 0, limit: number = 50): ThreadMessage[]
```

The `thread { }` block gains four optional named args:

```agency
// label:     template-level purpose. Same string across repeated
//            invocations of the same `thread` block.
// summarize: if true, eagerly summarize at thread close (instead of
//            lazily on first listThreads() call). Default false.
// continue:  resume a previously-closed thread by id. Existing
//            messages stay intact; new messages append. Errors if
//            the id is unknown.
// session:   sugar over `continue`. The runtime keeps a
//            session-name → thread-id map; first entry with a given
//            session name creates a thread, subsequent entries
//            resume it. The router pattern's bread-and-butter.
thread(label: "coding task", summarize: true) { /* ... */ }
thread(continue: priorId) { /* ... */ }                  // explicit resume
thread(session: "coding", label: "coding task") { /* ... */ }  // declarative resume
```

`continue` and `session` are mutually exclusive. `session` is just `continue` with a runtime-owned id map — picking one or the other is a style choice; both compile to the same `pushExistingActive` machinery.

### Why both `label` and `summary`?

A `thread {}` block in a loop runs many times with very different content. The user-supplied `label` captures the *template intent* ("this is a coding task"); the auto-`summary` captures *what actually happened in this instance* ("refactored auth, added JWT validation"). `listThreads()` returns both so an LLM filtering by "I want the auth one" can match on summary, while one looking for "any coding task" can match on label.

### Why ordinal slug IDs (`t1`, `t2`...) instead of nanoid?

`ThreadStore.create()` already uses a per-store integer counter, so we just expose it as a slug (`t${counter}`). Two reasons:

1. **LLMs handle short ordinal strings well.** A random nanoid like `V1StGXR8_Z5jdHi6B-myT` is easy for an LLM to mis-type or hallucinate.
2. **The "wrong but valid integer" risk is bounded** by `listThreads()` returning the slug → summary mapping. The LLM picks by reading the summary list, not by guessing an integer.

Internal storage keeps the existing counter-string ID; the slug is a pure presentation concern in the registry wrapper.

---

## Architecture

```diagram
╭────────────────────────────────────────────────────╮
│  stdlib/threads.agency  (user-buildable layer)     │
│                                                    │
│   def listThreads(): ThreadInfo[]                  │
│   def getThread(id, offset, limit)                 │
│                                                    │
│   summaries: Record<id, string>  ← agency global   │
│   labels:    Record<id, string>  ← agency global   │
│                                                    │
│   On import:                                       │
│     agency.threads.onThreadClose(t => {            │
│       if (t.label) labels[t.id] = t.label          │
│       if (t.eagerSummarize) summarize(t) → cache   │
│     })                                             │
╰────────────┬───────────────────────────────────────╯
             │ uses
             ▼
╭────────────────────────────────────────────────────╮
│  Primitives (added to core)                        │
│  1. agency.threads.{list, get, current}            │
│  2. thread(label?, summarize?) named args          │
│  3. onThreadStart / onThreadEnd lifecycle hooks    │
│  4. ThreadStore persists across node transitions   │
│  5. thread(continue: id) — resume a closed thread  │
│  6. thread(session: "name") — runtime-owned        │
│     session→id map, sugar over (5)                 │
╰────────────────────────────────────────────────────╯
```

Build strategy: each primitive lands in its own task, the stdlib module is the last task on top. Every primitive is independently useful — a user could ignore the stdlib module and write their own (`tagged-threads`, `thread-diff`, etc.) on the same surface.

---

## Open questions resolved

| Question | Decision |
|---|---|
| Eager vs. lazy summarization? | Both. Lazy is default; `thread(summarize: true)` opts into eager-at-close so users with many threads don't hit the "first `listThreads()` is slow" cliff. |
| Same thread block repeated → which summary wins? | Keep both. `label` is template-level (user-supplied), `summary` is per-instance (auto). Both surface in `ThreadInfo`. |
| ID format? | Ordinal slug (`t1`, `t2`...) wrapping the existing counter. LLM-friendly; the wrong-ID risk is bounded by `listThreads()` returning summaries to disambiguate. |
| Active conversation across nodes? | **No.** Only the registry persists; the active thread still resets per node. |
| Long-term memory layer interaction? | **No direct coupling.** The recommended router pattern is `setMemoryId(category)` at the top of each routed node so the knowledge graph is per-agent. Existing primitive, doc-only. |
| Read-only or read-write? | **Read + resume.** `getThread(id)` is read; `thread(continue: id)` and `thread(session: "name")` are resume. The router-back-to-coding scenario needs resume — reading-only forces every re-entry to re-pay the entire prior context. |
| Categorize-and-route — should the runtime own routing? | **No.** User-space code already expresses it in three lines (see `tests/agency/categorize.agency`); a router primitive would be redundant. |

---

## Pre-flight

- [ ] **Sanity check the current tree is green**

  ```bash
  pnpm test:run 2>&1 | tee /tmp/preflight-test.log
  ```

  If any failures exist that are unrelated to this work, surface them before continuing.

- [ ] **Read the existing thread infrastructure**

  Skim, in this order:
  - `lib/runtime/state/threadStore.ts` — `ThreadStore`, the counter, `withDefaultActive`, `setupNode`'s wiping behavior.
  - `lib/runtime/state/messageThread.ts` — `MessageThread` shape and `MessageThreadJSON`.
  - `lib/runtime/hooks.ts` — `CallbackMap` and the `onAgent*`, `onNode*`, `onFunction*` patterns to mirror.
  - `lib/runtime/node.ts::setupNode` — the line that calls `ThreadStore.withDefaultActive(...)` on every fresh node. This is what Task 4 changes.
  - `stdlib/memory.agency` and `lib/runtime/agency.ts::agency.memory.*` — the analog we mirror in Tasks 1 + 5.

---

## Task 1 — `agency.threads.*` TS-helper namespace

**Goal:** Expose `ThreadStore` read methods via the canonical `agency` namespace, parallel to `agency.memory.*`. Pure read-side; no behavior change yet.

- [ ] **Step 1: Add `agency.threads` to `lib/runtime/agency.ts`**

  Add a `threads` sub-namespace alongside `agency.memory`:

  ```ts
  threads: {
    /** All threads in the run's registry. Returns plain records, not
     *  live `MessageThread` instances — safe to serialize / pass to
     *  LLMs. Includes the currently active thread (with `isActive: true`). */
    list(): ThreadInfoTS[],
    /** Read a slice of a thread's messages. Returns `[]` if the id is
     *  unknown. */
    get(id: string, offset?: number, limit?: number): ThreadMessageTS[],
    /** ID of the currently active thread, or `undefined` outside a
     *  runtime frame. */
    current(): string | undefined,
  }
  ```

  Implementation reads `getRuntimeContext().ctx?.stateStack.threads` (the `ThreadStore`). For `list()`, iterate `threads.threads`, map each `MessageThread` to a `ThreadInfoTS` (id-slugged via `t${id}`, `messageCount = thread.messages.length`, `isActive = id === activeId`). `get()` slices `thread.messages` and maps each to `{ role, content }`.

  Both `ThreadInfoTS` and `ThreadMessageTS` are pure-TS types; the Agency-side analogs live in `stdlib/threads.agency` and structurally match.

- [ ] **Step 2: Add `agency.threads` unit tests**

  In `lib/runtime/agency.test.ts`, mirror the `agency.memory.*` test pattern: construct a `RuntimeContext`, run something that creates two threads, assert `agency.threads.list()` returns both with stable order and `isActive` set correctly on the right one, assert `agency.threads.get("t0", 0, 1)` returns just the first message.

- [ ] **Step 3: Verify**

  ```bash
  pnpm vitest run lib/runtime/agency.test.ts 2>&1 | tee /tmp/task1.log
  ```

---

## Task 2 — `onThreadStart` / `onThreadEnd` lifecycle hooks

**Goal:** Fire callbacks when a `thread {}` block opens and when it closes. Mirrors the existing `onNodeStart`/`onNodeEnd` pattern in `lib/runtime/hooks.ts`.

- [ ] **Step 1: Extend `CallbackMap`**

  In `lib/runtime/hooks.ts`, add two entries:

  ```ts
  onThreadStart: {
    threadId: string;             // slug form, e.g. "t3"
    threadType: "thread" | "subthread";
    parentThreadId?: string;
    label?: string;               // from thread(label: "...") {} — see Task 3
  };
  onThreadEnd: {
    threadId: string;
    label?: string;
    eagerSummarize: boolean;      // from thread(summarize: true) — Task 3
    messages: MessageJSON[];      // snapshot at close — registry uses this
  };
  ```

  Append `"onThreadStart"` and `"onThreadEnd"` to `VALID_CALLBACK_NAMES` so the compile-time guard stays green.

- [ ] **Step 2: Fire the events**

  `ThreadStore` already emits `threadCreated` to `StatelogClient`. Find the `thread {}` block's TS emitter (look in `lib/backends/typescriptGenerator/` for "thread" or in the runtime helpers it calls — likely `pushActiveThread` / `popActiveThread` on `ThreadStore`). At those two sites, add:

  ```ts
  await callHook({ ctx, name: "onThreadStart", payload: {...} });
  // ...block runs...
  await callHook({ ctx, name: "onThreadEnd",   payload: {...} });
  ```

  The `messages` snapshot in the End payload is `thread.messages.map(m => m.toJSON())`.

- [ ] **Step 3: Add a unit test**

  In `lib/runtime/hooks.test.ts` (or wherever `onNodeStart` is tested), register a TS callback for `onThreadStart`/`onThreadEnd`, run an Agency program with one `thread {}` block, assert both callbacks fire with the right `threadId` and that the End payload contains the message snapshot.

---

## Task 3 — `thread(label, summarize)` named args

**Goal:** Let users tag a `thread {}` block with a template-level label and opt into eager summarization at close.

- [ ] **Step 1: Parser**

  `thread {}` is currently a block-form keyword (see `lib/parsers/`). Find the parser and accept an optional named-arg list:

  ```agency
  thread(label: "coding task", summarize: true) { ... }
  ```

  Both args are optional; the no-arg form `thread { ... }` keeps working unchanged. The AST node for `thread` gains two optional fields `label: Expression | null` and `summarize: Expression | null`.

- [ ] **Step 2: Codegen**

  In `lib/backends/typescriptGenerator/`, find the thread emitter and forward the new args to the runtime helper that opens the thread. Plumb them through to the `onThreadStart` payload (label) and `onThreadEnd` payload (label + eagerSummarize).

- [ ] **Step 3: Type checker**

  Both args have known types (`string` and `boolean`). Add the entry to whatever named-args validator the typechecker uses for keyword forms. Reject unknown arg names.

- [ ] **Step 4: Parser + typechecker tests**

  Add fixtures under `tests/parser/` and `tests/typeChecker/` covering: no-args, label-only, summarize-only, both, unknown arg (should error), wrong type (should error).

- [ ] **Step 5: Update the language guide**

  Append a short section to `docs/site/guide/threads.md` documenting the two args, what they're for, and noting that without them `thread {}` behaves exactly as before.

---

## Task 4 — `ThreadStore` persists across node transitions

**Goal:** Today, every fresh node calls `ThreadStore.withDefaultActive(...)` (see `setupNode` in `lib/runtime/node.ts`), which throws away the registry. Make the registry survive node boundaries while still resetting the *active* thread.

- [ ] **Step 1: Decide the persistence vehicle**

  Options:
  - **A.** Stash the `ThreadStore` on `RuntimeContext` as a run-scoped field; `setupNode` looks there first before falling back to `withDefaultActive`.
  - **B.** Move the `threads` field off `StateStack` (per-branch) and onto the run-level context (cross-node).

  Go with **A**. `StateStack` per-branch isolation is correct for the *active* thread; the cross-node *registry* is the new concept. Adding a `RuntimeContext.runThreadStore?: ThreadStore` field is the smallest correct change.

- [ ] **Step 2: Add `ThreadStore.beginNode()` so `setupNode` doesn't have to know how**

  In `lib/runtime/state/threadStore.ts`, add:

  ```ts
  /** Reset the active-thread stack for a new node boundary while
   *  keeping the registry of all prior threads. The single owner of
   *  "what 'enter a fresh node' means for a thread store." */
  beginNode(): void {
    this.activeStack = [];
    this.getOrCreateActive();
  }
  ```

- [ ] **Step 3: Wire `setupNode`**

  In `lib/runtime/node.ts::setupNode`, the new branch is a one-line idempotent assignment plus a call to `beginNode()`. No mutation of `activeStack`, no manual `getOrCreateActive`, no order-sensitive "set, then store on ctx" pair:

  ```ts
  let threads: ThreadStore;
  if (stack?.threads) {
    threads = ThreadStore.fromJSON(stack.threads);
  } else if (state.messages instanceof ThreadStore) {
    threads = state.messages;
  } else {
    // Idempotent: first node creates it, every subsequent node reuses it.
    ctx.runThreadStore ??= ThreadStore.withDefaultActive(ctx.statelogClient);
    threads = ctx.runThreadStore;
    threads.beginNode();
  }
  ```

  `setupNode` now says *what* it wants ("a thread store, starting a new node"); `beginNode` owns *how*.

- [ ] **Step 4: Make sure `beginNode` doesn't lose the registry**

  Add a `ThreadStore` test: create two threads, call `beginNode()`, assert the two pre-existing threads are still in `threads.threads` and `counter` advanced past them (so the new active thread doesn't collide with their IDs).

- [ ] **Step 5: Integration test**

  Add a new agency test under `tests/agency/threads-registry/`:
  ```agency
  import { listThreads } from "std::threads"
  node a() { thread { /* something */ } -> b }
  node b(): number { return listThreads().length }   // expect 2 (a's thread + b's active)
  ```
  (Requires Task 5 to compile; commit this test alongside.)

- [ ] **Step 6: Checkpoint compatibility**

  Old checkpoints don't have `runThreadStore` serialized. Confirm the back-compat path is just the existing `withDefaultActive` fallback — i.e. on resume, the registry restarts empty. Document this in the new module's docstring.

---

## Task 5 — `stdlib/threads.agency` module

**Goal:** Build the user-facing API entirely on top of the four primitives from Tasks 1–4. The TS side adds no new behavior; it's all wiring.

**Design principle:** *one* cache keyed by thread id, *one* accessor that owns get-or-compute. The "what" — a thread has an optional label and an optional summary — lives in a single type. The "how" — when to read from cache vs. when to LLM-summarize — lives in one place. No parallel maps to keep in sync, no order-sensitive mutations in callbacks.

- [ ] **Step 1: Create the module with a single-cache shape**

  Create `stdlib/threads.agency` with the three exports (`listThreads`, `getThread`, types). Internal state is a single `static const` map keyed by thread id, persisted across nodes via the global-store layer:

  ```agency
  type Cached = { label?: string, summary?: string }

  static const cache: Record<string, Cached> = {}

  // Single owner of the cache-write rule: a patch shallow-merges into
  // the entry for `id`. Callers never index into `cache` directly.
  def remember(id: string, patch: Cached) {
    cache[id] = { ...cache[id], ...patch }
  }

  // Single owner of the "return cached summary, else LLM-summarize and
  // cache" rule. Active threads pass `null` so the LLM call is skipped
  // while the conversation is still in flight.
  def summaryFor(id: string, messages: (ThreadMessage[] | null) = null): (string | null) {
    if (cache[id]?.summary) { return cache[id].summary }
    if (messages == null) { return null }
    const s = summarize(messages)
    remember(id, { summary: s })
    return s
  }
  ```

  `summarize(messages)` is a one-shot LLM call internal to this module; pin its model with the runtime default so it doesn't blow up costs.

- [ ] **Step 2: Lifecycle hook — one writer, one rule**

  Module-load registers the `onThreadEnd` hook, which only ever writes through `remember`:

  ```agency
  static const _ = agency.threads.onThreadEnd((evt) => {
    remember(evt.threadId, { label: evt.label })
    if (evt.eagerSummarize) {
      remember(evt.threadId, { summary: summarize(evt.messages) })
    }
  })
  ```

  Both writes go through `remember`, so the merge rule (spread over the existing entry, partial patches compose) lives in one place. The callback is *order-independent within `remember` calls* — re-arranging the two statements produces the same final cache state. That eliminates the "if label, set labels[id]; if summarize, set summaries[id]" ladder that the parallel-maps version invited.

- [ ] **Step 3: `listThreads()` — one declarative map**

  No imperative for-loop, no per-iteration mutation:

  ```agency
  def listThreads(): ThreadInfo[] {
    return agency.threads.list().map((t) => {
      // Active threads pass `null` for messages so summaryFor skips
      // the LLM call while the conversation is still in flight.
      let messages: (ThreadMessage[] | null) = null
      if (t.isActive == false) { messages = t.messages }
      return {
        ...t,
        label: cache[t.id]?.label,
        summary: summaryFor(t.id, messages)
      }
    })
  }
  ```

  The "what" (every ThreadInfo has an optional label and an optional summary) is the type; the "how" (cache lookup, lazy LLM call, active-thread skip) is one call to `summaryFor`. Adding behavior — e.g. "regenerate stale summaries" or "summarize subthreads inline" — changes one accessor, not the loop.

- [ ] **Step 4: `getThread(id, offset, limit)`**

  Thin pass-through to `agency.threads.get` — that primitive already returns `[]` for unknown ids (see Task 1 contract), so no extra logic here:

  ```agency
  def getThread(id: string, offset: number = 0, limit: number = 50): ThreadMessage[] {
    return agency.threads.get(id, offset, limit)
  }
  ```

- [ ] **Step 5: Tests**

  Under `tests/agency/threads-registry/`:
  - `basic.agency` — create two threads via `thread {}`, assert `listThreads().length == 2` and that summaries are non-empty.
  - `label.agency` — `thread(label: "x") { ... }`, assert the returned `ThreadInfo` carries `label: "x"` without an LLM call (label alone shouldn't trigger summarize).
  - `pagination.agency` — create a thread with 60 messages (use `__internal_userMessage` etc.), assert `getThread(id, 0, 10).length == 10` and `getThread(id, 50, 50).length == 10`.
  - `eager-vs-lazy.agency` — `thread(summarize: true) {...}` vs `thread {...}`. Use a deterministic-LLM-client agency-js test that counts summarize calls.

  Run via `pnpm run agency test tests/agency/threads-registry/<name>.test.json`. Save output to `/tmp/task5.log` per the project's "save test output" rule.

- [ ] **Step 6: Documentation**

  - Add `docs/site/guide/cross-thread-context.md` covering the user model (listThreads, getThread, label vs summary).
  - Append a short "How this is built" section pointing at `agency.threads.*` and `onThreadEnd`, with the message: *"these primitives are public — you can build your own variants (tag threads by topic, diff two threads, etc.) the same way `std::threads` does."*

---

## Task 6 — `thread(continue: id)` — explicit thread continuation

**Goal:** Re-enter a previously-closed thread. New messages append to its existing history instead of starting fresh.

**Why it's a runtime feature, not user-space:** the thread's message history lives inside `ThreadStore`, which is not on the public Agency surface. The minimal primitive that unlocks resumption is "push an existing thread id back onto `activeStack`" — that's a one-method addition to `ThreadStore`.

- [ ] **Step 1: Add `ThreadStore.resumeExisting(id)`**

  In `lib/runtime/state/threadStore.ts`:

  ```ts
  /** Re-activate a previously-closed thread. Pushes `id` onto
   *  `activeStack` (same path as `pushActive`) without creating a new
   *  MessageThread. Throws if `id` is unknown — silent fallback to
   *  create-new would mask a real bug (typo, hallucinated id) at the
   *  call site. */
  resumeExisting(id: MessageThreadID): void {
    if (!this.threads[id]) {
      throw new Error(`Cannot resume unknown thread id: ${id}`);
    }
    this.activeStack.push(id);
    this.statelogClient?.threadResumed?.({ threadId: id });
  }
  ```

  Add a matching `threadResumed` event to `StatelogClient` (optional method, mirrors `threadCreated`). The block closer is the existing `popActive` — no change needed there.

- [ ] **Step 2: Parser + AST**

  Extend the `thread {}` parser (already touched by Task 3 for `label` / `summarize`) to accept `continue: <expr>`. AST gains `continueExpr: Expression | null`. `continue` and `session` (Task 7) are mutually exclusive — reject at parse time.

- [ ] **Step 3: Codegen**

  In the thread-block emitter, if `continueExpr` is set, evaluate the expression to a string, **slug-strip** the leading `t` (the public form is `t1`, the storage form is `1`), and call `threads.resumeExisting(rawId)` instead of `threads.create()`. The rest of the block (push handlers, run body, pop) stays identical.

- [ ] **Step 4: `onThreadStart` payload**

  When `continue` was used, fire `onThreadStart` with a new field `isResumption: true` and the original `threadId`. This matters for `stdlib/threads.agency` — the resumed thread shouldn't double-count toward `messageCount` baselines, and a future "this thread was resumed N times" stat is then free.

- [ ] **Step 5: Tests**

  - Unit test in `lib/runtime/state/threadStore.test.ts`: create a thread, close it, `resumeExisting(id)`, assert `activeId()` matches and `threads[id]` is unchanged.
  - Agency integration test under `tests/agency/threads-registry/continue.agency`: open a thread, send a user message, close, `thread(continue: id) { ... }`, send another message, assert the active thread's message count is 2 (not 1).
  - Negative test: `thread(continue: "tDoesNotExist") { ... }` raises a clear runtime error mentioning the id.

- [ ] **Step 6: Doc**

  Add a "Resuming a thread" section to `docs/site/guide/cross-thread-context.md`. Show the router-back-to-coding example end-to-end. Call out the slug → raw-id translation as an internal detail users don't see.

---

## Task 7 — `thread(session: "name")` — session-keyed continuation

**Goal:** The runtime owns a `session-name → thread-id` map keyed per run. First entry with a given session name creates a thread; subsequent entries auto-resume it. Sugar over Task 6 — same machinery underneath, but the user never has to track ids manually.

**Why this is the router pattern's bread-and-butter:** A categorize-and-route loop where each routed agent does `thread(session: category, label: category) { ... }` gets per-category continuity *for free*. The router stays three lines (`categorize.agency` style) — no `Record<string, string>` to maintain, no "did I save the id?" footgun.

- [ ] **Step 1: Add `sessions` to `ThreadStore`**

  In `lib/runtime/state/threadStore.ts`:

  ```ts
  /** session-name → thread-id. Populated by `thread(session: ...)` on
   *  first entry; subsequent entries with the same name resume via
   *  `resumeExisting`. Serialized as part of `ThreadStoreJSON` so it
   *  survives interrupts and node transitions (lives on the same
   *  cross-node `runThreadStore` as Task 4's registry). */
  sessions: Record<string, MessageThreadID> = {};
  ```

  Extend `ThreadStoreJSON`, `toJSON`, and `fromJSON` to round-trip `sessions`. Default to `{}` when restoring older snapshots.

- [ ] **Step 2: Add `ThreadStore.openSession(name)`**

  Single owner of the "create if absent, resume if present" rule, so codegen stays dumb:

  ```ts
  /** Open a named session. Returns the thread id (whether newly
   *  created or resumed). Always leaves the session's thread on top
   *  of `activeStack`. */
  openSession(name: string): MessageThreadID {
    const existing = this.sessions[name];
    if (existing) {
      this.resumeExisting(existing);
      return existing;
    }
    const id = this.create();
    this.sessions[name] = id;
    this.activeStack.push(id);
    return id;
  }
  ```

- [ ] **Step 3: Parser + AST**

  Extend the `thread {}` parser to accept `session: <expr>`. AST gains `sessionExpr: Expression | null`. Enforce the `continue` ⊕ `session` mutual exclusion from Task 6.

- [ ] **Step 4: Codegen**

  In the thread emitter, if `sessionExpr` is set, emit `threads.openSession(name)` and skip the `threads.create()` / `pushActive` path. `onThreadStart` payload carries `isResumption: existed_before` so `stdlib/threads.agency` can tell first-entry from re-entry without keeping its own bookkeeping.

- [ ] **Step 5: Tests**

  - Unit test on `ThreadStore.openSession`: first call creates + pushes; second call with same name resumes the same id (assert `Object.keys(threads).length` stays at 1, `activeId() === firstId` both times).
  - Agency integration test `tests/agency/threads-registry/session.agency`: open `thread(session: "coding") { msg("a") }`, then `thread(session: "weather") { msg("b") }`, then `thread(session: "coding") { msg("c") }`. Assert the coding thread has messages `["a", "c"]` and the weather thread has `["b"]`. This is the user's three-message router scenario in test form.
  - Verify that an `onThreadStart` callback receives `isResumption: true` on the third entry.

- [ ] **Step 6: Doc + worked example**

  Append a "Routing with sessions" subsection to `docs/site/guide/cross-thread-context.md`. Show a complete categorize-and-route loop that uses `categorize.agency`-style routing + `thread(session: category, label: category) { ... }`. This is the canonical example we point users at when they ask "how do I build a multi-agent assistant?"

---

## Task 8 — Memory-per-agent: document the existing pattern

**Goal:** No new feature — `setMemoryId(category)` from `std::memory` is already per-branch (stored on `stateStack.other.memoryId`) and is exactly what the router pattern needs. We just need to *document* it as the recommended companion to `thread(session: ...)`, with a worked example, so users don't end up cross-polluting their agents' knowledge graphs by default.

- [ ] **Step 1: Confirm the per-branch semantics still hold**

  Quick sanity check: in a routed-node setup, calling `setMemoryId("coding")` at the top of the coding agent's node should not affect the weather agent's `recall()` in a parallel branch. If it does, that's a separate bug to surface — but per `lib/runtime/memory/manager.ts:78-91`, the id lives on `stateStack.other.memoryId` and is per-branch by construction.

  ```bash
  pnpm vitest run lib/runtime/memory 2>&1 | tee /tmp/task8-sanity.log
  ```

  Optional: add a focused test that two sibling branches with different `setMemoryId` calls produce disjoint `recall()` results.

- [ ] **Step 2: Doc — "Memory scoping for routed agents"**

  Append to `docs/site/guide/cross-thread-context.md`. Concretely:

  - Lead with the problem ("the coding agent's facts shouldn't bleed into the weather agent").
  - Show the pattern: each routed node opens with `setMemoryId(category)`.
  - Show the optional **shared** layer: leave one well-known id ("workspace") for facts everyone reads — agents `setMemoryId("workspace")` for cross-cutting writes, then switch back.
  - Tiny worked example combining Task 7's `thread(session: category)` with this `setMemoryId(category)` pattern, so the router doc has one canonical complete sample.

- [ ] **Step 3: Update the agency-agent example**

  In `lib/agents/agency-agent/agent.agency`, the current `setMemoryId(cwd())` line is fine for a single-purpose agent. Add a short comment pointing readers to the new guide for the multi-agent / router pattern, but don't change behavior. (This is a doc-pointer, not a refactor.)

---

## Task 9 — End-to-end polish

- [ ] **Step 1: Documentation cross-links**

  - Link the new guide page from `docs/site/guide/threads.md`.
  - Add `cross-thread-context.md` to the site nav (wherever the guide TOC lives).

- [ ] **Step 2: Verify full unit + lint pipeline**

  ```bash
  make 2>&1 | tee /tmp/final-build.log
  pnpm test:run 2>&1 | tee /tmp/final-unit.log
  pnpm run lint:structure
  ```

- [ ] **Step 3: Update changelog**

  Add a `CHANGELOG.md` entry under the next release: short note about the registry feature, the six new primitives (`agency.threads.*`, `onThreadStart/End`, `thread(label/summarize/continue/session)`, cross-node `ThreadStore`, `resumeExisting`/`openSession`), and the "you can build this yourself" angle. Call out the categorize-and-route worked example as the marquee use case.

---

## Out of scope for v1

- **Auto-context injection by label.** `thread(label: "coding", includePriorSummaries: true) { ... }` was discussed — held off because users can replicate it in three lines with `listThreads().filter(...)` once Tasks 1+5 ship.
- **Cross-run persistence.** The registry is run-scoped — restarting the agent starts fresh. (A future task could store the registry under the memory layer's `dir` if users ask for it.)
- **Filtering / search in `listThreads`.** Return everything; let the LLM filter. If the registry grows past ~hundreds of threads in real-world use we add server-side filtering later.
- **Summary regeneration.** Once cached, a summary is final. If users want fresh ones they can ignore the cached value in their own listThreads wrapper.
- **A router primitive.** User-space already expresses categorize-and-route in three lines (see `tests/agency/categorize.agency`); adding `route { ... }` would be redundant complexity. Documented as a deliberate non-goal in Task 8's guide so future contributors don't re-propose it.
