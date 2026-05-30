# Cross-Thread Context Sharing

The cross-thread context-sharing feature lets one agent inspect, read, and resume **sibling `thread {}` blocks** in the same run. The marquee use case is the *categorize-and-route* pattern: a top-level router sends each user message to a specialized agent node, each agent owns its own thread for isolation, and when the user returns to an earlier topic the router resumes the *original* thread instead of starting fresh.

```agency
import { listThreads, getThread, currentThreadId } from "std::threads"
```

Three exports cover the user-facing API:

- `listThreads(): ThreadInfo[]` — every thread in the run (active + closed) with optional `label` and lazily-generated `summary`.
- `getThread(id, offset, limit): ThreadMessage[]` — paginated read of any thread's messages.
- `currentThreadId(): string` — slug of the active thread, useful when you want to capture an id at the moment it was active so you can `thread(continue: id)` later.

And the `thread {}` block grows four optional named arguments:

```agency
thread(label: "coding task", summarize: true) { /* ... */ }
thread(continue: priorId) { /* ... */ }
thread(session: "coding", label: "coding") { /* ... */ }
```

`continue` and `session` are mutually exclusive — pick one. `session` is sugar over `continue` plus a runtime-owned name → id map.

---

## Why `label` *and* `summary`?

A `thread {}` block inside a loop runs many times with very different content. The user-supplied `label` captures the *template intent* ("this is a coding task"). The auto-generated `summary` captures *what actually happened in this instance* ("refactored auth, added JWT validation"). `listThreads()` returns both so an LLM searching for "the auth one" can match on summary while one looking for "any coding task" can match on label.

## Slug ids (`t1`, `t2`, ...) vs. nanoids

`ThreadStore` uses a per-store integer counter internally; the registry exposes it as a slug (`t${counter}`). LLMs handle short ordinal strings far better than random nanoids, and the wrong-but-valid-integer risk is bounded by `listThreads()` returning the summaries — the LLM picks by reading the list, not by guessing an integer.

---

## Resuming a thread (`continue`)

`thread(continue: id)` re-enters a previously-closed thread. New messages append to its existing history rather than starting fresh:

```agency
import { getThread, currentThreadId } from "std::threads"
import { userMessage } from "std::thread"

node main() {
  let codingId: string = ""
  thread(label: "coding") {
    userMessage("first coding turn")
    codingId = currentThreadId()
  }
  // ... work on something else ...
  thread(continue: codingId) {
    userMessage("back to coding")
  }
  // The coding thread now holds BOTH messages, in order.
}
```

**v1 limitation: subthreads cannot be resumed.** A subthread inherits its parent's message history at the moment it was created; resuming one outside that context would surface confusing ordering. If you need to continue work inside a subthread, resume the parent thread and open a fresh `subthread {}` block.

---

## Routing with sessions

`thread(session: "name")` is the bread-and-butter primitive for routers. The runtime owns a `session-name → thread-id` map; first entry creates a thread, subsequent entries auto-resume it — no id bookkeeping at the call site:

```agency
import { listThreads } from "std::threads"
import { userMessage } from "std::thread"

node main() {
  // First "coding" entry creates a new thread.
  thread(session: "coding", label: "coding") {
    userMessage("first coding")
  }
  // Distinct session — new thread.
  thread(session: "weather", label: "weather") {
    userMessage("weather request")
  }
  // Second "coding" entry RESUMES the original — message
  // history persists across the weather hop.
  thread(session: "coding", label: "coding") {
    userMessage("back to coding")
  }
}
```

Sessions are always **top-level threads** — they cannot map to subthreads. (If you want a subthread inside a session, open the session normally and put a `subthread {}` block inside.)

---

## Memory scoping for routed agents

When a router fans messages out to per-category agents, each agent should have its own *memory* scope so the coding agent's facts don't bleed into the weather agent. `setMemoryId(category)` from `std::memory` is already per-branch — call it at the top of each routed node:

```agency
import { setMemoryId } from "std::memory"

node coding() {
  setMemoryId("coding")
  // ... coding-specific recall() and remember() calls ...
}

node weather() {
  setMemoryId("weather")
  // ... weather-specific recall() and remember() calls ...
}
```

If you have facts that everyone should read — a workspace overview, the user's name — keep one well-known id and switch to it for cross-cutting writes:

```agency
node coding() {
  setMemoryId("workspace")
  remember("the user prefers Rust")
  setMemoryId("coding")
  // ... back to per-category scope ...
}
```

This pairs with `thread(session: category)` to give each routed agent its own thread *and* its own memory scope:

```agency
import { listThreads } from "std::threads"
import { setMemoryId } from "std::memory"

node routedAgent(category: string, message: string) {
  setMemoryId(category)
  thread(session: category, label: category) {
    // ... category-specific work ...
  }
}
```

---

## Cross-node persistence

The thread registry persists across node transitions automatically. Internally a single `ThreadStore` is created once per `runNode` call and threaded through `state.messages` to every step — so threads created in node `a` remain queryable from node `b`. Subthreads are normal entries in the same registry with `parentId` set.

On interrupt resume the store is rebuilt from `stack.threads` (checkpoint serialization). The registry survives the interrupt and in-flight `thread {}` blocks resume mid-flight via the existing substep mechanism. See `docs/dev/threads.md` for the underlying mechanism.

---

## How this is built

The whole feature is six small primitives plus a stdlib module:

1. `agency.threads.{list, get, current}` — TS namespace, parallel to `agency.memory.*`.
2. `onThreadStart` / `onThreadEnd` lifecycle hooks, in the same `CallbackMap` as `onNodeStart`/`onNodeEnd`.
3. `thread(label, summarize)` named args.
4. Cross-node persistence (no new code — `ThreadStore` already flows through `state.messages` on every node transition).
5. `thread(continue: id)` — `ThreadStore.resumeExisting()`, rejects subthreads.
6. `thread(session: "name")` — `ThreadStore.openSession()`, sugar over `continue`.

The `stdlib/threads.agency` module is *the same code a user could write* on top of those primitives. If you want to ship a "tag threads by topic" feature, or a "diff two threads" inspector, or any other variant, the same surface is open to you — `agency.threads.*` plus the lifecycle hooks plus `thread(label / summarize / continue / session)` cover the whole feature set.

---

## Out of scope for v1

- **Auto-context injection by label.** Users can replicate it in three lines with `listThreads().filter(...)`.
- **Cross-run persistence.** The registry is run-scoped — restarting the agent starts fresh.
- **Filtering / search in `listThreads`.** Returns everything; the LLM filters.
- **Summary regeneration.** Once cached, a summary is final. Eager summarize on close (`thread(summarize: true)`) is not yet wired through the v1 stdlib hook — it remains on the wire for users who register their own `callback("onThreadEnd")`.
- **A router primitive.** User-space already expresses categorize-and-route in three lines (see `tests/agency/categorize.agency`); adding `route { ... }` would be redundant complexity.
