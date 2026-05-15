# Memory

Agency ships with a built-in memory layer that lets agents remember facts
across runs, recall them on demand, and inject relevant context into
their LLM calls automatically.

Under the hood, memory is a **knowledge graph** of entities,
observations, and relations, backed by JSON files on disk. The
extraction (turning text into structured facts) and retrieval (turning a
query into a ranked list of facts) steps both use the LLM, but they run
in isolated message threads so they never pollute the agent's main
conversation.

## When should I use memory?

- You are building an agent that talks to the same user (or set of
  users) over multiple sessions and want it to recall preferences,
  history, and prior decisions.
- You want the LLM to have access to long-term context without paying
  to keep it in the main message thread on every call.
- You want extraction to happen automatically: feed in raw text, get
  structured entities back without writing parsing code yourself.

If you only need to remember a few values for a single run, just use a
local variable. If you need durable structured storage across runs,
this is the layer for you.

## Enabling memory

Memory is opt-in. Add a `memory` block to your `agency.json`:

```json
{
  "memory": {
    "dir": ".agency-memory"
  }
}
```

That single field is enough to turn the layer on. Once enabled:

- Every agent run gets its own `MemoryManager` on the runtime context.
- The `std::memory` module's functions become live (without
  configuration they are no-ops).
- `llm({ memory: true })` injects relevant facts before the prompt.

The `dir` is where memory writes its JSON files. One subdirectory per
[memory scope](#memory-scopes-memoryid) is created on first write.

### Full configuration

All other fields are optional with sensible defaults:

```json
{
  "memory": {
    "dir": ".agency-memory",
    "model": "gpt-4o-mini",
    "autoExtract": {
      "interval": 5
    },
    "compaction": {
      "trigger": "messages",
      "threshold": 50
    },
    "embeddings": {
      "model": "text-embedding-3-small"
    }
  }
}
```

| Field | Purpose |
|---|---|
| `dir` | Required. Directory for per-scope JSON files. |
| `model` | Default model for extraction, compaction, and LLM-tier recall. Falls back to the project's default model. |
| `autoExtract.interval` | Number of LLM turns between automatic extraction passes. Default: `5`. |
| `compaction.trigger` | `"messages"` (raw count) or `"token"` (estimated tokens) — what to measure when deciding to compact. |
| `compaction.threshold` | Threshold above which compaction runs. |
| `embeddings.model` | Embedding model name (forwarded to smoltalk's `embed`). |

## The `std::memory` module

Import the functions you need from `std::memory`:

```ts
import { setMemoryId, remember, recall, forget } from "std::memory"
```

### `setMemoryId(id)`

Sets the **memory scope** for the current run. All subsequent
`remember` / `recall` / `forget` calls operate inside this scope. If you
never call this, the scope defaults to `"default"`.

```ts
node main() {
  setMemoryId("user-42")
  // …everything below reads/writes the user-42 scope
}
```

A new scope is materialized on its first write — there's no setup or
migration step.

### `remember(content)`

Extracts structured facts from natural language and stores them in the
knowledge graph. The LLM identifies entities, observations about each
entity, and relations between entities.

```ts
node main() {
  setMemoryId("user-42")
  remember("Alice is a senior engineer who prefers TypeScript and works on the search team. She mentors Bob.")
}
```

The extraction runs in an isolated `thread {}` block, so the agent's
main conversation history is unaffected. Cost and tokens still flow
through the per-run accounting (you'll see them in
`onLLMCallEnd` callbacks and traces).

### `recall(query)`

Returns relevant facts as a formatted string. `recall` is `safe`, so the
LLM can call it as a tool without prompting for confirmation.

```ts
node main() {
  setMemoryId("user-42")
  const ctx = recall("alice's preferences")
  // ctx might be:
  //   Alice (person):
  //     - Senior engineer
  //     - Prefers TypeScript
  //     - Works on the search team
}
```

`recall` combines three retrieval strategies:

1. **Structured lookup** — substring match on entity names.
2. **Embedding similarity** — vector search over observations.
3. **LLM re-ranking** — selects the top entities most relevant to the
   query.

Results are limited to the top 10 entities. Returns the empty string
if memory is not configured or nothing matches.

### `forget(query)`

Soft-deletes facts matching the query. Affected observations get a
`validTo` timestamp instead of being erased, so the audit trail is
preserved. Like `remember`, the LLM call runs in an isolated thread.

```ts
node main() {
  setMemoryId("user-42")
  forget("alice's old job title")
}
```

## Automatic injection: `llm({ memory: true })`

The most ergonomic way to use memory is to let `llm()` handle it for
you. With `memory: true`, the runtime queries memory using the prompt
as the query and prepends a system message with the matching facts:

```ts
node main() {
  setMemoryId("user-42")
  remember("Alice prefers concise technical summaries.")
  const reply = llm("Summarize today's standup notes: ...", { memory: true })
}
```

The LLM sees a system message that begins with `Relevant context from
memory:` followed by the recall results. Nothing is injected if recall
returns empty.

The `memory: true` flag is per-call, so you only pay the recall cost on
LLM calls that actually need long-term context.

## Memory scopes (`memoryId`)

Each scope is an independent slice of memory. Use scopes to isolate:

- **users** — `setMemoryId(currentUser.id)`
- **threads / channels** — `setMemoryId(channel.id)`
- **workspaces / projects** — `setMemoryId(workspace.id)`
- **calendar windows** — `setMemoryId("user-42-2026-Q2")`

Scopes are strings. Pick whatever uniquely identifies the slice.

The active `memoryId` is part of the per-run state stack — it survives
interrupt/resume, so an agent paused mid-run resumes against the same
scope it was using before.

A given scope can have at most one writer at a time across processes.
Concurrent writes to the same scope are not currently coordinated. If
you need shared scopes, serialize access at the application layer (one
queue per scope is the simplest pattern).

## Concurrent agent runs

The memory layer is per-run, not global. Two `runNode` calls that
happen to share the same Node.js process each get their own
`MemoryManager`, so calling `setMemoryId("A")` in one agent does not
affect what `recall` sees in another agent running concurrently — even
if both touch the same `memoryId` directory on disk.

This means it's safe to use Agency's memory layer in long-lived host
processes: web servers, CLI daemons, agent platforms, etc.

## Storage layout

Each scope is a directory under your configured `dir`:

```
.agency-memory/
├── user-42/
│   ├── entities.json
│   ├── relations.json
│   ├── observations.json
│   └── messages.json
└── user-43/
    └── …
```

The format is plain JSON — easy to inspect, diff, and back up. You can
delete a scope by removing its directory; `setMemoryId` will recreate
the files on the next write.

## A complete example

```ts
import { setMemoryId, remember, recall } from "std::memory"

node onboarding() {
  setMemoryId("user-42")
  const intro = input("Tell me a bit about yourself: ")
  remember(intro)
  goto(chat)
}

node chat() {
  setMemoryId("user-42")
  while (true) {
    const message = input("you: ")
    const reply = llm(message, { memory: true })
    print("agent: " + reply)
  }
}
```

The first time the user runs `onboarding`, the system extracts facts
from their introduction. Every subsequent `chat` turn injects the
relevant ones into the LLM call automatically — no manual recall, no
manual prompt construction.

## Gotchas

- **Memory must be enabled in `agency.json`.** Without the `memory`
  block, every `std::memory` function is a no-op (no error, no warning
  — they just return empty/undefined). This is intentional so the same
  agency code can run with or without memory configured.
- **Mixed scopes are easy to forget.** If you call `setMemoryId` in one
  node but not another, the second node falls back to the previously-set
  id (or `"default"`). Set the id once at the top of every entry node
  to be safe.
- **Tests need a deterministic LLM client.** End-to-end tests of memory
  in `tests/agency/memory/` set `AGENCY_USE_TEST_LLM_PROVIDER=1` so
  extraction and recall don't hit real providers. See that
  directory's `README.md` for the full pattern.
- **`forget` is soft-delete.** Observations get a `validTo` timestamp;
  they're filtered out of recall but the audit trail remains on disk.
  If you need a hard delete, remove the scope's JSON files directly.

## Related

- [`std::memory` module reference](/stdlib/memory) — generated function
  signatures and parameter types.
- [LLMs](./llm) — full reference for `llm()` options, including
  `memory: true`.
- [Concurrency](./concurrency) — how multiple agent runs share state.
