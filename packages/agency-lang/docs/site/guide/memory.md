---
name: Memory
description: How to give an agent long-term memory — remembering facts across runs, recalling them on demand, auto-injecting them into LLM calls, and approving what gets written.
---

*This feature is in active development. This information was written by an LLM and may be out of date.*

# Memory

Memory lets your agent remember things between runs — a user's preferences, past
decisions, who's who — and pull them back up when they're relevant.

```ts
setMemoryId("alice")
remember("Alice prefers concise, technical answers.") with approve
const reply = llm("Summarize today's standup", { memory: true })
```

That's the whole loop: you **remember** facts, and `llm({ memory: true })`
**recalls** the relevant ones for you. The `with approve` on that `remember`
line is doing something important — we'll get to it under
[Approval](#approval-memory-asks-before-it-acts).

## When should I use memory?

- Your agent talks to the same user (or users) across sessions and should
  recall their preferences, history, and prior decisions.
- You want long-term context available to the LLM without paying to keep it in
  the message history on every call.

If you only need to remember a few values for a single run, use a normal
variable. Memory is for durable, structured knowledge that outlives the run.

## Turning it on

Memory is opt-in. Add a `memory` block to your `agency.json` with a directory
to store things in:

```json
{
  "memory": {
    "dir": ".agency-memory"
  }
}
```

That one field is enough. Until you add it, every `std::memory` function is a
no-op (no error, no warning) — so the same agency code runs with or without
memory configured. Everything else is optional; see
[Full configuration](#full-configuration) for the rest.

## Remembering and recalling

Import what you need from `std::memory`:

```ts
import { setMemoryId, remember, recall, forget } from "std::memory"
```

### `remember(content)`

Give `remember` plain text and it extracts the facts for you — the people,
the details about them, and how they relate:

```ts
remember("Alice is a senior engineer who prefers TypeScript. She mentors Bob.") with approve
```

Behind the scenes an LLM turns that sentence into structured facts, running in
its own [thread](/guide/message-threads) so it never shows up in your agent's main
conversation.

### `recall(query)`

Ask for what you need in plain language. `recall` returns the matching facts as
a formatted string:

```ts
const context = recall("alice's preferences") with approve
// Alice (person):
//   - Senior engineer
//   - Prefers TypeScript
```

It returns up to 10 entities, ranked by relevance, or an empty string if
nothing matches (or memory is off).

### `forget(query)`

`forget` removes matching facts — but softly. Nothing is erased; the facts are
just marked expired, so they drop out of `recall` while the history stays on
disk:

```ts
forget("alice's old job title") with approve
```

## Automatic recall with `llm({ memory: true })`

The easiest way to use memory is to not call `recall` yourself at all. Pass
`memory: true` to any `llm()` call and Agency recalls facts relevant to your
prompt and slips them in as a system message before the model sees it:

```ts
remember("Alice prefers concise technical summaries.") with approve
const reply = llm("Summarize today's standup notes: ...", { memory: true })
```

The model sees a system message starting with `Relevant context from memory:`
followed by the matches. If nothing matches, nothing is injected. Because the
flag is per-call, you only pay the recall cost on the calls that actually need
long-term context.

## Approval: memory asks before it acts

You might be wondering — does `remember()` really pause and ask every time? By
default, **yes**. Writing to or reading from memory is a real action, so
`remember`, `recall`, `forget`, `enableMemory`, and `disableMemory` each raise
an [interrupt](/guide/interrupts) for approval before they run. Without a
response, the run pauses.

That's why every example above ends in `with approve` — the shorthand that
auto-approves the interrupt:

```ts
remember("Alice mentors Bob.") with approve
```

When you want a human in the loop instead, handle it yourself:

```ts
handle {
  remember(userMessage)
} with (data) {
  const ok = input(`Save this to memory? (yes/no) `)
  if (ok == "yes") { return approve() }
  return reject()
}
```

See [Interrupts](/guide/interrupts) for every way to approve — `with approve`,
`handle` blocks, `.preapprove()`, and policies.

**One important exception:** the *automatic* path never interrupts.
`llm({ memory: true })` injection and [background extraction](#working-in-the-background)
recall and write on their own, without asking. Only the memory functions you
call directly in your code raise approval interrupts. (`recall` is also `safe`,
so the LLM may call it as a tool — pair it with `.preapprove()` if you don't
want each tool-driven recall to prompt.)

## Scopes: keeping users separate

A **scope** is an independent slice of memory. Set one with `setMemoryId` and
every `remember` / `recall` / `forget` after it reads and writes that slice
only:

```ts
node main() {
  setMemoryId("alice")
  // everything below is scoped to Alice
}
```

Scopes are just strings — use whatever uniquely identifies the slice: a user,
a channel, a workspace, even a time window (`"alice-2026-Q2"`). If you never
call `setMemoryId`, the scope is `"default"`. You can read the current one back
with `getMemoryId()`.

The active scope is part of the run's state, so it survives interrupt/resume —
an agent paused mid-run comes back to the same scope it left.

One scope has at most one writer at a time across processes. Concurrent writes
to the same scope aren't coordinated for you; if you need that, serialize
access at the application layer (one queue per scope is the simplest pattern).

## Configuring memory from code

Sometimes `agency.json` isn't enough — a multi-tenant agent wants a different
store per user, or a library helper wants a scratch store without disturbing
the caller. Three functions let you configure memory inline:

```ts
import { enableMemory, disableMemory, memory } from "std::memory"
```

### `enableMemory(config)`

Turn memory on (or switch stores) for the current branch:

```ts
enableMemory({ dir: "./mem/alice" }) with approve
remember("Alice's favourite colour is blue") with approve
```

Call it again with the same `dir` and nothing happens — so it's safe to enable
in `main()` even if a `static const _ = enableMemory({...})` already ran. Call
it with a *different* `dir` and you switch stores. The `dir` is resolved against
your working directory (the same as `agency.json`'s `memory.dir`, and
deliberately *not* the module dir like `read`/`write`), and it's created if it
doesn't exist.

### `disableMemory()`

Turn the most recent config back off. Be careful: this pops whatever is on top,
including the one from `agency.json`. Library authors shouldn't call it casually
— you'd shadow the caller's memory. Prefer the block form below, which cleans up
after itself.

### `memory(config) as { ... }`

The block form is the safe one. It turns on the config for the duration of the
block and restores whatever was there before when the block ends — even if the
block throws or interrupts:

```ts
const result = memory({ dir: "./mem/alice" }) as {
  remember("Alice's favourite colour is blue") with approve
  recall("alice") with approve
}
```

It returns a [`Result`](/guide/error-handling) — success holds the block's
value, failure holds an error raised inside it.

### How configs stack

Memory configs stack like a pile of plates. Your `agency.json` config sits on
the bottom; each `enableMemory(...)` or `memory({...}) as { ... }` sets a new
plate on top, and the top plate is the one in effect. That's why code always
wins over `agency.json`, and why a block cleanly restores what was underneath
when it ends.

Scope (`memoryId`) is separate from this stack. Switching stores doesn't reset
the scope — a helper that opens a side store won't clobber the caller's
`setMemoryId`. If you want a fresh scope with a new store, call `setMemoryId`
yourself inside the block.

Not sure whether memory is on right now? `isMemoryActive()` returns `true` when
a real store is reachable on the current branch:

```ts
if (isMemoryActive()) {
  remember(note) with approve
}
```

### Per-fork memory

Each [fork](/guide/concurrency) branch gets its own copy of this stack, so a
config set in one branch never leaks into its siblings:

```ts
const dirs = ["./mem/a", "./mem/b"]
fork(dirs) as dir {
  memory({ dir: dir }) as {
    remember("a fact scoped to this branch") with approve
  }
}
```

Two branches pointing at the same physical `dir` share the underlying files on
disk, but each keeps its own view — so they don't step on each other.

## Working in the background

Two things happen on their own once memory is on. Neither asks for approval.

**Automatic extraction.** Every few LLM turns (5 by default, set with
`autoExtract.interval`), memory reads the recent conversation and pulls out
facts for you — no explicit `remember` needed. An agent that just *chats* still
builds up memory as it goes.

**Compaction.** As the stored conversation grows, memory summarizes the older
messages so context stays bounded and recall stays fast. `compaction.trigger`
chooses what to measure — `"messages"` (a raw count) or `"token"` (estimated
tokens) — and `compaction.threshold` is the point at which it kicks in.

## How it works

Under the hood, memory is a **knowledge graph**. Facts are stored as
*entities* (a person, a project, a thing), each carrying *observations* (facts
about it) and *relations* (links to other entities). Extraction turns your text
into that graph; recall turns a query back into a ranked list of facts. Both
steps use the LLM, in isolated threads, so they never touch your agent's main
conversation — though their cost and tokens still flow through the run's
accounting, so you'll see them in `onLLMCallEnd` callbacks and traces.

`recall` blends three strategies and returns the top 10:

1. **Name match** — substring match on entity names.
2. **Semantic search** — vector similarity over observations.
3. **LLM re-ranking** — the model picks the most relevant of what's left.

Semantic search needs a provider with an embedding model (OpenAI, Google,
Ollama). On providers without one (Anthropic, llama.cpp, custom), that tier is
skipped and recall leans on the other two — worth knowing if your matches feel
thinner than expected.

### Storage layout

Each scope is a directory of plain JSON under your configured `dir`:

```
.agency-memory/
├── alice/
│   ├── graph.json       # entities, their observations, and relations
│   ├── embeddings.json  # vectors for semantic search
│   └── summary.json     # compacted older conversation, if any
└── bob/
    └── …
```

It's plain JSON on purpose — easy to inspect, diff, and back up. Delete a
scope by removing its directory; the files are recreated on the next write.

## Full configuration

Every field beyond `dir` is optional:

```json
{
  "memory": {
    "dir": ".agency-memory",
    "model": "gpt-4o-mini",
    "autoExtract": { "interval": 5 },
    "compaction": { "trigger": "messages", "threshold": 50 },
    "embeddings": { "model": "text-embedding-3-small" }
  }
}
```

| Field | Default | What it does |
|---|---|---|
| `dir` | *(required)* | Directory for per-scope JSON files. |
| `model` | `agency.json` default, else `gpt-4o-mini` | Model for memory's own LLM work: extraction, recall re-ranking, forget, and compaction. |
| `autoExtract.interval` | `5` | LLM turns between automatic extraction passes. |
| `compaction.trigger` | `"messages"` | What the threshold counts — `"messages"` or `"token"`. |
| `compaction.threshold` | — | Compact once the conversation grows past this. |
| `embeddings.model` | derived from provider | Embedding model for semantic search. Omit to derive it from your LLM provider; some providers have none (see above). |
| `embeddings.provider` | derived | Override the embedding provider for `embeddings.model`. |

## Concurrent agent runs

Memory is per-run, not global. Two runs sharing one Node.js process each keep
their own view, so `setMemoryId("A")` in one agent doesn't change what `recall`
sees in another running alongside it — even when both point at the same scope on
disk. That makes memory safe to use inside long-lived hosts: web servers, CLI
daemons, agent platforms.

## A complete example

```ts
import { setMemoryId, remember, recall } from "std::memory"

node onboarding() {
  setMemoryId("alice")
  const intro = input("Tell me a bit about yourself: ")
  remember(intro) with approve
  goto chat()
}

node chat() {
  setMemoryId("alice")
  while (true) {
    const message = input("you: ")
    const reply = llm(message, { memory: true })
    print("agent: " + reply)
  }
}
```

The first run through `onboarding` extracts facts from the introduction. Every
later `chat` turn injects the relevant ones automatically — no manual recall, no
prompt-building. And with background extraction on, the conversation keeps
teaching memory as it goes.

## Gotchas

- **Memory must be enabled first.** Without the `memory` block in `agency.json`
  (or an `enableMemory` call), `remember`/`forget` do nothing and `recall`
  returns `""`. This is intentional, so the same code runs either way.
- **Direct calls ask for approval; automatic recall doesn't.** `remember`,
  `recall`, `forget`, `enableMemory`, and `disableMemory` raise approval
  interrupts when you call them. `llm({ memory: true })` and background
  extraction don't. See [Approval](#approval-memory-asks-before-it-acts).
- **Set the scope in every entry node.** If you `setMemoryId` in one node but
  not another, the second falls back to the last id set (or `"default"`). Set it
  at the top of each entry node to be safe.
- **`forget` is a soft delete.** Facts are marked expired, not erased. To hard
  delete, remove the scope's JSON files directly.
- **Tests need a deterministic LLM client.** End-to-end memory tests in
  `tests/agency/memory/` set `AGENCY_USE_TEST_LLM_PROVIDER=1` so extraction and
  recall don't hit real providers. See that directory's `README.md`.

## Related

- [`std::memory` module reference](/stdlib/memory) — generated signatures and
  parameter types.
- [Interrupts](/guide/interrupts) — every way to approve or reject memory's
  approval prompts.
- [LLMs](/guide/llm) — full reference for `llm()` options, including
  `memory: true`.
- [Concurrency](/guide/concurrency) — how multiple runs share state.
