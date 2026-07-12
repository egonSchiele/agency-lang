---
name: Cross-thread context sharing
description: How to inspect, read, and resume other `thread {}` blocks in the same run using `listThreads()`, `getThread()`, and the named arguments on `thread {}`. Includes a categorize-and-route example.
---

# Cross-thread context sharing

Imagine you have several agents. Each one keeps its own message thread in a `thread {}` block, so they never clutter each other's context. Sometimes one agent needs to see what another has been discussing.

Say you have a research agent and a coding agent. You spend a while talking to the research agent about a project. Then you ask the coding agent to build it. How does the coding agent see that earlier conversation? And how do you switch between the two agents without either one losing track of what was said?

You need two things:

1. A way to *see* what other threads have said.
2. A way to *resume* a thread other than the current one.


## `std::thread`

```ts
import { listThreads, getThread, currentThreadId } from "std::thread"
```

## Listing threads

`listThreads()` returns every thread in the run, including the active one. It returns a `Result` (see [error handling](./error-handling)).

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
  isActive: boolean      // true if this is the thread currently being written to
}
```

## Reading a thread's messages

`getThread(id, offset, limit)` returns a slice of a thread's history. It also returns a `Result`:

```ts
const msgs = getThread("t1", 0, 20)
if (isSuccess(msgs)) {
  for (m in msgs.value) {
    print("[" + m.role + "] " + m.content)
  }
}
```

`offset` starts at 0. `limit` defaults to 50. Pass a larger limit to read a whole thread.

## id, label, and session

You can assign a session and a label to a thread. Each thread also gets a unique ID. Here is the difference between the three:

| | Who assigns it | Unique per thread? | What it's for |
|---|---|---|---|
| **id** (`t0`, `t1`, ...) | the runtime | Yes | The exact handle for resuming one specific thread. |
| **session** | you (a name) | Yes | Resume by a name you choose, so you don't have to carry the id around. |
| **label** | you (a tag) | No — many threads can share one | Describe the thread so a human or LLM can find it in `listThreads()`. |

## Resuming a thread by id

You can resume a thread by a session name or by an id:

```ts
thread(continue: "t1") { /* ... */ }
thread(session: "coding") { /* ... */ }
```

### Get the current thread id

Use `currentThreadId()` to grab the id while the thread is active.

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

Note that **you cannot resume a subthread.** A subthread inherits its parent's message history from the moment you create it. Resuming one outside that context would produce confusing message ordering. To continue work that happened inside a subthread, resume the parent thread and open a fresh `subthread {}` block.

## Resuming a thread by name (sessions)

Saving thread ids and looking them up again gets tedious. `thread(session: "name")` handles that for you. The runtime keeps a map from each session name to a thread id. The first time you enter a session, it creates a thread. Every entry after that resumes the same thread.

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

Sessions are always top-level threads. They cannot map to subthreads. To use a subthread inside a session, open the session as usual and put a `subthread {}` block inside it.

## Eager summarization

By default, thread summaries are lazy. The first time `listThreads()` reads a thread, Agency makes one LLM call to summarize it and caches the result. Later calls reuse the cache. The active thread is never summarized, since its conversation is still in flight.

Lazy summaries have one downside. The first `listThreads()` call has to summarize every closed thread that doesn't already have a summary. If several threads have closed, that one call fires several LLM calls at once.

To pay that cost up front instead, mark a thread with `thread(summarize: true)`:

```ts
thread(summarize: true, label: "coding") {
  // ... conversation ...
}
```

When this thread closes, Agency summarizes it right away and caches the result. A later `listThreads()` finds the summary already there and skips the LLM call.

Eager summarization is best-effort. If the summarize call fails, nothing breaks. The thread falls back to the lazy path on the next `listThreads()`.

You can also turn summarization off for a single call. `listThreads(lazySummarize: false)` makes no LLM calls at all. It returns whatever summaries are already cached, and falls back to the thread's label when there is none.

```ts
const all = listThreads(lazySummarize: false)
```

## Hiding internal threads

A library might open its own `thread {}` block to run a side-conversation, such as a summarizer, a classifier, or a code analyzer. Usually you don't want that thread showing up in user-facing `listThreads()` output:

```ts
thread(hidden: true) {
  // Library-internal scaffolding the user shouldn't see.
}
```

The `summarize()` helper in `std::thread` uses this same pattern when it generates the lazy thread summaries.

## Cross-node persistence

A thread created in one node stays queryable from another. Agency creates a single `ThreadStore` once per `runNode` call and reuses it across every node hop, so threads survive node transitions for free.

## Not supported

- **Auto-injecting context by label.** You can do this in three lines with `listThreads()` and a filter.
- **Cross-run persistence.** The registry lasts only for one run. Restarting the agent starts fresh.
- **Filtering or search in `listThreads()`.** It returns everything, and the LLM filters.