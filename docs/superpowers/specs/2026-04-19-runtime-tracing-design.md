# Runtime Tracing Design

## Problem

When users run Agency agents in web apps, they need traces of every execution for debugging later. Currently, tracing requires a compile-time flag (`config.trace = true`) and writes to a single hardcoded file path via synchronous I/O. This doesn't work well for:

- Web servers handling concurrent requests (sync I/O blocks the event loop)
- Users who want to automatically trace every execution without code changes
- Users who want to stream trace data to remote stores (S3, databases) instead of local disk
- Runtime control over whether tracing is on or off

## Design

### 1. Always-on Instrumentation

The builder will emit `debugStep()` / `maybeDebugHook()` calls in compiled output **by default**, regardless of config. Currently, these calls are only inserted when `config.debugger || config.trace` is true at compile time.

When tracing is off at runtime, `maybeDebugHook()` (defined in `lib/runtime/runner.ts`, line 112) hits the guard `if (!this.ctx.debuggerState && !this.ctx.traceWriter) return false` and returns immediately — one function call plus two null checks per step. This is negligible compared to LLM call latency.

A new config option `instrument: false` lets users opt out of instrumentation at compile time if they want to eliminate even that minimal overhead. When `instrument` is false, no `debugStep()` calls are emitted, and tracing/debugging will not work at runtime.

### 2. Three Runtime Activation Mechanisms

#### 2a. Config-level (`agency.json`)

New config options:

```json
{
  "traceDir": "traces/"
}
```

When `traceDir` is set, every execution automatically writes a trace file to that directory. File names are auto-generated as `<timestamp>_<id>.agencytrace`, where timestamp is ISO-8601 with colons/dots replaced by hyphens and id is a 4-character random hex string for collision resistance. Example: `traces/2026-04-19T12-30-45_a8f3.agencytrace`.

The existing `traceFile` config option continues to work for a fixed file path.

#### 2b. Per-call Options

When calling a node from TypeScript, the user can pass trace options:

```typescript
// Auto-trace to default directory (./traces/<timestamp>_<id>.agencytrace)
// When trace: true is passed without traceDir, defaults to ./traces/ relative to the working directory
await main("input", { trace: true });

// Trace to a specific directory with auto-generated filename
await main("input", { traceDir: "my-traces/" });

// Trace to an exact file path
await main("input", { traceFile: "specific.agencytrace" });

// Disable tracing even if config enables it
await main("input", { trace: false });
```

#### 2c. Callback

```typescript
await main("input", {
  callbacks: {
    onTrace(line: TraceLine) {
      // Receives JSONL lines: header, chunks, manifests
      // Stream to S3, database, etc.
    }
  }
});
```

#### Precedence Rules

- Per-call options override config-level settings.
- `trace: false` always wins — disables tracing even if `traceDir` is set in config.
- If neither per-call nor config enables file-based tracing, but `onTrace` is provided, tracing activates (since there is a consumer for the data).
- `onTrace` callback and file-based tracing can coexist — both receive the same data.

### 3. TraceSink Abstraction

Introduce a `TraceSink` interface that decouples trace data production from output:

```typescript
type TraceSink = {
  writeLine(line: TraceLine): Promise<void> | void;
  close?(): Promise<void> | void;
};
```

The optional `close()` method allows sinks to release resources (e.g., file handles) when execution ends. `RuntimeContext` calls `traceWriter.close()` during cleanup, which in turn calls `close()` on each sink.

Two built-in implementations:

- **`FileSink`** — Uses an async write stream instead of the current `fs.writeSync`. This prevents blocking the event loop on web servers. The `close()` method flushes and closes the stream.
- **`CallbackSink`** — Wraps the user's `onTrace` callback. The callback can be sync or async.

`TraceWriter` is refactored to accept one or more sinks:

```typescript
class TraceWriter {
  constructor(program: string, sinks: TraceSink[]) { ... }
}
```

`TraceWriter` retains ownership of the `ContentAddressableStore` and performs CAS processing once per checkpoint. The resulting lines (chunks + manifests) are pushed to all registered sinks. This avoids duplicate CAS work when both file and callback outputs are active.

The header line is emitted to all sinks on construction. Each `writeCheckpoint()` call processes through CAS and pushes chunks then manifests to all sinks.

**Error handling**: If a sink's `writeLine` throws or rejects, the error is swallowed with a warning (similar to how callback errors are handled in `callHook`). A failure in one sink does not prevent writing to other sinks, and does not interrupt agent execution.

### 4. TraceWriter Lifecycle

`TraceWriter` creation moves from compile-time (the current `traceSetup.mustache` template bakes it into the module) to runtime initialization. When an execution starts:

1. Resolve tracing config: merge `agency.json` config with per-call options, applying precedence rules. This resolution happens in `lib/runtime/node.ts` during `setupNode` / execution context creation, where per-call options are already handled.
2. If tracing is enabled, create the appropriate sinks (file, callback, or both).
3. Construct a `TraceWriter` with those sinks and attach it to `RuntimeContext.traceWriter`.
4. If tracing is disabled (`trace: false` or no config), `traceWriter` stays null and `debugStep()` bails out immediately.
5. When execution ends, `TraceWriter.close()` is called (which iterates over sinks and calls `close()` on each). This is triggered at the end of `runNode` in `lib/runtime/node.ts`.

### 5. Cleanup of Dead Code

Remove the following, which are no longer needed:

- `onCheckpoint` from the callbacks/hooks type (`lib/runtime/hooks.ts`) and from `VALID_CALLBACK_NAMES` in `lib/types/function.ts`
- `insertCheckpointSentinels()` method from the preprocessor (`lib/preprocessors/typescriptPreprocessor.ts`, currently commented out)
- `rewindCheckpoint.mustache` template
- `processSentinel` handling for checkpoint sentinels in the builder (`lib/backends/typescriptBuilder.ts`)
- The `Sentinel` type in `lib/types/sentinel.ts` (it is only used for checkpoint sentinels) and its entry in the `AgencyNode` union in `lib/types.ts`
- The `renderRewindCheckpoint` import in the builder

The new `onTrace` callback fully replaces `onCheckpoint` for any use case where users want to capture execution data programmatically. `onTrace` is added to `CallbackMap` in `lib/runtime/hooks.ts` (which mechanically derives `AgencyCallbacks`) with `onTrace: TraceLine`, and to `VALID_CALLBACK_NAMES` in `lib/types/function.ts`. Its return type is `void` (the `CallbackReturn` default), so no special override is needed. `TraceLine` is the existing union type of all JSONL line types (header, chunk, manifest), defined in `lib/runtime/trace/types.ts`.

### 6. Compile-time Changes

- Remove the `config.debugger || config.trace` conditional guard for inserting `debugStep()` calls — instrumentation is now always emitted by default.
- Add `instrument` config option (default: `true`). When `false`, no `debugStep()` calls are emitted.
- Refactor `traceSetup.mustache` — `TraceWriter` creation should no longer be baked into compiled code. Instead, the runtime initialization path creates the `TraceWriter` based on resolved config + per-call options.
- `config.trace`, `config.traceFile`, and `config.debugger` remain as config options but become runtime-only flags.
- In `lib/runtime/debugger.ts`, the trace write path (`ctx.traceWriter.writeCheckpoint()`) becomes async. Since `debugStep()` is already async, this only requires adding `await` to the `writeCheckpoint` call.

**Note on file extension**: The existing codebase uses `.trace` as the default extension. This spec introduces `.agencytrace` as the new standard extension for trace files. The `traceFile` config option accepts any path so users can still use `.trace` if they prefer, but auto-generated filenames (from `traceDir` and `trace: true`) will use `.agencytrace`.

## Files to Modify

| File | Change |
|------|--------|
| `lib/config.ts` | Add `traceDir`, `instrument` options |
| `lib/runtime/hooks.ts` | Remove `onCheckpoint`, add `onTrace` to `AgencyCallbacks` |
| `lib/types/function.ts` | Remove `onCheckpoint` from `VALID_CALLBACK_NAMES`, add `onTrace` |
| `lib/types/sentinel.ts` | Remove (checkpoint-only type) |
| `lib/types.ts` | Remove `Sentinel` from `AgencyNode` union |
| `lib/runtime/trace/traceWriter.ts` | Refactor to accept `TraceSink[]`, make `writeCheckpoint` async, add `close()` method |
| `lib/runtime/node.ts` | Add trace config resolution (merge per-call options with config), add `TraceWriter.close()` call at end of execution |
| `lib/runtime/trace/traceWriter.test.ts` | Update tests for new sink-based API |
| `lib/runtime/debugger.ts` | Make trace write path async |
| `lib/runtime/state/context.ts` | Update `traceWriter` initialization |
| `lib/backends/typescriptBuilder.ts` | Always emit `debugStep()` (unless `instrument: false`), remove sentinel handling, remove `renderRewindCheckpoint` import |
| `lib/preprocessors/typescriptPreprocessor.ts` | Remove `insertCheckpointSentinels()` method |
| `lib/templates/backends/typescriptGenerator/traceSetup.mustache` | Refactor or remove (TraceWriter creation moves to runtime) |
| `lib/templates/backends/typescriptGenerator/rewindCheckpoint.mustache` | Remove |
| New: `lib/runtime/trace/sinks.ts` | `FileSink` and `CallbackSink` implementations |
| New: `lib/runtime/trace/sinks.test.ts` | Unit tests for sinks |

## Testing Strategy

**Unit tests** (co-located with source):
- `TraceSink` implementations: `FileSink` writes correct JSONL via async I/O, `CallbackSink` invokes callback with correct `TraceLine` data
- `TraceWriter` with multi-sink fan-out: verify CAS processing produces correct chunks + manifests, all sinks receive all lines

**Integration tests** (agency-js):
- `traceDir` in `agency.json` produces auto-named trace files in the specified directory
- Per-call `trace: true` produces a trace file at the default location
- Per-call `traceFile` / `traceDir` options produce trace files at the specified paths
- `trace: false` overrides config-level `traceDir` and produces no trace file
- `onTrace` callback receives correct JSONL lines (header, chunks, manifests)
- `onTrace` + file-based tracing coexist: both receive the same data
- `instrument: false` in `agency.json` produces compiled code without `debugStep()` calls
- Existing trace and debugger tests continue to pass
