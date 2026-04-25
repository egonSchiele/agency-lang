# Execution Trace Design

## Overview

Agency gains the ability to export a complete execution trace — one checkpoint per step — as a streamable file. This extends the debugger's existing checkpoint infrastructure to work during normal (non-debug) execution, giving users full execution state replay, not just static observability data.

The trace uses a content-addressable storage format to deduplicate repeated state, making it practical for programs with hundreds to thousands of steps.

## Motivation

Agency already supports observability via lifecycle callbacks and audit logging. But these are static records — they show what happened, not the live state at each point. With execution traces, users get:

- A complete record of program state at every step
- The ability to load traces into the debugger and step through them
- Random-access inspection of any checkpoint (for dashboards, anomaly detection, etc.)
- The ability to re-execute from any point in a recorded trace

## Design Decisions

- **Every step is captured.** No sampling or filtering. If tracing is on, you get everything.
- **Streaming writes.** Checkpoints are appended to the trace file as they're created, not buffered in memory. This keeps memory usage low and provides crash resilience.
- **Content-addressable deduplication.** Checkpoint sub-structures (stack frames, globals, threads) are stored in a content-addressable chunk store. Identical data is written once and referenced by hash. This provides excellent compression because most state is unchanged between consecutive steps.
- **File-based output first.** Traces go to a local file. Statelog integration is a natural follow-up but not part of this design.
- **Source code is not bundled.** The trace contains only state data. A bundle format (trace + source + compiled code) is a follow-up feature.

## Trace File Format

The trace is a single `.agencytrace` file in JSONL format (one JSON object per line). There are three line types:

### Header

Always the first line. Contains metadata about the trace.

```json
{
  "type": "header",
  "version": 1,
  "program": "my-agent.agency",
  "timestamp": "2026-04-01T12:00:00Z",
  "config": { "hashAlgorithm": "sha256" }
}
```

### Chunk

A content-addressable data block. The hash is SHA-256 truncated to the first 16 hex characters (64 bits). This provides a collision probability of ~1 in 10^18, which is more than sufficient for local trace files.

```json
{
  "type": "chunk",
  "hash": "a1b2c3d4e5f60718",
  "data": { "args": {}, "locals": { "x": 5 }, "threads": null, "step": 3 }
}
```

### Manifest

One per checkpoint. References chunks by hash rather than inlining the data.

```json
{
  "type": "manifest",
  "id": 42,
  "nodeId": "start",
  "moduleId": "main.agency",
  "scopeName": "myNode",
  "stepPath": "3",
  "label": null,
  "pinned": false,
  "stack": {
    "stack": ["a1b2c3d4e5f60718", "d4e5f6a1b2c3d4e5"],
    "mode": "serialize",
    "nodesTraversed": ["start"],
    "other": {},
    "deserializeStackLength": 0
  },
  "globals": {
    "store": { "main.agency": "08a9b1c2d3e4f506" },
    "initializedModules": ["main.agency"]
  }
}
```

The manifest is the CAS-processed checkpoint — it has the exact same shape as the checkpoint's JSON, but with hashed values replaced by hash strings. The `TraceManifest` type is derived automatically: `{ type: "manifest" } & CASResult<CheckpointJSON, typeof CHECKPOINT_SCHEMA>`. The `CASResult` recursive mapped type walks the checkpoint type and schema in parallel, replacing `StateJSON[]` with `string[]` and `Record<string, Record<string, any>>` with `Record<string, string>` at the paths specified by the schema. All other fields pass through unchanged.

### Footer

Written as the last line when the trace completes successfully. Its absence indicates a crash or incomplete trace.

```json
{
  "type": "footer",
  "checkpointCount": 500,
  "chunkCount": 142,
  "timestamp": "2026-04-01T12:05:00Z"
}
```

### Streaming Protocol

Before writing a manifest, the writer emits any chunks whose hashes haven't appeared yet in the file. This ensures the file is self-contained and readable in a single forward pass — by the time a reader encounters a hash reference, the chunk data has already appeared.

## SourceLocation Type

The pattern `{ nodeId, moduleId, scopeName, stepPath }` appears throughout the codebase (in `Checkpoint`, `CheckpointStore`, `DebuggerState`, `debugStep`, the builder's `checkpointOpts()`) but was never grouped into a named type. This design introduces a `SourceLocation` type to make the relationship between these fields explicit. It is used in the `Checkpoint` class, trace manifest, and all method signatures that accept location parameters.

## ContentAddressableStore

The content-addressable chunking logic is implemented as a generic `ContentAddressableStore` class that has no knowledge of traces, checkpoints, or Agency. It operates on plain objects using a declarative schema that describes which keys should be hashed.

The schema mirrors the shape of the object:

```typescript
const schema = {
  stack: { stack: true },   // hash each frame in the stack array
  globals: { store: true },  // hash each module's globals
};
```

The store's `process()` method walks the object and schema in parallel. At each level:
- A specific key in the schema maps to a nested object → recurse into the data at that key
- A specific key maps to `true` → hash each element/value of the data at that key (array elements become hash strings, object values become hash strings, primitives become a hash string)

The store deduplicates: identical data produces the same hash and is stored only once. The `reconstruct()` method does the inverse — walks the same schema paths and replaces hashes with the stored data.

This separation means the `TraceWriter` is a thin layer that calls `store.process(checkpoint, schema)` and writes the results, while the `TraceReader` calls `store.reconstruct(manifest, schema)` to rebuild checkpoints.

## Chunking Strategy

The schema above produces the following chunking at the checkpoint level:

### Frame Chunks

Each `StateJSON` in the stack array becomes its own chunk (matched by `stack: { stack: true }`). A frame contains `{ args, locals, threads, step, branches? }`. Lower frames on the call stack are stable while execution is inside a callee, so they get deduplicated across many checkpoints. The top frame changes frequently (step counter, locals) but lower frames don't.

### Globals Chunks

Each module's globals (`Record<string, any>`) becomes its own chunk (matched by `globals: { store: true }`). Globals are set during initialization and rarely change after, so they deduplicate heavily. The `initializedModules` array from `GlobalStoreJSON` is stored directly in the manifest (not chunked) since it's a small list of module IDs.

### Manifest Fields (Not Chunked)

The checkpoint metadata (`nodeId`, `moduleId`, `scopeName`, `stepPath`, `label`, `pinned`) and stack metadata (`mode`, `nodesTraversed`, `other`, `deserializeStackLength`, `initializedModules`) stay directly in the manifest. They're small and unique per checkpoint — chunking them would add overhead for no dedup benefit.

### Example

A checkpoint with a 3-deep call stack and 2 modules produces:
- 3 frame chunks
- 2 globals chunks
- 1 manifest

Across 500 steps where globals don't change, naive storage would duplicate the globals in every checkpoint. With content-addressable storage, unchanged globals are stored once and referenced 500 times.

### Future: Thread Sub-Chunks

If traces become too large due to accumulated message threads, the schema can be extended to extract threads as sub-chunks by adding a deeper level: `stack: { stack: { threads: true } }` alongside hashing the frames themselves. This would require extending the schema to support multi-step operations (hash sub-keys, then hash the container). This is deferred until needed.

## Hashing

- **Algorithm:** SHA-256, truncated to the first 16 hex characters (64 bits)
- **Implementation:** Node's built-in `crypto.createHash('sha256')`
- **Deterministic input:** A `canonicalize()` function recursively sorts object keys before stringifying, ensuring identical data always produces the same hash regardless of property insertion order

## Integration Points

### Activating Tracing

Three entry points, all funneling into the same `TraceWriter`:

1. **CLI flag:** `agency run --trace foo.agency` writes to `foo.agencytrace`. `agency run --trace my-trace.agencytrace foo.agency` specifies a custom path. The `--trace` option takes an optional argument. When the argument ends in `.agencytrace`, it's treated as the trace file path; otherwise, it's treated as the program file (i.e., `--trace` was used as a boolean flag).
2. **agency.json config:** `"trace": true` uses the default filename. `"traceFile": "output.agencytrace"` overrides the path. CLI flags take precedence.
3. **Programmatic API:** A `traceFile` option on the runtime config.

### Builder Changes

The builder currently inserts `debugStep` calls only when `config.debugger === true` (the `insertDebugSteps` method). This condition expands to `config.debugger || config.trace`. The function name stays `debugStep`.

**Performance note:** Enabling tracing causes the builder to insert `debugStep` calls before every step-triggering statement, along with the `if (__step <= N)` step guards. This is the same instrumentation used by the debugger. There is per-step overhead from the extra function call and guard check. This is acceptable because tracing is opt-in — users who don't enable it pay no cost, and users who do are explicitly trading performance for observability.

### debugStep Changes

`debugStep` in `lib/runtime/debugger.ts` gains a trace code path: if `ctx.traceWriter` exists, write a checkpoint to the trace via the writer. This happens alongside the existing debugger logic — both can be active simultaneously.

**Behavioral separation:** When only tracing is active (no debugger), `debugStep` skips all pause/interrupt logic because `ctx.debuggerState` is null — the function returns early after the trace write. The debugger's interrupt-based pause mechanism is never triggered. When both are active, both code paths execute: the trace gets written and the debugger pause logic runs as normal.

**`_skipNextCheckpoint` interaction:** `RuntimeContext` has a `_skipNextCheckpoint` flag used during rewind to avoid creating a spurious checkpoint on the first step after restoring state. The trace writer must respect this flag — when it's set, `debugStep` skips writing to the trace as well. This prevents the trace from containing duplicate checkpoints that weren't part of the actual execution flow.

### RuntimeContext Changes

`RuntimeContext` gets a `traceWriter: TraceWriter | null` field, similar to the existing `debuggerState` field. The `traceWriter` is shared across execution contexts (not isolated per call) since all calls write to the same trace file. `createExecutionContext` copies the `traceWriter` reference to the new context, and `cleanup()` nulls it out alongside other fields.

## Reading and Replaying Traces

### Loading a Trace in the Debugger

`agency debug --trace foo.agencytrace source.agency` loads the trace and presents it in the debugger UI. Instead of live execution, stepping forward/backward loads the next/previous checkpoint from the trace. Rewind is instant and unlimited since all checkpoints are in the file.

Re-execution from a checkpoint is possible: the user picks a checkpoint, the debugger deserializes it into a `RuntimeContext`, and resumes live execution from that point. This requires the compiled source to be available.

### Loading a Single Checkpoint

`agency debug --checkpoint foo.json source.agency` loads a single checkpoint into the debugger and starts live debugging from that point. This exposes existing checkpoint restore functionality as a CLI entry point.

### Programmatic Access

`TraceReader` is the public API for reading traces. On initialization, `fromFile` performs a single forward scan of the JSONL file, building an in-memory chunk index (`Record<string, any>`) and manifest list. Manifests are small (just hash references), so holding all of them in memory is fine. The chunk data is also held in memory since it's already deduplicated. For the expected scale (hundreds to thousands of steps), this is practical.

Users can:
- List all checkpoints (manifests are lightweight)
- Load any checkpoint by ID (reconstruct from manifest + chunk lookups — effectively O(1))
- Inspect state at any point: stack frames, locals, globals, threads

## File Organization

### New Files

```
lib/runtime/state/
└── sourceLocation.ts            — SourceLocation type (extracted from existing code)

lib/runtime/trace/
├── contentAddressableStore.ts   — Generic content-addressable store with recursive schema
├── traceWriter.ts               — TraceWriter class, uses ContentAddressableStore + JSONL streaming
├── traceReader.ts               — TraceReader class, uses ContentAddressableStore for reconstruction
├── canonicalize.ts              — deterministic JSON serialization for stable hashes
└── types.ts                     — TraceHeader, TraceChunk, TraceManifest, TraceLine types

lib/templates/backends/typescriptGenerator/
└── traceSetup.mustache          — Template for trace writer setup in generated code
```

### Modified Files

- `lib/runtime/debugger.ts` — `debugStep` gains trace code path
- `lib/runtime/state/context.ts` — `RuntimeContext` gets `traceWriter` field
- `lib/backends/typescriptBuilder.ts` — Condition for inserting `debugStep` expands to include `config.trace`
- `lib/config.ts` — Add `trace` and `traceFile` config options
- `scripts/agency.ts` — Add `--trace` flag to `run` command, `--trace` and `--checkpoint` flags to `debug` command
- `lib/cli/debug.ts` — Handle trace replay mode and checkpoint loading

### Design Principle

All trace infrastructure lives in the runtime. No new templates or generated code patterns. The only builder change is the condition for inserting `debugStep` calls.

## Testing Strategy

### Unit Tests

- `lib/runtime/trace/canonicalize.test.ts` — Deterministic serialization: key ordering, nested objects, arrays, edge cases (null, undefined, dates, circular reference detection)
- `lib/runtime/trace/traceWriter.test.ts` — Chunk deduplication (same data produces same hash, written once), manifest structure, streaming write order (chunks before manifests), thread sub-chunk extraction threshold
- `lib/runtime/trace/traceReader.test.ts` — Roundtrip: write a trace, read it back, reconstruct checkpoints and verify they match originals. Partial file reading (simulating crash mid-write). Manifest listing, random access by ID

### Integration Tests (in tests/agency/)

- A small `.agency` program runs with `trace: true`, producing a trace file. Verify the trace exists, has the correct number of manifests, and reconstructed checkpoints have valid state.
- Same program run twice produces traces with identical chunk hashes for identical state (verifying deterministic canonicalization).

## Future Work

- **Statelog integration:** Send checkpoints to statelog alongside existing observability data, enabling trace replay in the web UI.
- **Bundle format:** A `.agencybundle` archive (zip) containing the trace, original `.agency` source files, and compiled `.mjs` files. Enables sharing self-contained replay packages: `agency debug my-agent.agencybundle`.
- **Trace filtering/sampling:** For very large traces, post-processing tools to extract subsets (e.g., only checkpoints at node transitions, only checkpoints where a specific variable changed).
