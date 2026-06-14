# StatelogParser memory model — decision & follow-up

**Status:** decided (2026-06-13). Records the memory/streaming strategy for
the generalized `StatelogParser` (moved from `lib/eval/` to `lib/statelogParser.ts`
so the logs viewer, eval, and future consumers share one data layer).

## Background

A statelog `.jsonl` file is one JSON event envelope per line. We want a single
parser that acts as the "model" (MVC) for several consumers:

- the `agency logs view` TUI (random-access: expand a node → fetch its payload),
- the eval pipeline (`evalRecord`, `evalInputs/Outputs`, metrics, …),
- future tooling that wants to query a trace like a database.

The query API the parser exposes (`getNodeById`, `llmCalls()`,
`trace(id).llmCalls()`, …) fundamentally needs **random access**, which is in
tension with **streaming** (bounded memory). This doc records how we resolve
that tension.

### How the code handled this before

Both pre-refactor data layers materialize the entire file:

- **Logs viewer** — `lib/cli/logsView.ts` does `fs.readFileSync` → split on `\n`
  → array of every event → `buildForest` builds the full tree. Follow mode
  re-reads the whole accumulated string on every append.
- **Eval `StatelogParser`** — `readAllEventsSync` (`fs.readFileSync` + split),
  then `normalize`/`extract` build more derived structures on top.

A streaming generator (`readEvents` in `lib/eval/parseJsonl.ts`) exists, but it
is only used at the I/O boundary and immediately collected into an array. Its
own comment admits "Most use cases need random access … so we pay the memory
cost." So: **nothing handled large files specially; everything materialized.**

## Options considered

1. **Index + lazy payloads ("database").** Stream the file once to build a
   compact in-memory index (`node id → {type, traceId, spanId, timestamp,
   byteOffset}`); do not hold payloads. `getNodeById`/expand seeks to the byte
   offset and reads just that line on demand. Bounded memory. *Complex:* needs a
   custom byte-offset line scanner (UTF-8/`\r\n`/BOM), seek-on-expand likely
   forces an async API (ripples through sync consumers), a dual cheap/expensive
   query split (the juiciest queries — `llmCalls`, `evalInputs/Outputs` — need
   payloads, not just metadata), a payload cache, and follow-mode offset
   invalidation handling.

2. **Materialize everything.** Keep today's behavior; queries are in-memory
   filters; `getNodeById` is a hashmap lookup. Simplest, fully synchronous,
   lowest migration risk. Memory scales with file size (parsed JS objects run
   ~3–6× the JSON text size).

3. **Materialize now, streaming-ready API** *(chosen).* Implement the
   materialized backend now, but design the interface so it makes **no "it's all
   a resident array" assumption** — `getNodeById` is a lookup, `events()`
   returns an `Iterable` (not `Array`), node ids are stable and offset-friendly.
   A future indexed/lazy backend (Option 1) then drops in **behind the same
   interface with zero consumer churn**.

## Decision: Option 3

The realistic size of a *single* agent trace is small-to-moderate; the genuine
value of this refactor is the query API and the MVC separation, not bounded
memory. Option 1's complexity — especially the async ripple and the fact that
the most useful queries need payloads anyway — is not justified until a concrete
large-file case exists. Option 3 delivers everything the refactor is for at
roughly Option 2's cost, while keeping Option 1 as a clean drop-in upgrade.

### Interface discipline this commits us to

- Queries return through accessors; no consumer reaches into a raw resident array.
- `events()` (and any bulk iteration) is typed as `Iterable`, not `Array`.
- Node ids are **stable and offset-friendly** (e.g. span_id for spans; a
  line-derived id for events) so a future index can key on them without an
  id-scheme migration.
- `getNodeById(id)` is a lookup, not `array[index]`.

## Follow-up: indexed lazy-load backend (deferred Option 1)

Revisit when any of these becomes real:

- a single trace regularly exceeds ~tens of MB on disk, or
- the parser is reused in a long-lived/server/batch context that holds many
  traces resident at once, or
- profiling shows the materialized backend is a memory bottleneck.

When implementing, the known design points / gotchas:

- Custom line scanner that tracks **byte** offsets (not char offsets); handle
  multibyte UTF-8, `\r\n`, and a leading BOM.
- Decide sync vs async for `getNodeById` up front — prefer keeping an open `fd`
  and `fs.readSync` to preserve a synchronous API if consumers still need it.
- Split queries into **metadata-only** (served from the index, cheap) vs
  **payload-bearing** (seek/read, expensive); document which is which.
- Add a small payload cache (LRU) so repeated expands of the same node don't
  re-seek.
- Follow mode: appends extend the index and keep offsets valid; **truncation or
  rotation invalidates offsets** — detect a shrink and rebuild.
