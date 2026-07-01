---
name: Cross-thread context sharing
description: Inspect, read, and resume sibling `thread {}` blocks in the same run. Covers `listThreads()`, `getThread()`, and the `thread(label, summarize, continue, session)` named arguments, plus the categorize-and-route worked example.
---

# Cross-thread context sharing

Here's the problem. You've built a router: a top-level node reads each user message, picks a category, and dispatches to one of several specialized agents. Each agent runs in its own `thread {}` block so its context stays clean. Great — until the user comes back to a topic they were discussing five minutes ago, and the agent has no memory of it. Each `thread {}` block starts fresh, so "back to coding" walks into a `coding` thread with no prior turns.

You need two things to fix this:

1. A way to *see* the other threads in the run.
2. A way to *resume* one when the user circles back.

The `std::thread` module gives you both:

```ts
import { listThreads, getThread, currentThreadId } from "std::thread"
```

And the `thread {}` block grows five optional named arguments:

```ts
thread(label: "coding") { /* ... */ }                        // tag it
thread(summarize: true) { /* ... */ }                         // pre-mark for eager summary
thread(continue: priorId) { /* ... */ }                       // resume by id
thread(session: "coding") { /* ... */ }                       // resume by name (sugar)
thread(label: "coding", hidden: true) { /* ... */ }           // exclude from listThreads()
```

`continue` and `session` are mutually exclusive — pick one. We'll cover each below.

## Listing threads

`listThreads()` returns every thread in the run, including the active one. It returns a `Result` (see [error handling](./error-handling)) — success holds a `ThreadInfo[]`, failure holds an error message (e.g. when called from outside a node body).

```ts
const all = listThreads()
if (isSuccess(all)) {
  for (t in all.value) {
    print("[" + t.id + "] " + t.label + " — " + t.summary)
  }
}
```

Each `ThreadInfo` has:

```ts
type ThreadInfo = {
  id: string             // slug form: "t0", "t1", ...
  label?: string         // from thread(label: "...") { }
  summary?: string       // LLM-generated, lazily on first listThreads() call
  parentId?: string      // set when this is a subthread
  threadType: string     // "thread" | "subthread"
  messageCount: number
  isActive: boolean
}
```

A few things worth knowing:

- **Slug ids (`t1`, `t2`, ...) instead of nanoids.** LLMs handle short ordinal strings far better than random ids. When the LLM picks a thread to resume, it picks by reading `listThreads()` and matching on the summary — not by guessing an integer.
- **Summaries are lazy.** The first time `listThreads()` runs against a closed thread without a cached summary, it makes one LLM call to summarize and stashes the result on the thread itself. Subsequent calls read the cache. Active threads are skipped so we don't summarize a half-finished conversation.
- **`label` vs `summary`.** A `thread {}` block inside a loop runs many times with very different content. `label` captures the *template intent* ("coding task"). `summary` captures *what actually happened this time* ("refactored auth, added JWT validation"). An LLM searching for "the auth one" can match on summary; one searching for "any coding task" can match on label.

## Reading a thread's messages

`getThread(id, offset, limit)` returns a slice of a thread's history. Also a `Result`:

```ts
const msgs = getThread("t1", 0, 20)
if (isSuccess(msgs)) {
  for (m in msgs.value) {
    print("[" + m.role + "] " + m.content)
  }
}
```

`offset` is 0-indexed; `limit` defaults to 50. Pass larger limits for a full-thread read.

## Resuming a thread by id

`thread(continue: id)` re-enters a previously-closed thread. New messages append to its history rather than starting fresh:

```ts
import { getThread, currentThreadId, userMessage } from "std::thread"

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

You'll want `currentThreadId()` to capture the id at the moment the thread is active. Storing it in a parent-scope variable like the example does is the simplest pattern.

One v1 limitation: **subthreads cannot be resumed.** A subthread inherits its parent's message history at the moment it was created; resuming one outside that context would surface confusing ordering. If you need to continue work that was inside a subthread, resume the parent thread and open a fresh `subthread {}` block.

## Resuming a thread by name (sessions)

Saving and reaching back for ids gets old fast. `thread(session: "name")` does the bookkeeping for you — the runtime owns a `session-name → thread-id` map; first entry creates a thread, subsequent entries auto-resume:

```ts
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

Sessions are always **top-level threads** — they cannot map to subthreads. If you want a subthread inside a session, open the session normally and put a `subthread {}` block inside.

### Sessions across concurrent branches

The session map is **per-run** and **shared across all branches** of `parallel`, `fork`, and `race`. This is what makes the cooperative-fork pattern work without any extra plumbing — multiple forks can each open the same session name and the second one auto-resumes the first:

```ts
const cities = ["SF", "LA", "NY"]

const popData = fork(cities) as city {
  thread(session: "data-for-${city}") {
    return llm("What's the population of ${city}?")
  }
}

const sizeData = fork(cities) as city {
  thread(session: "data-for-${city}") {
    return llm("What's the size of ${city}?")
  }
}
// The SF thread now contains both the population Q/A and the size Q/A,
// because the sessions map is shared across branches and across forks.
// The first popData branch for SF creates "data-for-SF"; the second
// fork's SF branch resumes it.
```

The same goes for `thread(continue: id)` — capture a thread id with `currentThreadId()` in the parent, then have fork branches `continue:` into it to write messages back. If two branches do that simultaneously the messages interleave non-deterministically — same as two branches concurrently appending to a shared array.

> Note: unguarded `llm()` and `userMessage()` calls inside a fork branch write to a **branch-local** subthread, not the parent's active thread. The branch-local subthread is discarded on join. Sessions and `thread(continue: id)` are the explicit channels for messages that should outlive the branch.

## The marquee example: categorize and route

Putting the pieces together — here's a router that classifies each user message, then dispatches to a per-category thread that auto-resumes if the user circles back:

```ts
import { listThreads, userMessage, llm } from "std::thread"
import { setMemoryId } from "std::memory"

node routedAgent(category: string, message: string) {
  setMemoryId(category)
  thread(session: category, label: category) {
    userMessage(message)
    const reply = llm("Reply to the user.")
    print(reply)
  }
}

node main(message: string) {
  // Classify the message however you like — LLM, rule, regex.
  // The string we get back becomes the session name.
  const category = llm("Classify the message as one of: coding, weather, smalltalk. Message: " + message)
  routedAgent(category, message)
}
```

That's it. The first time the user asks a coding question, a new `coding` thread opens. The next time, the existing one resumes. Weather questions get their own thread. Coding's history isn't polluted by weather, and the user can flip between topics without losing context.

The companion call is `setMemoryId(category)`: it gives each routed agent its own [memory](./memory) scope so facts don't bleed across categories. The coding agent's recall of "the user prefers tabs" doesn't surface in a weather conversation.

If you have facts everyone should read — a workspace overview, the user's name — keep one well-known id and switch to it for cross-cutting writes:

```ts
import { setMemoryId, remember } from "std::memory"

node coding() {
  setMemoryId("workspace")
  remember("the user prefers Rust")
  setMemoryId("coding")
  // ... back to per-category scope ...
}
```

## Hiding internal threads

If a library opens its own `thread {}` block to run a side-conversation (a summarizer, a classifier, a code analyzer), you usually don't want it showing up in user-facing `listThreads()` output:

```ts
thread(hidden: true) {
  // Library-internal scaffolding the user shouldn't see.
}
```

The `std::thread` module's own `summarize()` helper uses exactly this pattern when it generates the lazy thread summaries.

## Cross-node persistence

Threads created in one node remain queryable from another. Internally a single `ThreadStore` is created once per `runNode` call and reused across every node hop, so threads survive node transitions for free. Subthreads are normal entries in the same registry with `parentId` set. On interrupt resume the store is rebuilt from the checkpoint, so an in-flight `thread {}` block resumes mid-flight via the existing substep mechanism. See `docs/dev/threads.md` for the underlying mechanism.

## What's out of scope for v1

A few things we deliberately left out:

- **Auto-context injection by label.** Users can replicate it in three lines with `listThreads()` plus a filter.
- **Cross-run persistence.** The registry is run-scoped — restarting the agent starts fresh.
- **Filtering / search in `listThreads()`.** Returns everything; the LLM filters.
- **Eager summarization at close.** `thread(summarize: true)` is parsed and forwarded to the `onThreadEnd` hook payload, but the v1 stdlib doesn't act on it yet — summaries are computed lazily on the next `listThreads()` call. Wiring TS-side hooks to call an Agency function cleanly is a follow-up.
- **A router primitive.** User-space already expresses categorize-and-route in three lines (see the example above); adding a `route { ... }` builtin would be redundant.
