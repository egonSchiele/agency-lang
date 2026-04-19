# Runtime Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tracing a runtime concern — always-on instrumentation, config-based auto-tracing, `onTrace` callback, async I/O via TraceSink abstraction.

**Architecture:** The builder always emits `debugStep()` calls (opt-out via `instrument: false`). At runtime, `TraceWriter` fans out to one or more `TraceSink` implementations (`FileSink` for disk, `CallbackSink` for `onTrace`). Tracing activates via `agency.json` config (`traceDir`/`traceFile`), CLI `--trace`, or providing an `onTrace` callback.

**Tech Stack:** TypeScript, Node.js streams, vitest, agency-js test harness

**Spec:** `docs/superpowers/specs/2026-04-19-runtime-tracing-design.md`

---

### Task 1: Add TraceEvent type, create TraceSink interface and implementations

**Files:**
- Modify: `lib/runtime/trace/types.ts` (add `TraceEvent` type)
- Create: `lib/runtime/trace/sinks.ts`
- Create: `lib/runtime/trace/sinks.test.ts`

- [ ] **Step 0: Add `TraceEvent` type to `lib/runtime/trace/types.ts`**

Add after the existing `TraceLine` type:

```typescript
export type TraceEvent = {
  executionId: string;
  line: TraceLine;
};
```

- [ ] **Step 1: Write the TraceSink type and FileSink/CallbackSink tests**

```typescript
// lib/runtime/trace/sinks.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FileSink, CallbackSink } from "./sinks.js";
import type { TraceLine } from "./types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function readJsonl(filePath: string): any[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const sampleHeader: TraceLine = {
  type: "header",
  version: 1,
  agencyVersion: "0.0.0",
  program: "test.agency",
  timestamp: "2026-01-01T00:00:00Z",
  config: { hashAlgorithm: "sha256" },
};

const sampleChunk: TraceLine = {
  type: "chunk",
  hash: "abc123",
  data: { x: 1 },
};

describe("FileSink", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sink-test-"));
    filePath = path.join(tmpDir, "test.agencytrace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes JSONL lines to file", async () => {
    const sink = new FileSink(filePath);
    await sink.writeLine(sampleHeader);
    await sink.writeLine(sampleChunk);
    await sink.close();

    const lines = readJsonl(filePath);
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe("header");
    expect(lines[1].type).toBe("chunk");
  });

  it("close() flushes pending writes", async () => {
    const sink = new FileSink(filePath);
    await sink.writeLine(sampleHeader);
    await sink.close();

    const lines = readJsonl(filePath);
    expect(lines).toHaveLength(1);
  });
});

describe("CallbackSink", () => {
  it("wraps each line in a TraceEvent envelope with executionId", async () => {
    const events: any[] = [];
    const sink = new CallbackSink("exec-123", (event) => { events.push(event); });

    await sink.writeLine(sampleHeader);
    await sink.writeLine(sampleChunk);

    expect(events).toHaveLength(2);
    expect(events[0].executionId).toBe("exec-123");
    expect(events[0].line).toBe(sampleHeader);
    expect(events[1].executionId).toBe("exec-123");
    expect(events[1].line).toBe(sampleChunk);
  });

  it("handles async callbacks", async () => {
    const events: any[] = [];
    const sink = new CallbackSink("exec-456", async (event) => {
      await new Promise((r) => setTimeout(r, 1));
      events.push(event);
    });

    await sink.writeLine(sampleHeader);
    expect(events).toHaveLength(1);
    expect(events[0].executionId).toBe("exec-456");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- lib/runtime/trace/sinks.test.ts`
Expected: FAIL — module `./sinks.js` not found

- [ ] **Step 3: Implement TraceSink, FileSink, and CallbackSink**

```typescript
// lib/runtime/trace/sinks.ts
import * as fs from "fs";
import type { TraceLine, TraceEvent } from "./types.js";

export type TraceSink = {
  writeLine(line: TraceLine): Promise<void> | void;
  close?(): Promise<void> | void;
};

export class FileSink implements TraceSink {
  private stream: fs.WriteStream;

  constructor(filePath: string) {
    this.stream = fs.createWriteStream(filePath, { flags: "w", encoding: "utf-8" });
  }

  writeLine(line: TraceLine): Promise<void> {
    return new Promise((resolve, reject) => {
      const ok = this.stream.write(JSON.stringify(line) + "\n");
      if (ok) {
        resolve();
      } else {
        this.stream.once("drain", resolve);
        this.stream.once("error", reject);
      }
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end(() => resolve());
      this.stream.once("error", reject);
    });
  }
}

export class CallbackSink implements TraceSink {
  private callback: (event: TraceEvent) => void | Promise<void>;
  private executionId: string;

  constructor(executionId: string, callback: (event: TraceEvent) => void | Promise<void>) {
    this.executionId = executionId;
    this.callback = callback;
  }

  async writeLine(line: TraceLine): Promise<void> {
    await this.callback({ executionId: this.executionId, line });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run -- lib/runtime/trace/sinks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/trace/sinks.ts lib/runtime/trace/sinks.test.ts
git commit -m "feat: add TraceSink interface with FileSink and CallbackSink"
```

---

### Task 2: Refactor TraceWriter to use sinks

**Files:**
- Modify: `lib/runtime/trace/traceWriter.ts`
- Modify: `lib/runtime/trace/traceWriter.test.ts`

- [ ] **Step 1: Update TraceWriter tests to use new constructor signature**

The tests in `lib/runtime/trace/traceWriter.test.ts` currently call `new TraceWriter(filePath, program)`. Update them to use the new sink-based constructor. The `TraceWriter` should accept `(program: string, sinks: TraceSink[])`. For test convenience, keep using `FileSink` so we can still read back JSONL from disk.

Update `traceWriter.test.ts`:
- Change `import { TraceWriter }` to also import `{ FileSink }` from `./sinks.js`
- Change every `new TraceWriter(tracePath, "test.agency")` to `new TraceWriter("test.agency", [new FileSink(tracePath)])`
- Add a test for `writeCheckpoint` being async (await the call)
- Add a test for multi-sink fan-out: create a `CallbackSink` alongside the `FileSink` and verify both receive data
- Add a test for `close()`: verify it calls close on all sinks
- Add a test for sink error handling: a sink that throws should not prevent other sinks from receiving data

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test:run -- lib/runtime/trace/traceWriter.test.ts`
Expected: FAIL — constructor signature mismatch

- [ ] **Step 3: Refactor TraceWriter implementation**

Update `lib/runtime/trace/traceWriter.ts`:

```typescript
import { ContentAddressableStore } from "./contentAddressableStore.js";
import type { TraceSink } from "./sinks.js";
import type { TraceManifest } from "./types.js";
import { CHECKPOINT_SCHEMA } from "./types.js";
import type { Checkpoint } from "../state/checkpointStore.js";
import { VERSION } from "../../version.js";

export class TraceWriter {
  private store: ContentAddressableStore;
  private sinks: TraceSink[];
  private checkpointCount = 0;
  private chunkCount = 0;
  private headerPromise: Promise<void>;

  constructor(program: string, sinks: TraceSink[]) {
    this.store = new ContentAddressableStore();
    this.sinks = sinks;
    this.headerPromise = this.writeLine({
      type: "header",
      version: 1,
      agencyVersion: VERSION,
      program,
      timestamp: new Date().toISOString(),
      config: { hashAlgorithm: "sha256" },
    });
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.headerPromise; // Ensure header is written before any checkpoint
    const json = checkpoint.toJSON();
    const { record, chunks } = this.store.process(json, CHECKPOINT_SCHEMA);

    for (const chunk of chunks) {
      await this.writeLine({ type: "chunk", hash: chunk.hash, data: chunk.data });
      this.chunkCount++;
    }

    const manifest: TraceManifest = { type: "manifest", ...record };
    await this.writeLine(manifest);
    this.checkpointCount++;
  }

  async close(): Promise<void> {
    await this.headerPromise;
    // Emit footer as the last line
    await this.writeLine({
      type: "footer",
      checkpointCount: this.checkpointCount,
      chunkCount: this.chunkCount,
      timestamp: new Date().toISOString(),
    });
    for (const sink of this.sinks) {
      try {
        await sink.close?.();
      } catch (error) {
        console.error("[agency] Error closing trace sink:", error);
      }
    }
  }

  private async writeLine(obj: any): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.writeLine(obj);
      } catch (error) {
        console.error("[agency] Trace sink error:", error);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run -- lib/runtime/trace/traceWriter.test.ts`
Expected: PASS

Note: The constructor stores the header write promise in `this.headerPromise`. The first `writeCheckpoint` call awaits this promise before proceeding, ensuring the header is always written first. This avoids the async constructor problem while guaranteeing correct ordering.

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/trace/traceWriter.ts lib/runtime/trace/traceWriter.test.ts
git commit -m "refactor: TraceWriter uses TraceSink[] with async I/O"
```

---

### Task 3: Verify debugStep() trace path is fire-and-forget

**Files:**
- No changes needed to `lib/runtime/debugger.ts`

The `writeCheckpoint` call in `debugStep()` (line 33) is intentionally **not** awaited. Trace writes are fire-and-forget to avoid slowing down execution. The existing call `ctx.traceWriter.writeCheckpoint(cp)` remains unchanged — it returns a Promise that is intentionally discarded. Node.js write streams buffer internally, and `TraceWriter.close()` (called during cleanup) will flush everything before the stream is closed.

- [ ] **Step 1: Verify no changes needed, move on**

---

### Task 4: Add config options (`traceDir`, `instrument`)

**Files:**
- Modify: `lib/config.ts`

- [ ] **Step 1: Add `traceDir` and `instrument` to `AgencyConfig`**

In `lib/config.ts`, add these fields to the `AgencyConfig` interface:

```typescript
  /** Directory for auto-generated trace files. Each execution creates a new file
   *  named <timestamp>_<id>.agencytrace. */
  traceDir?: string;

  /** Whether to emit debugStep() instrumentation in compiled output (default: true).
   *  Set to false to eliminate per-step overhead when tracing/debugging is not needed. */
  instrument?: boolean;
```

Add `traceDir` after the existing `traceFile` field. Add `instrument` after `debugger`.

- [ ] **Step 2: Run existing tests to verify nothing breaks**

Run: `pnpm test:run`
Expected: All existing tests pass (additive change only)

- [ ] **Step 3: Commit**

```bash
git add lib/config.ts
git commit -m "feat: add traceDir and instrument config options"
```

---

### Task 5: Add `onTrace` callback, remove `onCheckpoint`

**Files:**
- Modify: `lib/runtime/hooks.ts`
- Modify: `lib/types/function.ts`
- Modify: `lib/runtime/index.ts`
- Modify: `lib/parsers/function.test.ts` (update `onCheckpoint` -> `onTrace` in callback name test at line 3420)
- Modify: `docs-new/appendix/callbacks.md` (update `onCheckpoint` docs to `onTrace`)

- [ ] **Step 1: Update `CallbackMap` in `lib/runtime/hooks.ts`**

Replace:
```typescript
  onCheckpoint: RewindCheckpoint;
```
with:
```typescript
  onTrace: TraceEvent;
```

Update the imports at the top of the file:
- Remove: `import type { RewindCheckpoint } from "./rewind.js";`
- Add: `import type { TraceEvent } from "./trace/types.js";`

- [ ] **Step 2: Update `VALID_CALLBACK_NAMES` in `lib/types/function.ts`**

Replace `"onCheckpoint"` with `"onTrace"` in the `VALID_CALLBACK_NAMES` array (line 35).

- [ ] **Step 3: Export `TraceSink` type and sink classes from `lib/runtime/index.ts`**

Add:
```typescript
export type { TraceSink } from "./trace/sinks.js";
export { FileSink, CallbackSink } from "./trace/sinks.js";
export type { TraceLine, TraceEvent } from "./trace/types.js";
```

- [ ] **Step 4: Build to verify the compile-time guard passes**

Run: `pnpm run build`
Expected: Build succeeds. The `_AssertNamesMatchMap` guard in `hooks.ts` (lines 57-58) will catch any mismatch between `VALID_CALLBACK_NAMES` and `CallbackMap`.

- [ ] **Step 5: Update parser test**

In `lib/parsers/function.test.ts`, line 3420, replace `"onCheckpoint"` with `"onTrace"` in the `validNames` array.

- [ ] **Step 6: Update callback documentation**

In `docs-new/appendix/callbacks.md`, replace the `onCheckpoint` documentation with `onTrace` documentation. Describe that `onTrace` receives `TraceLine` objects (header, chunk, manifest) for streaming trace data.

- [ ] **Step 7: Run existing tests**

Run: `pnpm test:run`
Expected: Tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/runtime/hooks.ts lib/types/function.ts lib/runtime/index.ts lib/parsers/function.test.ts docs-new/appendix/callbacks.md
git commit -m "feat: replace onCheckpoint with onTrace callback"
```

---

### Task 6: Remove dead checkpoint sentinel code

**Files:**
- Remove: `lib/templates/backends/typescriptGenerator/rewindCheckpoint.mustache`
- Remove: `lib/types/sentinel.ts`
- Modify: `lib/types.ts` (remove `Sentinel` from `AgencyNode` union)
- Modify: `lib/backends/typescriptBuilder.ts` (remove `processSentinel`, `renderRewindCheckpoint` import, `Sentinel` import)
- Modify: `lib/preprocessors/typescriptPreprocessor.ts` (remove `insertCheckpointSentinels` method)

- [ ] **Step 1: Delete `rewindCheckpoint.mustache` and its compiled output**

Delete: `lib/templates/backends/typescriptGenerator/rewindCheckpoint.mustache`
Delete: `lib/templates/backends/typescriptGenerator/rewindCheckpoint.ts` (the compiled template output)

- [ ] **Step 2: Delete `lib/types/sentinel.ts`**

- [ ] **Step 3: Remove `Sentinel` from `lib/types.ts`**

Remove the import:
```typescript
import { Sentinel } from "./types/sentinel.js";
```

Remove `Sentinel` from the `AgencyNode` union type (line 241: `| Sentinel`).

- [ ] **Step 4: Remove sentinel handling from `lib/backends/typescriptBuilder.ts`**

Remove these imports:
```typescript
import * as renderRewindCheckpoint from "../templates/backends/typescriptGenerator/rewindCheckpoint.js";
```
```typescript
import { Sentinel } from "@/types/sentinel.js";
```

Remove the `case "sentinel":` branch in `processNode()` (around line 825-826).

Remove the entire `processSentinel()` method (around lines 2698-2716).

- [ ] **Step 5: Remove `insertCheckpointSentinels` from preprocessor**

In `lib/preprocessors/typescriptPreprocessor.ts`, remove the entire `insertCheckpointSentinels()` method (starting around line 1578) and the commented-out call at line 287.

- [ ] **Step 6: Rebuild templates and build**

Run: `pnpm run templates && pnpm run build`
Expected: Build succeeds

- [ ] **Step 7: Run tests**

Run: `pnpm test:run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add -u  # stages all deletions and modifications
git commit -m "cleanup: remove dead checkpoint sentinel code (onCheckpoint, Sentinel type, rewindCheckpoint template)"
```

---

### Task 7: Always emit instrumentation (with `instrument` opt-out)

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`

- [ ] **Step 1: Change `insertDebugSteps` guard**

In `lib/backends/typescriptBuilder.ts`, line 2932, change:
```typescript
if (!this.agencyConfig?.debugger && !this.agencyConfig?.trace) return body;
```
to:
```typescript
if (this.agencyConfig?.instrument === false) return body;
```

This makes instrumentation default-on, with explicit opt-out.

- [ ] **Step 2: Remove compile-time trace setup from builder**

In `lib/backends/typescriptBuilder.ts`, remove the block around lines 3316-3329 that conditionally injects `renderTraceSetup`:

```typescript
    if (this.agencyConfig.trace) {
      const traceFile =
        this.agencyConfig.traceFile ||
        this.moduleId.replace(/\.agency$/, ".trace");
      runtimeCtx = ts.statements([
        runtimeCtx,
        ts.raw(
          renderTraceSetup.default({
            traceFile: JSON.stringify(traceFile),
            programId: JSON.stringify(this.moduleId),
          }),
        ),
      ]);
    }
```

Also remove the `renderTraceSetup` import (line 38).

- [ ] **Step 3: Delete `traceSetup.mustache` and its compiled output**

Delete: `lib/templates/backends/typescriptGenerator/traceSetup.mustache`
Delete: `lib/templates/backends/typescriptGenerator/traceSetup.ts` (the compiled template output)

- [ ] **Step 4: Rebuild templates and build**

Run: `pnpm run templates && pnpm run build`
Expected: Build succeeds

- [ ] **Step 5: Rebuild fixtures**

Compiled output now always includes `debugStep()` calls, so fixture comparison tests will fail. Rebuild them:

Run: `make fixtures`

This rebuilds all `.mts` fixture files in `tests/typescriptGenerator/`.

- [ ] **Step 6: Run tests**

Run: `pnpm test:run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add -u
git commit -m "feat: always emit debugStep instrumentation (opt-out via instrument: false)"
```

---

### Task 8: Runtime TraceWriter initialization

**Files:**
- Create: `lib/runtime/trace/setup.ts` (factory function for TraceWriter)
- Modify: `lib/runtime/state/context.ts` (add `traceConfig` field, make `cleanup()` async)
- Modify: `lib/runtime/node.ts` (one-liner to call `createTraceWriter`)
- Modify: `lib/runtime/interrupts.ts` (await async `cleanup()`)
- Modify: `lib/runtime/rewind.ts` (await async `cleanup()`)
- Modify: `lib/backends/typescriptBuilder.ts` (bake `traceDir`/`traceFile` into `RuntimeContext` constructor args)

**Background**: `AgencyConfig` is not available at runtime — the builder bakes config values into the generated code as literals (e.g., `statelogConfig`, `maxRestores`). We follow the same pattern: the builder bakes `traceDir` and `traceFile` into the `RuntimeContext` constructor args, and the runtime reads them from the context.

- [ ] **Step 1: Add `traceConfig` to `RuntimeContext`**

In `lib/runtime/state/context.ts`, add a new field to the constructor args type and the class:

```typescript
// Add to the constructor args type:
traceConfig?: { traceDir?: string; traceFile?: string };

// Add as a class field:
traceConfig: { traceDir?: string; traceFile?: string };
```

In the constructor body, set `this.traceConfig = args.traceConfig || {};`.

In `createExecutionContext()`, copy it: `execCtx.traceConfig = this.traceConfig;`.

- [ ] **Step 2: Bake `traceDir`/`traceFile` into generated code**

In `lib/backends/typescriptBuilder.ts`, in the `generateImports()` method (around line 3297), add `traceConfig` to `runtimeCtxArgs`:

```typescript
const traceConfigFields: Record<string, TsNode> = {};
if (this.agencyConfig.traceDir) {
  traceConfigFields.traceDir = ts.str(this.agencyConfig.traceDir);
}
if (this.agencyConfig.traceFile) {
  traceConfigFields.traceFile = ts.str(this.agencyConfig.traceFile);
}
if (Object.keys(traceConfigFields).length > 0) {
  runtimeCtxArgs.traceConfig = ts.obj(traceConfigFields);
}
```

- [ ] **Step 3: Create `lib/runtime/trace/setup.ts` with factory function**

```typescript
// lib/runtime/trace/setup.ts
import * as fs from "fs";
import * as path from "path";
import { nanoid } from "agency-lang";
import { TraceWriter } from "./traceWriter.js";
import { FileSink, CallbackSink } from "./sinks.js";
import type { TraceSink } from "./sinks.js";
import type { AgencyCallbacks } from "../hooks.js";

function generateTraceFilePath(dir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = Math.random().toString(16).slice(2, 6);
  return path.join(dir, `${timestamp}_${id}.agencytrace`);
}

export function createTraceWriter(
  traceConfig: { traceDir?: string; traceFile?: string },
  callbacks: AgencyCallbacks,
): TraceWriter | null {
  const sinks: TraceSink[] = [];

  if (traceConfig?.traceDir) {
    fs.mkdirSync(traceConfig.traceDir, { recursive: true });
    sinks.push(new FileSink(generateTraceFilePath(traceConfig.traceDir)));
  } else if (traceConfig?.traceFile) {
    sinks.push(new FileSink(traceConfig.traceFile));
  }

  if (callbacks.onTrace) {
    sinks.push(new CallbackSink(nanoid(), callbacks.onTrace));
  }

  return sinks.length > 0
    ? new TraceWriter(traceConfig?.traceFile || traceConfig?.traceDir || "unknown.agency", sinks)
    : null;
}
```

- [ ] **Step 4: Use `createTraceWriter` in `runNode`**

In `lib/runtime/node.ts`, add import and one-liner after callbacks assignment (after line 112):

```typescript
import { createTraceWriter } from "./trace/setup.js";
```

```typescript
  execCtx.traceWriter = createTraceWriter(ctx.traceConfig, execCtx.callbacks);
```

- [ ] **Step 5: Make `cleanup()` async and update all call sites**

In `lib/runtime/state/context.ts`, change `cleanup()`:

```typescript
  async cleanup(): Promise<void> {
    if (this.traceWriter) {
      await this.traceWriter.close();
    }
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new AgencyCancelledError("cleanup"));
    }
    this.pendingPromises.clear();
    this.stateStack = null as any;
    this.globals = null as any;
    this.checkpoints = null as any;
    this.statelogClient = null as any;
    this.callbacks = null as any;
    this.handlers = null as any;
    this.traceWriter = null;
  }
```

Update all call sites to `await`:
- `lib/runtime/node.ts` line 180: `await execCtx.cleanup()`
- `lib/runtime/interrupts.ts` line 267: `await execCtx.cleanup()`
- `lib/runtime/interrupts.ts` line 412: `await execCtx.cleanup()`
- `lib/runtime/rewind.ts` line 84: `await execCtx.cleanup()`

All four are in `finally` blocks of async functions, so adding `await` is safe.

- [ ] **Step 6: Build and run tests**

Run: `pnpm run build && pnpm test:run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/trace/setup.ts lib/runtime/node.ts lib/runtime/state/context.ts lib/runtime/interrupts.ts lib/runtime/rewind.ts lib/backends/typescriptBuilder.ts
git commit -m "feat: runtime TraceWriter initialization from config and onTrace callback"
```

---

### Task 9: Integration test — `traceDir` in config

**Files:**
- Create: `tests/agency-js/trace/trace-dir/agent.agency`
- Create: `tests/agency-js/trace/trace-dir/agency.json`
- Create: `tests/agency-js/trace/trace-dir/test.js`
- Create: `tests/agency-js/trace/trace-dir/fixture.json`

- [ ] **Step 1: Create the agency file**

```
// tests/agency-js/trace/trace-dir/agent.agency
node main() {
  const x = 1
  const y = 2
  return x + y
}
```

- [ ] **Step 2: Create the agency.json config**

```json
{
  "traceDir": "traces/"
}
```

- [ ] **Step 3: Create the test.js**

```javascript
import { main } from "./agent.js";
import { writeFileSync, readdirSync, readFileSync } from "fs";

const result = await main();

// Check that a trace file was created in the traces/ directory
const traceFiles = readdirSync("traces/").filter(f => f.endsWith(".agencytrace"));
const hasTraceFile = traceFiles.length === 1;

// Read and verify trace content
let headerValid = false;
let hasManifest = false;
if (hasTraceFile) {
  const content = readFileSync(`traces/${traceFiles[0]}`, "utf-8");
  const lines = content.trim().split("\n").map(l => JSON.parse(l));
  const header = lines.find(l => l.type === "header");
  headerValid = header && header.version === 1 && typeof header.program === "string";
  hasManifest = lines.some(l => l.type === "manifest");
}

writeFileSync("__result.json", JSON.stringify({
  result: result.data,
  hasTraceFile,
  headerValid,
  hasManifest,
}, null, 2));
```

- [ ] **Step 4: Run the test to generate the fixture**

Run: `pnpm run build && node dist/scripts/agency.js test js tests/agency-js/trace/trace-dir`

Capture the `__result.json` output and save it as `fixture.json`. Expected content:
```json
{
  "result": 3,
  "hasTraceFile": true,
  "headerValid": true,
  "hasManifest": true
}
```

- [ ] **Step 5: Commit**

```bash
git add tests/agency-js/trace/
git commit -m "test: integration test for traceDir config"
```

---

### Task 10: Integration test — `onTrace` callback

**Files:**
- Create: `tests/agency-js/trace/on-trace-callback/agent.agency`
- Create: `tests/agency-js/trace/on-trace-callback/test.js`
- Create: `tests/agency-js/trace/on-trace-callback/fixture.json`

- [ ] **Step 1: Create the agency file**

```
// tests/agency-js/trace/on-trace-callback/agent.agency
node main() {
  const x = 1
  const y = 2
  return x + y
}
```

- [ ] **Step 2: Create the test.js**

```javascript
import { main } from "./agent.js";
import { writeFileSync } from "fs";

const traceEvents = [];

const result = await main({
  callbacks: {
    onTrace(event) {
      traceEvents.push(event);
    },
  },
});

// Verify envelope structure
const hasExecutionId = traceEvents.length > 0 && typeof traceEvents[0].executionId === "string";
const allSameId = traceEvents.every(e => e.executionId === traceEvents[0]?.executionId);

// Verify line contents
const lines = traceEvents.map(e => e.line);
const hasHeader = lines.some(l => l.type === "header");
const hasManifest = lines.some(l => l.type === "manifest");
const hasFooter = lines.some(l => l.type === "footer");
const types = [...new Set(lines.map(l => l.type))].sort();

writeFileSync("__result.json", JSON.stringify({
  result: result.data,
  eventCount: traceEvents.length,
  hasExecutionId,
  allSameId,
  hasHeader,
  hasManifest,
  hasFooter,
  types,
}, null, 2));
```

- [ ] **Step 3: Run the test to generate the fixture**

Run: `pnpm run build && node dist/scripts/agency.js test js tests/agency-js/trace/on-trace-callback`

Save `__result.json` as `fixture.json`. Expected: `hasExecutionId: true`, `allSameId: true`, `hasHeader: true`, `hasManifest: true`, `hasFooter: true`, `types` includes at least `["chunk", "footer", "header", "manifest"]`.

- [ ] **Step 4: Commit**

```bash
git add tests/agency-js/trace/on-trace-callback/
git commit -m "test: integration test for onTrace callback"
```

---

### Task 11: Integration test — `onTrace` + `traceDir` coexist

**Files:**
- Create: `tests/agency-js/trace/trace-both/agent.agency`
- Create: `tests/agency-js/trace/trace-both/agency.json`
- Create: `tests/agency-js/trace/trace-both/test.js`
- Create: `tests/agency-js/trace/trace-both/fixture.json`

- [ ] **Step 1: Create files**

`agent.agency`:
```
node main() {
  const x = 1
  return x
}
```

`agency.json`:
```json
{
  "traceDir": "traces/"
}
```

`test.js`:
```javascript
import { main } from "./agent.js";
import { writeFileSync, readdirSync, readFileSync } from "fs";

const callbackLines = [];

const result = await main({
  callbacks: {
    onTrace(line) {
      callbackLines.push(line);
    },
  },
});

// Both should have received data
const traceFiles = readdirSync("traces/").filter(f => f.endsWith(".agencytrace"));
const hasTraceFile = traceFiles.length === 1;

let fileLineCount = 0;
if (hasTraceFile) {
  const content = readFileSync(`traces/${traceFiles[0]}`, "utf-8");
  fileLineCount = content.trim().split("\n").length;
}

writeFileSync("__result.json", JSON.stringify({
  result: result.data,
  hasTraceFile,
  callbackLineCount: callbackLines.length,
  fileLineCount,
  countsMatch: callbackLines.length === fileLineCount,
}, null, 2));
```

- [ ] **Step 2: Run the test to generate fixture**

Run: `pnpm run build && node dist/scripts/agency.js test js tests/agency-js/trace/trace-both`

Expected: `countsMatch: true`, both `callbackLineCount` and `fileLineCount` > 0.

- [ ] **Step 3: Commit**

```bash
git add tests/agency-js/trace/trace-both/
git commit -m "test: integration test for onTrace + traceDir coexistence"
```

---

### Task 12: Integration test — `instrument: false`

**Files:**
- Create: `tests/agency-js/trace/instrument-false/agent.agency`
- Create: `tests/agency-js/trace/instrument-false/agency.json`
- Create: `tests/agency-js/trace/instrument-false/test.js`
- Create: `tests/agency-js/trace/instrument-false/fixture.json`

- [ ] **Step 1: Create files**

`agent.agency`:
```
node main() {
  const x = 1
  return x
}
```

`agency.json`:
```json
{
  "instrument": false
}
```

`test.js`:
```javascript
import { readFileSync, writeFileSync } from "fs";

// Read the compiled output and check for debugStep
const compiled = readFileSync("agent.js", "utf-8");
const hasDebugStep = compiled.includes("debugStep") || compiled.includes("maybeDebugHook");

writeFileSync("__result.json", JSON.stringify({
  hasDebugStep,
}, null, 2));
```

- [ ] **Step 2: Run the test to generate fixture**

Run: `pnpm run build && node dist/scripts/agency.js test js tests/agency-js/trace/instrument-false`

Expected: `{ "hasDebugStep": false }`

- [ ] **Step 3: Commit**

```bash
git add tests/agency-js/trace/instrument-false/
git commit -m "test: integration test for instrument: false config"
```

---

### Task 13: Final verification

- [ ] **Step 1: Run all test suites**

Run: `pnpm test:run && pnpm run test:agency && pnpm run test:agency-js`
Expected: All tests pass (including new trace tests from Tasks 9-12)

- [ ] **Step 2: If any tests fail, fix and commit**

```bash
git add -u
git commit -m "fix: address test failures from runtime tracing changes"
```
