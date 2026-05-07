# Execution Traces

Execution traces capture a complete checkpoint at every step of an Agency program's execution, streamed to a `.agencytrace` JSONL file. Unlike static observability (audit logs, callbacks), traces contain live program state that can be loaded back into the debugger for replay.

## Usage

```bash
# Trace to default file (<input>.agencytrace)
agency run --trace my-agent.agency

# Trace to custom file
agency run --trace my-trace.agencytrace my-agent.agency
```

Or in `agency.json`:
```json
{
  "trace": true,
  "traceFile": "output.agencytrace"
}
```

If `trace` is true but `traceFile` is omitted, the builder derives a default from the module ID (e.g., `my-agent.agencytrace`).

## How it works

### Writing

When `config.trace` is true, the builder does two things:

1. **Inserts `debugStep()` calls** at every step boundary (same instrumentation as the debugger — the condition expands from `config.debugger` to `config.debugger || config.trace`).

2. **Injects `TraceWriter` setup** into the generated code via the `traceSetup.mustache` template. This creates a `TraceWriter`, attaches it to `__globalCtx.traceWriter`, and registers a `process.on("exit")` handler to write the footer and close the file.

At runtime, `debugStep()` checks if `ctx.traceWriter` is set. If so, it creates a `Checkpoint` via `Checkpoint.fromContext()` and passes it to the writer. This is independent of the debugger — both can be active simultaneously.

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

- **Header** (first line): `{ type: "header", version, program, timestamp, config }`
- **Chunk**: `{ type: "chunk", hash, data }` — content-addressable data block
- **Manifest**: `{ type: "manifest", ...casProcessedCheckpoint }` — one per checkpoint, references chunks by hash. Type is `{ type: "manifest" } & CASResult<CheckpointJSON, typeof CHECKPOINT_SCHEMA>`.
- **Footer** (last line): `{ type: "footer", checkpointCount, chunkCount, timestamp }` — its absence indicates a crash.

Chunks always appear before the manifests that reference them (streaming protocol).

### Reading

`TraceReader.fromFile()` scans the file in a single forward pass, builds a chunk index, reconstructs all checkpoints via `ContentAddressableStore.reconstruct()`, and exposes them as `Checkpoint[]`. The API mirrors the writer:

```typescript
// Write
const writer = new TraceWriter(filePath, "my-agent.agency");
writer.writeCheckpoint(checkpoint);
writer.close();

// Read
const reader = TraceReader.fromFile(filePath);
reader.header       // TraceHeader
reader.footer       // TraceFooter | null
reader.checkpoints  // Checkpoint[]
```

## Key files

| File | Purpose |
|------|---------|
| `lib/runtime/trace/contentAddressableStore.ts` | Generic CAS with `CASResult` type, `process()`, `reconstruct()` |
| `lib/runtime/trace/canonicalize.ts` | Deterministic JSON serialization (sorted keys) for stable hashes |
| `lib/runtime/trace/types.ts` | `CheckpointJSON`, `CHECKPOINT_SCHEMA`, `TraceManifest`, `TraceHeader`, etc. |
| `lib/runtime/trace/traceWriter.ts` | `TraceWriter` — streaming JSONL writer |
| `lib/runtime/trace/traceReader.ts` | `TraceReader` — reads file, reconstructs `Checkpoint[]` |
| `lib/runtime/debugger.ts` | `debugStep()` — trace write path (lines 23-28) |
| `lib/runtime/state/sourceLocation.ts` | `SourceLocation` type used by checkpoints and traces |
| `lib/templates/backends/typescriptGenerator/imports.mustache` | Includes trace setup in generated imports |

## Relationship to the debugger

The trace reuses the debugger's step instrumentation (`debugStep()`) but is otherwise independent. When only tracing is active (no debugger), `debugStep` writes to the trace and returns — no pause, no interrupts. When both are active, both code paths execute.

The `traceWriter` is shared across execution contexts (set on `RuntimeContext`, copied in `createExecutionContext()`). It respects `_skipNextCheckpoint` to avoid duplicate checkpoints during rewind.

## Relationship to checkpoints

`TraceManifest` is derived from `CheckpointJSON` via the `CASResult` type:

```typescript
type CheckpointJSON = ReturnType<Checkpoint["toJSON"]>;
type TraceManifest = { type: "manifest" } & CASResult<CheckpointJSON, typeof CHECKPOINT_SCHEMA>;
```

If `Checkpoint` gains a field, the manifest type updates automatically. The `Checkpoint` class implements `SourceLocation` and has a `fromContext()` static method shared between `CheckpointStore.create()` and the trace write path.

## Future work

- **Debugger replay**: Load a trace into the debugger and step through recorded checkpoints without re-executing.
- **Statelog integration**: Stream checkpoints to statelog for web-based trace replay.
- **Bundle format**: `.agencybundle` archive containing trace + source + compiled code for portable replay.
- **Thread sub-chunks**: Extend the schema to extract large message threads as separate chunks for better deduplication.
