# Execution Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add content-addressable execution trace export to Agency programs, streaming checkpoints to a `.agencytrace` JSONL file with deduplication.

**Architecture:** Trace infrastructure lives in the runtime (`lib/runtime/trace/`). The builder has two changes: (1) expanding the condition for inserting `debugStep` calls to include `config.trace`, and (2) injecting `TraceWriter` setup code into the generated TypeScript (following the same pattern as audit log setup). `debugStep` gains a code path that writes to a `TraceWriter` on `RuntimeContext`. A `TraceReader` class provides reconstruction for replay and programmatic access.

**Tech Stack:** Node.js `crypto` (SHA-256), `fs` (streaming writes), existing `Checkpoint` / `StateStackJSON` / `GlobalStoreJSON` types.

**Spec:** `docs/superpowers/specs/2026-04-01-execution-trace-design.md`

---

### Task 0: Extract SourceLocation Type

The pattern `{ nodeId, moduleId, scopeName, stepPath }` appears in many places across the codebase but is never grouped into a named type. This makes it unclear that these four fields form a logical unit — a location in Agency source code. Extract this into a `SourceLocation` type and use it everywhere.

**Files:**
- Create: `lib/runtime/state/sourceLocation.ts`
- Modify: `lib/runtime/state/checkpointStore.ts` — Use `SourceLocation` in `Checkpoint`, `CheckpointArgs`, `create()`, `findCheckpoint()`, `createRolling()`, `createPinned()`, `removeDuplicate()`
- Modify: `lib/runtime/debugger.ts` — Use `SourceLocation` in `debugStep` info parameter
- Modify: `lib/debugger/debuggerState.ts` — Use `SourceLocation` in `createRollingCheckpoint()`, `createPinnedCheckpoint()`, `findCheckpoint()`
- Modify: `lib/backends/typescriptBuilder.ts` — Use `SourceLocation` in `checkpointOpts()` return type

- [ ] **Step 1: Create the SourceLocation type**

```typescript
// lib/runtime/state/sourceLocation.ts
export type SourceLocation = {
  nodeId: string;
  moduleId: string;
  scopeName: string;
  stepPath: string;
};
```

- [ ] **Step 2: Update `Checkpoint` and `CheckpointArgs` in `checkpointStore.ts`**

The `Checkpoint` class should `implement SourceLocation`, making the type relationship explicit. The flat fields (`nodeId`, `moduleId`, `scopeName`, `stepPath`) remain on the class so existing code (`cp.moduleId`) continues to work. A `location` getter returns the grouped `SourceLocation` for new code that wants to pass it around.

In `lib/runtime/state/checkpointStore.ts`:

```typescript
import type { SourceLocation } from "./sourceLocation.js";

// For methods that take location without nodeId (nodeId comes from ctx):
type SourceLocationWithoutNodeId = Omit<SourceLocation, "nodeId">;
```

Update `create()`, `createRolling()`, `createPinned()`, `findCheckpoint()`, `removeDuplicate()` to use `SourceLocationWithoutNodeId` instead of inline `{ moduleId: string; scopeName: string; stepPath: string; }`.

Update the `Checkpoint` class:

```typescript
export class Checkpoint implements SourceLocation {
  // ... existing fields unchanged ...

  get location(): SourceLocation {
    return {
      nodeId: this.nodeId,
      moduleId: this.moduleId,
      scopeName: this.scopeName,
      stepPath: this.stepPath,
    };
  }
}
```

The `implements SourceLocation` enforces at the type level that `Checkpoint` always has the four location fields. If `SourceLocation` gains a field, `Checkpoint` must add it too.

- [ ] **Step 3: Update `debugStep` in `lib/runtime/debugger.ts`**

Change the `info` parameter type to use `SourceLocation`:

```typescript
import type { SourceLocation } from "./state/sourceLocation.js";

export async function debugStep(
  ctx: RuntimeContext<any>,
  state: InternalFunctionState,
  info: Omit<SourceLocation, "nodeId"> & {
    label: string | null;
    nodeContext: boolean;
  },
): Promise<Interrupt | undefined> {
```

- [ ] **Step 4: Update `DebuggerState` in `lib/debugger/debuggerState.ts`**

Change method signatures to use `SourceLocation` types (same `Omit<SourceLocation, "nodeId">` pattern since `nodeId` comes from `ctx`).

- [ ] **Step 5: Update `checkpointOpts()` in `lib/backends/typescriptBuilder.ts`**

Change return type to reference the `SourceLocation`-derived type. Note: the builder emits code that will run at runtime, so it just produces strings — the type is for the builder's own code, not generated code. Update the return type annotation.

- [ ] **Step 6: Run all tests to verify nothing breaks**

Run: `pnpm vitest run`
Expected: All PASS (this is a pure refactor — no behavior changes)

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/state/sourceLocation.ts lib/runtime/state/checkpointStore.ts lib/runtime/debugger.ts lib/debugger/debuggerState.ts lib/backends/typescriptBuilder.ts
git commit -m "refactor: extract SourceLocation type for checkpoint location fields"
```

---

### Task 1: Trace Types

**Files:**
- Create: `lib/runtime/trace/types.ts`

- [ ] **Step 1: Create the types file**

The `TraceManifest` type is fully derived from `Checkpoint` and the CAS schema. `CASResult<T, S>` is a recursive mapped type (defined in Task 3) that transforms `T` according to schema `S` — replacing hashed values with `string`. The manifest is simply the CAS-processed checkpoint JSON plus a `type` discriminator. No manual field listing needed — if `Checkpoint` or the schema changes, the manifest type updates automatically.

```typescript
import type { CASResult, CASSchema } from "./contentAddressableStore.js";
import type { Checkpoint } from "../state/checkpointStore.js";

// The checkpoint JSON shape (what checkpoint.toJSON() returns)
export type CheckpointJSON = ReturnType<Checkpoint["toJSON"]>;

// The schema must be defined as const for TypeScript to infer literal types.
// `true` means "hash each element/value of the thing at this key."
export const CHECKPOINT_SCHEMA = {
  stack: { stack: true },
  globals: { store: true },
} as const;

export type TraceHeader = {
  type: "header";
  version: number;
  program: string;
  timestamp: string;
  config: { hashAlgorithm: string };
};

export type TraceChunk = {
  type: "chunk";
  hash: string;
  data: any;
};

// The manifest IS the CAS-processed checkpoint + a type discriminator.
// CASResult walks the checkpoint type and schema in parallel:
// - stack.stack: StateJSON[] → string[] (each frame hashed)
// - globals.store: Record<string, Record<string, any>> → Record<string, string> (each module's globals hashed)
// - All other fields (id, nodeId, moduleId, label, etc.) pass through unchanged
export type TraceManifest = {
  type: "manifest";
} & CASResult<CheckpointJSON, typeof CHECKPOINT_SCHEMA>;

export type TraceFooter = {
  type: "footer";
  checkpointCount: number;
  chunkCount: number;
  timestamp: string;
};

export type TraceLine = TraceHeader | TraceChunk | TraceManifest | TraceFooter;
```

- [ ] **Step 2: Commit**

```bash
git add lib/runtime/trace/types.ts
git commit -m "feat(trace): add trace file format types"
```

---

### Task 2: Canonicalize

**Files:**
- Create: `lib/runtime/trace/canonicalize.ts`
- Create: `lib/runtime/trace/canonicalize.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { canonicalize } from "./canonicalize.js";

describe("canonicalize", () => {
  it("sorts object keys alphabetically", () => {
    const a = canonicalize({ b: 1, a: 2 });
    const b = canonicalize({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it("sorts nested object keys", () => {
    const a = canonicalize({ outer: { z: 1, a: 2 } });
    expect(a).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("preserves array order", () => {
    const result = canonicalize([3, 1, 2]);
    expect(result).toBe("[3,1,2]");
  });

  it("handles null", () => {
    expect(canonicalize(null)).toBe("null");
  });

  it("handles primitives", () => {
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hello")).toBe('"hello"');
    expect(canonicalize(true)).toBe("true");
  });

  it("handles arrays of objects with different key orders", () => {
    const a = canonicalize([{ b: 1, a: 2 }]);
    const b = canonicalize([{ a: 2, b: 1 }]);
    expect(a).toBe(b);
  });

  it("handles undefined values in objects by omitting them", () => {
    const result = canonicalize({ a: 1, b: undefined });
    expect(result).toBe('{"a":1}');
  });

  it("handles deeply nested structures", () => {
    const a = canonicalize({ c: { b: { a: 1 } } });
    expect(a).toBe('{"c":{"b":{"a":1}}}');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/runtime/trace/canonicalize.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement canonicalize**

```typescript
export function canonicalize(value: any): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object") {
    const sorted: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/trace/canonicalize.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/trace/canonicalize.ts lib/runtime/trace/canonicalize.test.ts
git commit -m "feat(trace): add deterministic JSON canonicalization"
```

---

### Task 3: ContentAddressableStore

A generic class that converts any object into a content-addressable format. It has no knowledge of traces, checkpoints, or Agency — it operates on plain objects using a declarative schema.

**Files:**
- Create: `lib/runtime/trace/contentAddressableStore.ts`
- Create: `lib/runtime/trace/contentAddressableStore.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { ContentAddressableStore } from "./contentAddressableStore.js";
import type { CASSchema } from "./contentAddressableStore.js";

describe("ContentAddressableStore", () => {
  it("hashes each element of an array when key is marked true", () => {
    const store = new ContentAddressableStore();
    const schema = { frames: true } as const;
    const obj = { frames: [{ step: 0 }, { step: 1 }] };
    const { record, chunks } = store.process(obj, schema);

    expect(Array.isArray(record.frames)).toBe(true);
    expect(record.frames).toHaveLength(2);
    expect(typeof record.frames[0]).toBe("string");
    expect(typeof record.frames[1]).toBe("string");
    expect(record.frames[0]).toHaveLength(16);
    expect(chunks).toHaveLength(2);
  });

  it("hashes each value of an object when key is marked true", () => {
    const store = new ContentAddressableStore();
    const schema = { items: true } as const;
    const obj = { items: { a: { x: 1 }, b: { x: 2 } } };
    const { record, chunks } = store.process(obj, schema);

    expect(typeof record.items.a).toBe("string");
    expect(typeof record.items.b).toBe("string");
    expect(record.items.a).not.toBe(record.items.b);
    expect(chunks).toHaveLength(2);
  });

  it("hashes a primitive value when key is marked true", () => {
    const store = new ContentAddressableStore();
    const schema = { name: true } as const;
    const { record, chunks } = store.process({ name: "Alice", age: 30 }, schema);

    expect(typeof record.name).toBe("string");
    expect(record.name).toHaveLength(16);
    expect(record.age).toBe(30);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].data).toBe("Alice");
  });

  it("recurses into nested schema", () => {
    const store = new ContentAddressableStore();
    const schema = { outer: { inner: true } } as const;
    const { record } = store.process(
      { outer: { inner: [1, 2, 3], other: "hi" } },
      schema,
    );

    // inner is an array, so each element gets hashed
    expect(Array.isArray(record.outer.inner)).toBe(true);
    expect(typeof record.outer.inner[0]).toBe("string");
    expect(record.outer.other).toBe("hi");
  });

  it("deduplicates identical values within one call", () => {
    const store = new ContentAddressableStore();
    const schema = { items: true } as const;
    const obj = { items: { a: { x: 1 }, b: { x: 1 } } }; // same value
    const { record, chunks } = store.process(obj, schema);

    expect(record.items.a).toBe(record.items.b); // same hash
    expect(chunks).toHaveLength(1); // written once
  });

  it("deduplicates across multiple process calls", () => {
    const store = new ContentAddressableStore();
    const schema = { data: true } as const;

    const result1 = store.process({ data: { x: 1 } }, schema);
    const result2 = store.process({ data: { x: 1 } }, schema);

    // data is an object with one key, so one chunk per call
    // but second call deduplicates
    expect(result1.chunks.length).toBeGreaterThan(0);
    expect(result2.chunks).toHaveLength(0);
  });

  it("returns non-schema keys unchanged", () => {
    const store = new ContentAddressableStore();
    const schema = { big: true } as const;
    const { record } = store.process({ big: [1, 2, 3], small: "hi", num: 42 }, schema);

    expect(record.small).toBe("hi");
    expect(record.num).toBe(42);
    expect(Array.isArray(record.big)).toBe(true);
    expect(typeof record.big[0]).toBe("string"); // array elements hashed
  });

  it("handles empty objects and arrays", () => {
    const store = new ContentAddressableStore();
    const schema = { items: true } as const;

    const { record: r1, chunks: c1 } = store.process({ items: {} }, schema);
    expect(r1.items).toEqual({});
    expect(c1).toHaveLength(0);

    const { record: r2, chunks: c2 } = store.process({ items: [] }, schema);
    expect(r2.items).toEqual([]);
    expect(c2).toHaveLength(0);
  });

  it("reconstruct reverses process", () => {
    const store = new ContentAddressableStore();
    const schema = { outer: { inner: true } } as const;
    const original = { outer: { inner: [{ a: 1 }, { a: 2 }], other: "hi" }, top: 99 };

    store.process(original, schema);
    // Process again to get the CAS record
    const { record } = store.process(original, schema);

    const reconstructed = store.reconstruct(record, schema);
    expect(reconstructed).toEqual(original);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/runtime/trace/contentAddressableStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ContentAddressableStore**

The store includes a `CASResult<T, S>` recursive mapped type that derives the output type from the input type and schema at compile time. When a schema key is `true`, the runtime hashes each element/value of the data at that key (array elements, object values, or the primitive itself). The type system mirrors this: arrays become `string[]`, records become `Record<string, string>`, primitives become `string`.

```typescript
import * as crypto from "crypto";
import { canonicalize } from "./canonicalize.js";

// Schema type: mirrors the shape of the object
// - true: hash each element/value of the data at this key
// - nested object: recurse into the data at this key
export type CASSchema = {
  [key: string]: true | CASSchema;
};

// Compile-time type transformation: given object type T and schema S,
// compute the result type where hashed values become `string`.
export type CASResult<T, S extends CASSchema> = {
  [K in keyof T]: K extends keyof S
    ? S[K] extends true
      ? T[K] extends any[]
        ? string[]                          // array → string[]
        : T[K] extends Record<string, any>
          ? Record<string, string>          // record → Record<string, string>
          : string                          // primitive → string
      : S[K] extends CASSchema
        ? CASResult<T[K], S[K]>            // recurse
        : T[K]
    : T[K]                                  // not in schema, unchanged
};

export type Chunk = {
  hash: string;
  data: any;
};

export class ContentAddressableStore {
  private seenHashes: Set<string> = new Set();
  private chunkData: Record<string, any> = {};

  process<T, S extends CASSchema>(
    record: T,
    schema: S,
  ): { record: CASResult<T, S>; chunks: Chunk[] } {
    const chunks: Chunk[] = [];
    const result = this.walk(record, schema, chunks);
    return { record: result as CASResult<T, S>, chunks };
  }

  reconstruct<T>(record: any, schema: CASSchema): T {
    return this.walkReverse(record, schema) as T;
  }

  loadChunks(chunks: Record<string, any>): void {
    for (const [hash, data] of Object.entries(chunks)) {
      this.seenHashes.add(hash);
      this.chunkData[hash] = data;
    }
  }

  private walk(data: any, schema: CASSchema, chunks: Chunk[]): any {
    if (data === null || data === undefined) return data;
    const result = Array.isArray(data) ? [...data] : { ...data };

    for (const key of Object.keys(schema)) {
      if (!(key in data)) continue;
      const schemaValue = schema[key];

      if (schemaValue === true) {
        // Hash each element/value of the data at this key
        const val = data[key];
        if (Array.isArray(val)) {
          result[key] = val.map((item: any) => this.hashAndStore(item, chunks));
        } else if (typeof val === "object" && val !== null) {
          const hashed: Record<string, string> = {};
          for (const k of Object.keys(val)) {
            hashed[k] = this.hashAndStore(val[k], chunks);
          }
          result[key] = hashed;
        } else {
          result[key] = this.hashAndStore(val, chunks);
        }
      } else {
        result[key] = this.walk(data[key], schemaValue, chunks);
      }
    }

    return result;
  }

  private walkReverse(data: any, schema: CASSchema): any {
    if (data === null || data === undefined) return data;
    const result = Array.isArray(data) ? [...data] : { ...data };

    for (const key of Object.keys(schema)) {
      if (!(key in data)) continue;
      const schemaValue = schema[key];

      if (schemaValue === true) {
        const val = data[key];
        if (Array.isArray(val)) {
          result[key] = val.map((hash: string) => this.chunkData[hash]);
        } else if (typeof val === "object" && val !== null) {
          const resolved: Record<string, any> = {};
          for (const k of Object.keys(val)) {
            resolved[k] = this.chunkData[val[k]];
          }
          result[key] = resolved;
        } else {
          result[key] = this.chunkData[val];
        }
      } else {
        result[key] = this.walkReverse(data[key], schemaValue);
      }
    }

    return result;
  }

  private hashAndStore(value: any, chunks: Chunk[]): string {
    const canonical = canonicalize(value);
    const hash = crypto
      .createHash("sha256")
      .update(canonical)
      .digest("hex")
      .slice(0, 16);

    if (!this.seenHashes.has(hash)) {
      this.seenHashes.add(hash);
      this.chunkData[hash] = value;
      chunks.push({ hash, data: value });
    }

    return hash;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/trace/contentAddressableStore.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/trace/contentAddressableStore.ts lib/runtime/trace/contentAddressableStore.test.ts
git commit -m "feat: add generic ContentAddressableStore with recursive schema"
```

---

### Task 4: TraceWriter and TraceReader

Now build the trace-specific writer and reader on top of `ContentAddressableStore`. The `TraceWriter` takes a `Checkpoint` directly (no need to destructure its fields). It uses the generic store with a schema that describes which parts of a checkpoint to hash.

**Files:**
- Create: `lib/runtime/trace/traceWriter.ts`
- Create: `lib/runtime/trace/traceReader.ts`
- Create: `lib/runtime/trace/traceWriter.test.ts`
- Create: `lib/runtime/trace/traceReader.test.ts`

- [ ] **Step 1: Write failing TraceWriter tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TraceWriter } from "./traceWriter.js";
import { Checkpoint } from "../state/checkpointStore.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function readTrace(filePath: string) {
  return fs
    .readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function makeCheckpoint(overrides: Partial<Record<string, any>> = {}): Checkpoint {
  return new Checkpoint({
    id: 0,
    nodeId: "start",
    moduleId: "main.agency",
    scopeName: "myNode",
    stepPath: "0",
    label: null,
    pinned: false,
    stack: {
      stack: [{ args: {}, locals: {}, threads: null, step: 0 }],
      mode: "serialize",
      other: {},
      deserializeStackLength: 0,
      nodesTraversed: ["start"],
    },
    globals: {
      store: { "main.agency": { x: 1 } },
      initializedModules: ["main.agency"],
    },
    ...overrides,
  });
}

describe("TraceWriter", () => {
  let tmpDir: string;
  let tracePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));
    tracePath = path.join(tmpDir, "test.agencytrace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a header as the first line", () => {
    const writer = new TraceWriter(tracePath, "test.agency");
    writer.close();

    const lines = readTrace(tracePath);
    expect(lines[0].type).toBe("header");
    expect(lines[0].program).toBe("test.agency");
    expect(lines[0].version).toBe(1);
  });

  it("writes chunks before their manifest", () => {
    const writer = new TraceWriter(tracePath, "test.agency");
    writer.writeCheckpoint(makeCheckpoint());
    writer.close();

    const lines = readTrace(tracePath);
    const chunkIndices = lines
      .map((l, i) => (l.type === "chunk" ? i : -1))
      .filter((i) => i >= 0);
    const manifestIndex = lines.findIndex((l) => l.type === "manifest");
    for (const ci of chunkIndices) {
      expect(ci).toBeLessThan(manifestIndex);
    }
  });

  it("deduplicates identical globals across checkpoints", () => {
    const writer = new TraceWriter(tracePath, "test.agency");

    // Two checkpoints with same globals but different frames
    writer.writeCheckpoint(makeCheckpoint({ id: 0, stepPath: "0" }));
    writer.writeCheckpoint(makeCheckpoint({
      id: 1,
      stepPath: "1",
      stack: {
        stack: [{ args: {}, locals: { x: 99 }, threads: null, step: 1 }],
        mode: "serialize",
        other: {},
        deserializeStackLength: 0,
        nodesTraversed: ["start"],
      },
    }));
    writer.close();

    const lines = readTrace(tracePath);
    const chunks = lines.filter((l) => l.type === "chunk");
    // 2 different frame chunks + 1 shared globals chunk = 3
    expect(chunks).toHaveLength(3);
  });

  it("writes a footer with correct counts", () => {
    const writer = new TraceWriter(tracePath, "test.agency");
    writer.writeCheckpoint(makeCheckpoint());
    writer.close();

    const lines = readTrace(tracePath);
    const footer = lines.find((l) => l.type === "footer");
    expect(footer).toBeDefined();
    expect(footer.checkpointCount).toBe(1);
    expect(footer.chunkCount).toBeGreaterThan(0);
  });

  it("manifest contains checkpoint metadata alongside hashed fields", () => {
    const writer = new TraceWriter(tracePath, "test.agency");
    writer.writeCheckpoint(makeCheckpoint({ label: "test-label", pinned: true }));
    writer.close();

    const lines = readTrace(tracePath);
    const manifest = lines.find((l) => l.type === "manifest");
    // Metadata fields pass through unchanged
    expect(manifest.id).toBe(0);
    expect(manifest.nodeId).toBe("start");
    expect(manifest.moduleId).toBe("main.agency");
    expect(manifest.label).toBe("test-label");
    expect(manifest.pinned).toBe(true);
    // Stack metadata preserved, frames are hashes
    expect(manifest.stack.mode).toBe("serialize");
    expect(manifest.stack.nodesTraversed).toEqual(["start"]);
    expect(typeof manifest.stack.stack[0]).toBe("string"); // hash, not object
    // Globals metadata preserved, store values are hashes
    expect(manifest.globals.initializedModules).toEqual(["main.agency"]);
    expect(typeof manifest.globals.store["main.agency"]).toBe("string"); // hash
  });
});
```

- [ ] **Step 2: Write failing TraceReader tests**

The reader's public API mirrors the writer: the writer takes checkpoints in, the reader gives checkpoints back. No manifests exposed.

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TraceWriter } from "./traceWriter.js";
import { TraceReader } from "./traceReader.js";
import { Checkpoint } from "../state/checkpointStore.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("TraceReader", () => {
  let tmpDir: string;
  let tracePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));
    tracePath = path.join(tmpDir, "test.agencytrace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSimpleTrace(count: number) {
    const writer = new TraceWriter(tracePath, "test.agency");
    for (let i = 0; i < count; i++) {
      writer.writeCheckpoint(new Checkpoint({
        id: i,
        nodeId: "start",
        moduleId: "main.agency",
        scopeName: "myNode",
        stepPath: String(i),
        stack: {
          stack: [{ args: {}, locals: { x: i }, threads: null, step: i }],
          mode: "serialize",
          other: {},
          deserializeStackLength: 0,
          nodesTraversed: ["start"],
        },
        globals: {
          store: { "main.agency": { count: 0 } },
          initializedModules: ["main.agency"],
        },
      }));
    }
    writer.close();
  }

  it("exposes header, footer, and checkpoints", () => {
    writeSimpleTrace(3);
    const reader = TraceReader.fromFile(tracePath);

    expect(reader.header.program).toBe("test.agency");
    expect(reader.footer).not.toBeNull();
    expect(reader.checkpoints).toHaveLength(3);
  });

  it("returns fully reconstructed Checkpoint instances", () => {
    writeSimpleTrace(3);
    const reader = TraceReader.fromFile(tracePath);

    const cp = reader.checkpoints[1];
    expect(cp).toBeInstanceOf(Checkpoint);
    expect(cp.stack.stack[0].locals.x).toBe(1);
    expect(cp.stack.stack[0].step).toBe(1);
    expect(cp.nodeId).toBe("start");
  });

  it("roundtrips complex checkpoint data", () => {
    const writer = new TraceWriter(tracePath, "test.agency");

    const cp = new Checkpoint({
      id: 0,
      nodeId: "process",
      moduleId: "main.agency",
      scopeName: "processNode",
      stepPath: "3",
      stack: {
        stack: [
          { args: { name: "Alice" }, locals: { result: "hello" }, threads: null, step: 3 },
          { args: {}, locals: {}, threads: null, step: 0 },
        ],
        mode: "serialize",
        other: { foo: "bar" },
        deserializeStackLength: 0,
        nodesTraversed: ["start", "process"],
      },
      globals: {
        store: {
          "main.agency": { greeting: "hi" },
          "helpers.agency": { cache: [1, 2, 3] },
        },
        initializedModules: ["main.agency", "helpers.agency"],
      },
    });
    writer.writeCheckpoint(cp);
    writer.close();

    const reader = TraceReader.fromFile(tracePath);
    const reconstructed = reader.checkpoints[0];
    expect(reconstructed.stack.stack).toEqual(cp.stack.stack);
    expect(reconstructed.stack.mode).toBe("serialize");
    expect(reconstructed.stack.nodesTraversed).toEqual(["start", "process"]);
    expect(reconstructed.globals.store).toEqual(cp.globals.store);
    expect(reconstructed.globals.initializedModules).toEqual(["main.agency", "helpers.agency"]);
    expect(reconstructed.nodeId).toBe("process");
  });

  it("detects incomplete traces (no footer)", () => {
    const fd = fs.openSync(tracePath, "w");
    fs.writeSync(fd, JSON.stringify({
      type: "header", version: 1, program: "test.agency",
      timestamp: new Date().toISOString(), config: { hashAlgorithm: "sha256" },
    }) + "\n");
    fs.closeSync(fd);

    const reader = TraceReader.fromFile(tracePath);
    expect(reader.checkpoints).toHaveLength(0);
    expect(reader.footer).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run lib/runtime/trace/traceWriter.test.ts lib/runtime/trace/traceReader.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 4: Implement TraceWriter**

The constructor takes the file path and program name, and writes the header immediately. The user just calls `writeCheckpoint()` and `close()`.

```typescript
import * as fs from "fs";
import { ContentAddressableStore } from "./contentAddressableStore.js";
import type { TraceManifest, TraceFooter } from "./types.js";
import type { Checkpoint } from "../state/checkpointStore.js";
import { CHECKPOINT_SCHEMA } from "./types.js";

export class TraceWriter {
  private fd: number;
  private store: ContentAddressableStore;
  private checkpointCount = 0;
  private chunkCount = 0;

  constructor(filePath: string, program: string) {
    this.fd = fs.openSync(filePath, "w");
    this.store = new ContentAddressableStore();
    this.writeLine({
      type: "header",
      version: 1,
      program,
      timestamp: new Date().toISOString(),
      config: { hashAlgorithm: "sha256" },
    });
  }

  writeCheckpoint(checkpoint: Checkpoint): void {
    const json = checkpoint.toJSON();
    const { record, chunks } = this.store.process(json, CHECKPOINT_SCHEMA);

    // Write new chunks first (streaming protocol: chunks before manifest)
    for (const chunk of chunks) {
      this.writeLine({ type: "chunk", hash: chunk.hash, data: chunk.data });
      this.chunkCount++;
    }

    // Write manifest — the CAS-processed checkpoint + type discriminator
    const manifest: TraceManifest = { type: "manifest", ...record };
    this.writeLine(manifest);
    this.checkpointCount++;
  }

  close(): void {
    const footer: TraceFooter = {
      type: "footer",
      checkpointCount: this.checkpointCount,
      chunkCount: this.chunkCount,
      timestamp: new Date().toISOString(),
    };
    this.writeLine(footer);
    fs.closeSync(this.fd);
  }

  private writeLine(obj: any): void {
    fs.writeSync(this.fd, JSON.stringify(obj) + "\n");
  }
}
```

- [ ] **Step 5: Implement TraceReader**

The reader's public API mirrors the writer: `header`, `footer`, and `checkpoints`. Manifests are an internal detail — the reader reconstructs all checkpoints on load and exposes them as `Checkpoint[]`.

```typescript
import * as fs from "fs";
import { ContentAddressableStore } from "./contentAddressableStore.js";
import type { TraceHeader, TraceManifest, TraceFooter, CheckpointJSON } from "./types.js";
import { CHECKPOINT_SCHEMA } from "./types.js";
import { Checkpoint } from "../state/checkpointStore.js";

export class TraceReader {
  readonly header: TraceHeader;
  readonly footer: TraceFooter | null;
  readonly checkpoints: Checkpoint[];

  private constructor(
    header: TraceHeader,
    footer: TraceFooter | null,
    checkpoints: Checkpoint[],
  ) {
    this.header = header;
    this.footer = footer;
    this.checkpoints = checkpoints;
  }

  static fromFile(filePath: string): TraceReader {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").map((line) => JSON.parse(line));

    if (lines.length === 0 || lines[0].type !== "header") {
      throw new Error("Invalid trace file: missing header");
    }

    const header = lines[0] as TraceHeader;
    const store = new ContentAddressableStore();
    const manifests: TraceManifest[] = [];
    let footer: TraceFooter | null = null;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      switch (line.type) {
        case "chunk":
          store.loadChunks({ [line.hash]: line.data });
          break;
        case "manifest":
          manifests.push(line as TraceManifest);
          break;
        case "footer":
          footer = line as TraceFooter;
          break;
      }
    }

    // Reconstruct all checkpoints from manifests
    const checkpoints = manifests.map((manifest) => {
      const { type, ...casProcessed } = manifest;
      const json = store.reconstruct<CheckpointJSON>(casProcessed, CHECKPOINT_SCHEMA);
      return Checkpoint.fromJSON(json)!;
    });

    return new TraceReader(header, footer, checkpoints);
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/trace/traceWriter.test.ts lib/runtime/trace/traceReader.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/trace/traceWriter.ts lib/runtime/trace/traceReader.ts lib/runtime/trace/traceWriter.test.ts lib/runtime/trace/traceReader.test.ts lib/runtime/trace/contentAddressableStore.ts
git commit -m "feat(trace): add TraceWriter and TraceReader using ContentAddressableStore"
```

---

### Task 5: Config and RuntimeContext Changes

**Files:**
- Modify: `lib/config.ts:119` — Add `trace` and `traceFile` config options
- Modify: `lib/runtime/state/context.ts:18-30` — Add `traceWriter` field
- Modify: `lib/runtime/state/context.ts:84-106` — Share `traceWriter` in `createExecutionContext`
- Modify: `lib/runtime/state/context.ts:152-160` — Null out `traceWriter` in `cleanup()`

- [ ] **Step 1: Add config options to `AgencyConfig`**

In `lib/config.ts`, add after the `checkpoints` field (line 131):

```typescript
  /** Enable execution tracing — writes checkpoints to a .agencytrace file */
  trace?: boolean;

  /** Custom path for the trace file (default: <program>.agencytrace) */
  traceFile?: string;
```

- [ ] **Step 2: Add `traceWriter` to `RuntimeContext`**

In `lib/runtime/state/context.ts`:

Add import at top:
```typescript
import type { TraceWriter } from "../trace/traceWriter.js";
```

Add field after `debuggerState` (line 30):
```typescript
traceWriter: TraceWriter | null;
```

Initialize in constructor after `this.debuggerState = null;` (line 69):
```typescript
this.traceWriter = null;
```

In `createExecutionContext` after `execCtx.debuggerState = this.debuggerState;` (line 100):
```typescript
execCtx.traceWriter = this.traceWriter;
```

In `cleanup()` after `this.handlers = null as any;` (line 159):
```typescript
this.traceWriter = null;
```

- [ ] **Step 3: Run existing tests to verify nothing breaks**

Run: `pnpm vitest run lib/runtime/`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add lib/config.ts lib/runtime/state/context.ts
git commit -m "feat(trace): add trace config options and traceWriter to RuntimeContext"
```

---

### Task 6: Builder Condition Change

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts:2273` — Expand debugger condition
- Modify: `lib/backends/typescriptBuilder.ts:1987` — Expand processDebuggerStatement condition

- [ ] **Step 1: Change `insertDebugSteps` condition**

In `lib/backends/typescriptBuilder.ts`, line 2273, change:
```typescript
if (!this.agencyConfig?.debugger) return body;
```
to:
```typescript
if (!this.agencyConfig?.debugger && !this.agencyConfig?.trace) return body;
```

- [ ] **Step 2: Change `processDebuggerStatement` condition**

In `lib/backends/typescriptBuilder.ts`, line 1987, change:
```typescript
if (!this.agencyConfig?.debugger)
```
to:
```typescript
if (!this.agencyConfig?.debugger && !this.agencyConfig?.trace)
```

- [ ] **Step 3: Run existing builder tests to verify nothing breaks**

Run: `pnpm vitest run lib/backends/`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add lib/backends/typescriptBuilder.ts
git commit -m "feat(trace): expand debugStep insertion to include trace config"
```

---

### Task 7: debugStep Trace Integration

**Files:**
- Modify: `lib/runtime/debugger.ts:6-84` — Add trace write path

- [ ] **Step 1: Write failing test**

Create or extend `lib/runtime/debugger.test.ts` with trace-specific tests. Check existing test file structure first — see `lib/runtime/debugger.test.ts`. Add tests that verify `debugStep` writes to a `TraceWriter` when one is set on the context.

```typescript
// Add to existing debugger.test.ts
import { TraceWriter } from "./trace/traceWriter.js";
import { TraceReader } from "./trace/traceReader.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("debugStep with tracing", () => {
  let tmpDir: string;
  let tracePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-debug-test-"));
    tracePath = path.join(tmpDir, "test.agencytrace");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a checkpoint to the trace when traceWriter is set", async () => {
    // Set up a RuntimeContext with a traceWriter but no debuggerState
    // Create a minimal context, set traceWriter, call debugStep, verify trace has a checkpoint
    // The exact setup depends on what helpers exist in the existing test file.
    // Key assertion: after calling debugStep, the trace file should contain a manifest.
  });

  it("skips trace write when _skipNextCheckpoint is true", async () => {
    // Same setup but set ctx._skipNextCheckpoint = true before calling debugStep
    // Verify no manifest was written to the trace
  });

  it("writes to trace AND creates rolling checkpoint when both debugger and trace are active", async () => {
    // Set both ctx.debuggerState and ctx.traceWriter
    // Verify both the debugger rolling checkpoint and the trace checkpoint are created
  });
});
```

Note: The exact test implementation will depend on the test helpers and mocking patterns already established in `lib/runtime/debugger.test.ts`. Read that file before writing these tests and follow its patterns.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/runtime/debugger.test.ts`
Expected: New tests FAIL

- [ ] **Step 3: Modify `debugStep` to write to trace**

In `lib/runtime/debugger.ts`, add the trace write path. The trace write should happen early in the function, after the `interruptData` cleanup but before the debugger-specific logic. It must respect `_skipNextCheckpoint`.

```typescript
import type { Interrupt } from "./interrupts.js";
import { createDebugInterrupt } from "./interrupts.js";
import type { RuntimeContext } from "./state/context.js";
import type { InternalFunctionState } from "./types.js";
import { Checkpoint } from "./state/checkpointStore.js";

export async function debugStep(
  ctx: RuntimeContext<any>,
  state: InternalFunctionState,
  info: {
    moduleId: string;
    scopeName: string;
    stepPath: string;
    label: string | null;
    nodeContext: boolean;
  },
): Promise<Interrupt | undefined> {
  if (state.interruptData?.interruptResponse) {
    state.interruptData.interruptResponse = undefined;
  }

  // Trace write path — independent of debugger
  if (ctx.traceWriter && !ctx._skipNextCheckpoint) {
    const nodeId = ctx.stateStack.currentNodeId();
    if (nodeId) {
      // Create a Checkpoint and pass it directly to the writer
      const cp = new Checkpoint({
        stack: ctx.stateStack.toJSON(),
        globals: ctx.globals.toJSON(),
        nodeId,
        moduleId: info.moduleId,
        scopeName: info.scopeName,
        stepPath: info.stepPath,
      });
      ctx.traceWriter.writeCheckpoint(cp);
    }
  }

  const dbg = ctx.debuggerState;
  if (!dbg) return undefined;

  // ... rest of existing debugger logic unchanged
```

Note: The `Checkpoint` constructor auto-assigns an incrementing ID via `globalCheckpointCounter` when no `id` is provided, so we don't need a separate ID generator on the writer.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/runtime/debugger.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add lib/runtime/debugger.ts lib/runtime/trace/traceWriter.ts
git commit -m "feat(trace): integrate trace writing into debugStep"
```

---

### Task 8: CLI and Builder Integration for Trace Setup

**Important context:** The `run` command in Agency compiles `.agency` to `.js` and then spawns a **separate Node.js process** to execute it. The CLI never has access to the `RuntimeContext` at execution time. Therefore, `TraceWriter` setup must be injected by the builder into the generated TypeScript code, using a Mustache template (following the same approach as other generated code blocks).

**Files:**
- Modify: `scripts/agency.ts:64-69` — Add `--trace` option to `run` command
- Modify: `lib/cli/commands.ts:240-277` — Pass trace file path via env var
- Create: `lib/templates/backends/typescriptGenerator/traceSetup.mustache` — Template for trace writer setup
- Modify: `lib/backends/typescriptBuilder.ts:2410` — Render trace setup template into generated code
- Modify: `lib/runtime/index.ts` — Export TraceWriter

- [ ] **Step 1: Add `--trace` option to the `run` command**

In `scripts/agency.ts`, after the existing options for the `run` command (around line 68), add:

```typescript
.option("--trace [file]", "Write execution trace to file (default: <input>.agencytrace)")
```

Update the action handler to set `config.trace` and `config.traceFile` before calling `compile`/`run`. The builder reads these at compile time and bakes the trace setup into the generated code — no env vars needed.

```typescript
if (options.trace) {
  config.trace = true;
  if (typeof options.trace === "string" && options.trace.endsWith(".agencytrace")) {
    config.traceFile = options.trace;
  }
  // Default trace file path if not specified
  if (!config.traceFile) {
    config.traceFile = input.replace(/\.agency$/, ".agencytrace");
  }
}
```

- [ ] **Step 2: Create the trace setup Mustache template**

Create `lib/templates/backends/typescriptGenerator/traceSetup.mustache`:

```mustache
import { TraceWriter } from "agency-lang/runtime";
const __traceWriter = new TraceWriter({{{traceFile:string}}}, {{{programId:string}}});
__globalCtx.traceWriter = __traceWriter;
process.on("exit", () => { try { __traceWriter.close(); } catch {} });
```

Then run `pnpm run templates` to compile the Mustache template to a TypeScript render function.

- [ ] **Step 3: Render trace setup in the builder**

In `lib/backends/typescriptBuilder.ts`, import the compiled template and render it after the audit log setup block (around line 2420):

```typescript
import renderTraceSetup from "@/templates/backends/typescriptGenerator/traceSetup.js";

// Inside the method, after the audit log block:
if (this.agencyConfig.trace && this.agencyConfig.traceFile) {
  runtimeCtx = ts.statements([
    runtimeCtx,
    ts.raw(renderTraceSetup.default({
      traceFile: JSON.stringify(this.agencyConfig.traceFile),
      programId: JSON.stringify(this.programInfo.mainModuleId || "unknown"),
    })),
  ]);
}
```

- [ ] **Step 4: Export TraceWriter from runtime index**

In `lib/runtime/index.ts`, add:

```typescript
export { TraceWriter } from "./trace/traceWriter.js";
```

- [ ] **Step 5: Build and test manually**

Run: `pnpm run templates && pnpm run build && pnpm run agency run --trace examples/simple.agency` (or another simple example that doesn't require LLM calls)
Verify: A `.agencytrace` file is created with header, chunks, manifests, and footer.

- [ ] **Step 6: Commit**

```bash
git add scripts/agency.ts lib/templates/backends/typescriptGenerator/traceSetup.mustache lib/templates/backends/typescriptGenerator/traceSetup.ts lib/backends/typescriptBuilder.ts lib/runtime/index.ts
git commit -m "feat(trace): add --trace CLI flag with builder-injected trace setup"
```

---

### Task 9: Debug Command — Trace and Checkpoint Loading

This task adds `--trace` and `--checkpoint` flags to the debug command and wires up the `TraceReader` so the debugger can step through recorded traces.

**Files:**
- Modify: `scripts/agency.ts:360-367` — Add `--trace` and `--checkpoint` options to `debug` command
- Modify: `lib/cli/debug.ts` — Handle trace replay and checkpoint loading modes

- [ ] **Step 1: Add CLI options to the `debug` command**

In `scripts/agency.ts`, add to the debug command (around line 364):

```typescript
.option("--trace <file>", "Load a trace file for replay")
.option("--checkpoint <file>", "Load a single checkpoint file")
```

- [ ] **Step 2: Update `debug()` to accept and validate the new options**

In `lib/cli/debug.ts`, update the options type and add trace replay support. When `--trace` is provided, the debugger loads the trace via `TraceReader` and steps through the recorded checkpoints rather than executing the program live. Read the existing `DebuggerDriver` API to understand how to feed checkpoints from the trace into the driver's UI.

```typescript
export async function debug(
  config: AgencyConfig,
  inputFile: string,
  options: {
    node?: string;
    rewindSize?: number;
    trace?: string;
    checkpoint?: string;
  } = {},
): Promise<void> {
  if (options.trace) {
    if (!fs.existsSync(options.trace)) {
      console.error(`Error: Trace file not found: ${options.trace}`);
      process.exit(1);
    }
    const reader = TraceReader.fromFile(options.trace);
    console.log(
      `Loaded trace: ${reader.checkpoints.length} checkpoints, ` +
      `${reader.footer ? "complete" : "incomplete (possibly crashed)"}`,
    );
    // TODO: Wire reader into DebuggerDriver for replay mode
    // For now, validate and print info
    return;
  }

  if (options.checkpoint) {
    if (!fs.existsSync(options.checkpoint)) {
      console.error(`Error: Checkpoint file not found: ${options.checkpoint}`);
      process.exit(1);
    }
    // TODO: Load checkpoint, deserialize, start live debugging from that point
    console.log(`Loaded checkpoint from: ${options.checkpoint}`);
    return;
  }

  // ... existing debug logic
```

- [ ] **Step 3: Commit**

```bash
git add scripts/agency.ts lib/cli/debug.ts
git commit -m "feat(trace): add --trace and --checkpoint flags to debug command"
```

---

### Task 10: Integration Test — End-to-End Trace with Debugger

This is the real integration test: compile an agency file with tracing enabled, run it, produce a trace file, then load the trace into the debugger test infrastructure and step through it to verify all checkpoints have correct state.

**Files:**
- Create: `tests/debugger/trace-test.agency` — Simple test program for trace integration
- Create: `lib/debugger/trace.test.ts` — Integration test using debugger test infrastructure

Reference: `lib/debugger/driver.test.ts` contains `TestDebuggerIO`, `makeDriver`, and patterns for compiling and stepping through agency programs. Follow these patterns.

- [ ] **Step 1: Create a simple agency test fixture**

Create `tests/debugger/trace-test.agency` — a minimal program that exercises variable assignment and multiple steps (no LLM calls needed):

```
node main() {
  a = 10
  b = 20
  c = a + b
  return c
}
```

- [ ] **Step 2: Write the integration test**

Create `lib/debugger/trace.test.ts`. This test:
1. Compiles the agency file with `{ trace: true, debugger: true }` config
2. Imports the compiled module
3. Runs it through the debugger (stepping through all steps)
4. Reads the generated trace file
5. Verifies the trace has the correct number of checkpoints
6. Steps through the trace checkpoints and verifies state at each step (locals, globals, step paths)

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../cli/commands.js";
import { getTestDir } from "../importPaths.js";
import { TraceReader } from "../runtime/trace/traceReader.js";
import { TraceWriter } from "../runtime/trace/traceWriter.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import { DebuggerDriver } from "./driver.js";
import type { DebuggerCommand, DebuggerIO } from "./types.js";
import { UIState } from "./uiState.js";
import type { FunctionParameter } from "../types.js";
import { isInterrupt } from "../runtime/interrupts.js";

// Reuse TestDebuggerIO from driver.test.ts pattern
class TestDebuggerIO implements DebuggerIO {
  state: UIState = new UIState();
  private commands: DebuggerCommand[];
  private commandIndex = 0;
  renderCalls: Checkpoint[] = [];

  constructor(commands: DebuggerCommand[]) {
    this.commands = commands;
  }

  async render(_checkpoint?: Checkpoint): Promise<void> {
    if (_checkpoint) {
      const checkpoint = Checkpoint.fromJSON(_checkpoint);
      if (checkpoint) this.renderCalls.push(checkpoint);
    }
  }

  async waitForCommand(): Promise<DebuggerCommand> {
    return this.commands[this.commandIndex++] ?? { type: "quit" };
  }

  async showRewindSelector(_checkpoints: Checkpoint[]): Promise<number | null> { return null; }
  async promptForNodeArgs(_parameters: FunctionParameter[]): Promise<unknown[]> { return []; }
  async promptForInput(_prompt: string): Promise<string> { return ""; }
  appendStdout(_text: string): void { }
  renderActivityOnly(): void { }
  destroy(): void { }
}

const fixtureDir = path.join(getTestDir(), "debugger");
const traceTestAgency = path.join(fixtureDir, "trace-test.agency");
const traceTestCompiled = path.join(fixtureDir, "trace-test.ts");
const traceFile = path.join(fixtureDir, "trace-test.agencytrace");

describe("Trace integration with debugger", () => {
  let mod: any;

  beforeAll(async () => {
    // Compile with both debugger and trace enabled
    compile({ debugger: true, trace: true, traceFile }, traceTestAgency, traceTestCompiled, { ts: true });
    mod = await import(traceTestCompiled);
  });

  afterAll(() => {
    for (const f of [traceTestCompiled, traceFile]) {
      try { fs.unlinkSync(f); } catch { }
    }
  });

  it("produces a trace file when running with trace enabled", async () => {
    // Run the program to completion through the debugger
    const commands: DebuggerCommand[] = Array(20).fill({ type: "step" });
    const testUI = new TestDebuggerIO(commands);

    const driver = new DebuggerDriver({
      mod: {
        approveInterrupt: mod.approveInterrupt,
        respondToInterrupt: mod.respondToInterrupt,
        rewindFrom: mod.rewindFrom,
        __setDebugger: mod.__setDebugger,
        __getCheckpoints: mod.__getCheckpoints,
      },
      sourceMap: mod.__sourceMap ?? {},
      rewindSize: 30,
      ui: testUI,
    });
    mod.__setDebugger(driver.debuggerState);

    const callbacks = driver.getCallbacks();
    const initialResult = await mod.main({ callbacks });
    expect(isInterrupt(initialResult.data)).toBe(true);
    await driver.run(initialResult, { interceptConsole: false });

    // Verify trace file was created
    expect(fs.existsSync(traceFile)).toBe(true);

    // Read and validate the trace
    const reader = TraceReader.fromFile(traceFile);
    expect(reader.checkpoints.length).toBeGreaterThan(0);

    // Verify each checkpoint has valid state
    for (const cp of reader.checkpoints) {
      expect(cp).toBeInstanceOf(Checkpoint);
      expect(cp.stack.stack.length).toBeGreaterThan(0);
      expect(cp.nodeId).toBe("main");
    }

    // Verify state progresses: later checkpoints should have more locals set
    const firstCp = reader.checkpoints[0];
    const lastCp = reader.checkpoints[reader.checkpoints.length - 1];
    const firstLocals = firstCp.stack.stack[firstCp.stack.stack.length - 1].locals;
    const lastLocals = lastCp.stack.stack[lastCp.stack.stack.length - 1].locals;

    // The last checkpoint should have c = 30 (a=10, b=20, c=a+b)
    expect(lastLocals.c).toBe(30);
    // The first checkpoint likely doesn't have c yet
    expect(Object.keys(lastLocals).length).toBeGreaterThanOrEqual(Object.keys(firstLocals).length);
  });

  it("deduplicates globals across trace checkpoints", async () => {
    // The trace from the previous test should have globals written once
    // since they don't change during execution
    const content = fs.readFileSync(traceFile, "utf-8");
    const lines = content.trim().split("\n").map((l) => JSON.parse(l));
    const chunks = lines.filter((l) => l.type === "chunk");
    const manifestLines = lines.filter((l) => l.type === "manifest");

    // With deduplication, should have far fewer chunks than manifests * 2
    // (because globals are stored once)
    expect(chunks.length).toBeLessThan(manifestLines.length * 2);
  });
});
```

Note: The exact test may need adjustments depending on how the `TraceWriter` setup works in the compiled module when `trace: true` is set. The compiled module should set up `__globalCtx.traceWriter` automatically via the generated trace setup code from the mustache template. Read the compiled output to verify this. If the trace writer isn't being set up correctly in test mode (because `process.env.AGENCY_TRACE_FILE` isn't set), you may need to set it in the test's `beforeAll`.

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm vitest run lib/debugger/trace.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add tests/debugger/trace-test.agency lib/debugger/trace.test.ts
git commit -m "test(trace): add end-to-end trace integration test with debugger stepping"
```
