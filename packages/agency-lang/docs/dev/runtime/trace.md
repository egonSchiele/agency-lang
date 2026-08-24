# Execution Traces

Execution traces capture a complete checkpoint at every step of an Agency program's execution, streamed to a `.agencytrace` JSONL file. Unlike static observability (audit logs, callbacks), traces contain live program state that can be loaded back into the debugger for replay.

## Usage

```bash
# Trace to the default file, <input>.trace
agency run --trace my-agent.agency

# Trace to a custom file
agency run --trace-file my-trace.agencytrace my-agent.agency

# Same thing under its own command
agency trace run my-agent.agency -o my-trace.trace
```

Two flags rather than one optional-valued `--trace [file]`, because an optional-valued option swallows the next word and `agency run --trace greet.agency` would read the filename as the trace path.

Or in `agency.json`:
```json
{
  "trace": true,
  "traceFile": "output.agencytrace"
}
```

`applyCliFlags` in `lib/config.ts` turns `--trace` into `traceFile: <input>.trace`. With no input file it falls back to `traceDir: "."`.

`traceDir` is the safer setting for anything that runs concurrently. `resolveTraceFilePath` gives each run its own `${traceDir}/${runId}.agencytrace`, while a fixed `traceFile` makes every run of the module write to one path. If both are set, `traceFile` wins.

## How it works

### Writing

The builder emits `debugStep()` calls at every step boundary. That instrumentation is not conditional on tracing. It is on by default and `instrument: false` in `agency.json` turns it off to remove the per-step overhead. `insertDebugSteps` in `lib/backends/typescriptBuilder.ts` does the insertion.

The builder also emits a `traceConfig` field on the generated `RuntimeContext`, carrying `program`, `traceDir`, and `traceFile` from the compile-time config. Generated code exports `__setTraceFile`, so a host can repoint the trace file before the next `runNode` call.

`createExecutionContext` in `lib/runtime/state/context.ts` builds the writer for the run with `TraceWriter.create({ runId, traceConfig })`. That returns `null` when no sink is configured, which is how tracing stays off.

At runtime, `debugStep()` builds a `Checkpoint` with `Checkpoint.fromContext()` and hands it to `ctx.writeCheckpointToTraceWriter()`, which does nothing when there is no writer. This is independent of the debugger, so both can be active at once.

### Content-addressable storage

Checkpoints share a lot of repeated data between steps (unchanged stack frames, globals that rarely change). Naive storage would be prohibitively large. The trace format uses content-addressable deduplication: repeated data is stored once and referenced by hash.

This is implemented via `ContentAddressableStore`, a generic class in `lib/runtime/trace/contentAddressableStore.ts` that has no knowledge of traces or checkpoints. It takes any object and a declarative schema describing which keys to hash:

```typescript
const CHECKPOINT_SCHEMA = {
  stack: { stack: true },   // hash each frame in the stack array
  globals: { store: true },  // hash each module's globals
} as const;
```

When a schema key is `true`, the store hashes each element (for arrays) or each value (for objects) at that key, replacing them with 16-character hex hash strings (SHA-256 truncated to 64 bits). It deduplicates: identical data produces the same hash and is stored once.

The `CASResult<T, S>` type mirrors this at compile time — it walks the object type and schema type in parallel, replacing hashed positions with `string[]` or `Record<string, string>`.

### File format

The trace file is JSONL with four line types:

The trace file is JSONL. `TraceLine` in `lib/runtime/trace/types.ts` is the union of the line types:

- **Header** (first line): `{ type: "header", version, agencyVersion, program, timestamp, config, runId, bundle? }`
- **Static state**: `{ type: "static-state", values }` — module-level globals, written once per run.
- **Source**: `{ type: "source", path, content }` — written by the bundler, never at runtime.
- **Chunk**: `{ type: "chunk", hash, data }` — content-addressable data block
- **Manifest**: `{ type: "manifest", ...casProcessedCheckpoint }` — one per checkpoint, references chunks by hash. Type is `{ type: "manifest" } & CASResult<CheckpointJSON, typeof CHECKPOINT_SCHEMA>`.
- **Footer** (last line): `{ type: "footer", checkpointCount, chunkCount, timestamp }` — its absence indicates a crash.

Chunks always appear before the manifests that reference them (streaming protocol).

A sink is where lines go. `FileSink` appends to a file and `CallbackSink` hands each line to `traceConfig.traceCallback`. Both live in `lib/runtime/trace/sinks.ts`.

One run can produce several writers, one per execution context, because every `respondToInterrupts` builds a new one. `FileSink` therefore appends rather than truncates, and `TraceWriter.create` calls `scanExistingTraceFile` to learn what is already on disk. That scan seeds the new writer's hash set and its header flag, so the file keeps exactly one header and no duplicate chunks.

### Reading

`TraceReader.fromFile()` scans the file in a single forward pass, builds a chunk index, reconstructs all checkpoints via `ContentAddressableStore.reconstruct()`, and exposes them as `Checkpoint[]`. The API mirrors the writer:

```typescript
// Write
const writer = new TraceWriter(runId, "my-agent.agency", [new FileSink(filePath)]);
await writer.writeCheckpoint(checkpoint);
await writer.close();

// Read
const reader = TraceReader.fromFile(filePath);
reader.header       // TraceHeader
reader.checkpoints  // Checkpoint[]
reader.sources      // Record<string, string>, from a bundle
reader.staticState  // Record<string, unknown> | null
```

Prefer `TraceWriter.create({ runId, traceConfig })`, which picks the sinks and does the on-disk scan for you.

## Key files

| File | Purpose |
|------|---------|
| `lib/runtime/trace/contentAddressableStore.ts` | Generic CAS with `CASResult` type, `process()`, `reconstruct()` |
| `lib/runtime/trace/canonicalize.ts` | Deterministic JSON serialization (sorted keys) for stable hashes |
| `lib/runtime/trace/types.ts` | `CheckpointJSON`, `CHECKPOINT_SCHEMA`, `TraceManifest`, `TraceHeader`, etc. |
| `lib/runtime/trace/traceWriter.ts` | `TraceWriter` — streaming JSONL writer |
| `lib/runtime/trace/traceReader.ts` | `TraceReader` — reads file, reconstructs `Checkpoint[]` |
| `lib/runtime/trace/sinks.ts` | `TraceSink`, `FileSink`, `CallbackSink` |
| `lib/runtime/trace/eventLog.ts` | Turns a trace into the JSON event log `agency trace log` prints |
| `lib/runtime/debugger.ts` | `debugStep()` — the trace write path |
| `lib/runtime/state/context.ts` | Owns `traceWriter` / `traceConfig`, builds the writer in `createExecutionContext` |
| `lib/cli/bundle.ts` | `createBundle` / `extractBundle` for `.bundle` files |
| `lib/runtime/state/sourceLocation.ts` | `SourceLocation` type used by checkpoints and traces |
| `lib/templates/backends/typescriptGenerator/imports.mustache` | Emits `__setTraceFile` in the generated module |

## Relationship to the debugger

The trace reuses the debugger's step instrumentation (`debugStep()`) but is otherwise independent. When only tracing is active, `debugStep` writes to the trace and returns, with no pause and no interrupts. When both are active, both code paths run.

Each execution context gets its own `traceWriter`, built in `createExecutionContext()`. The write path respects `_skipNextCheckpoint` to avoid duplicate checkpoints during rewind, and it skips global initialization, which runs outside any graph node and so has no node to checkpoint against.

## Relationship to checkpoints

`TraceManifest` is derived from `CheckpointJSON` via the `CASResult` type:

```typescript
type CheckpointJSON = ReturnType<Checkpoint["toJSON"]>;
type TraceManifest = { type: "manifest" } & CASResult<CheckpointJSON, typeof CHECKPOINT_SCHEMA>;
```

If `Checkpoint` gains a field, the manifest type updates automatically. The `Checkpoint` class implements `SourceLocation` and has a `fromContext()` static method shared between `CheckpointStore.create()` and the trace write path.

## Bundles

`agency bundle <source> <trace>` packs a source file and its trace into one `.bundle` file, and `agency unbundle` unpacks it. The bundle is the same JSONL format with `source` lines added and `bundle: true` on the header. `agency debug <bundle>` extracts it and steps through the recorded run.

## Future work

- **Statelog integration**: Stream checkpoints to statelog for web-based trace replay.
- **Thread sub-chunks**: Extend the schema to extract large message threads as separate chunks for better deduplication.
