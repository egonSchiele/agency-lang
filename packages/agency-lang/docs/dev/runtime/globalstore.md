# GlobalStore

## Overview

`GlobalStore` (`lib/runtime/state/globalStore.ts`) manages global variables at runtime. Every Agency file (module) can have top-level variable assignments that live outside any node or function. These are "global" to that module. The `GlobalStore` provides a namespaced key-value store so that different modules' globals don't collide, and so that global state can be serialized and restored for interrupt resumption.

## Why GlobalStore exists

Previously, global variables were stored directly on the `StateStack`. This caused problems:

1. **Module isolation** — When multiple Agency files are compiled and linked together, their globals need to be kept separate. A variable `x` in `foo.agency` shouldn't conflict with a variable `x` in `bar.agency`.
2. **Serialization for interrupts** — When an interrupt pauses execution, all state (including globals) must be captured as JSON. The `GlobalStore` provides `toJSON()` and `fromJSON()` for this.
3. **Initialization tracking** — On interrupt resume, the runtime needs to know whether a module's globals have already been initialized, to avoid re-running initialization expressions and overwriting restored values.

## How it works

### Data structure

The store is a two-level nested object: `Record<string, Record<string, any>>`. The outer key is the **module ID** (e.g., `"foo.agency"`), and the inner key is the **variable name**.

```typescript
// Conceptual layout
{
  "foo.agency": { "counter": 0, "name": "Alice" },
  "bar.agency": { "items": [] }
}
```

### Module IDs

Each compiled Agency file gets a unique module ID (typically the filename, like `"foo.agency"`). This ID is baked into the generated code at compile time by the `TypeScriptBuilder`, which receives it as a constructor argument. The same module ID is used by both the defining module and any module that imports from it, ensuring they read/write the same namespace.

### The `__internal` module

The `GlobalStore` reserves a special module ID, `GlobalStore.INTERNAL_MODULE` (`"__internal"`), for runtime bookkeeping. Currently this stores token usage statistics (`__tokenStats`), which track input/output token counts and costs across all LLM calls in a single execution. The static factory `GlobalStore.withTokenStats()` creates a new store pre-populated with zeroed-out token stats.

## Generated code patterns

### Writing globals

When the preprocessor marks a variable assignment as `scope: "global"`, the builder emits a `__globals()!.set()` call instead of a normal assignment:

```typescript
// Agency source:
// counter = 0
//
// Generated:
__globals()!.set("foo.agency", "counter", 0);
```

This is produced by the `ts.globalSet(moduleId, varName, value)` IR builder, which emits `__globals()!.set(moduleId, varName, value)`. `__globals()` is an AsyncLocalStorage accessor that returns the GlobalStore on the active ALS frame (see [async-context.md](./async-context.md)). The `!` is a non-null assertion — generated user code always runs inside a frame.

### Reading globals

When the preprocessor marks a variable reference as `scope: "global"`, the pretty printer emits a `__globals()!.get()` call:

```typescript
// Agency source:
// return counter
//
// Generated:
return __globals()!.get("foo.agency", "counter");
```

This is produced by the `ts.scopedVar(name, "global", moduleId)` IR node, which the pretty printer renders as `__globals()!.get(moduleId, name)`.

### Top-level reads (`scope: "topLevel"`)

There's one exception: eager tool-description docstrings that run at module-load time before any ALS frame is installed. Those emit `__globalCtx.globals.get(...)` against the bootstrap context directly — the `__globals()` accessor would throw a "no active frame" error in that context.

### `__initializeGlobals` writes against the param

Inside `__initializeGlobals(__ctx)` itself, top-level global-assignment statements emit `__ctx.globals.set(...)` (using the function param, not the ALS accessor) so writes land deterministically on the canonical store regardless of any outer per-branch frame that might exist when the function happens to be invoked.

### Global initialization

All top-level global assignments are collected into a generated `__initializeGlobals(__ctx)` function. This function runs all the initialization expressions and then marks the module as initialized:

```typescript
function __initializeGlobals(__ctx) {
  __ctx.globals.set("foo.agency", "counter", 0);
  __ctx.globals.set("foo.agency", "name", "Alice");
  __ctx.globals.markInitialized("foo.agency");
}
```

Every node and function in the generated code checks whether its module has been initialized before running:

```typescript
if (!__ctx.globals.isInitialized("foo.agency")) {
  __initializeGlobals(__ctx);
}
```

This ensures globals are initialized exactly once per execution, regardless of which node or function runs first.

### Interrupt resume

When an interrupt fires, the `GlobalStore` is serialized via `toJSON()` and included in the `InterruptState`. On resume, `GlobalStore.fromJSON()` restores it. Because the `isInitialized` flag is part of the serialized state, the restored store already has it set, so `__initializeGlobals` won't run again — preventing restored global values from being overwritten by their original initialization expressions.

## API

```typescript
class GlobalStore {
  // Read a global variable
  get(moduleId: string, varName: string): any;

  // Write a global variable
  set(moduleId: string, varName: string, value: any): void;

  // Check if a module's globals have been initialized
  isInitialized(moduleId: string): boolean;

  // Mark a module as initialized (called at end of __initializeGlobals)
  markInitialized(moduleId: string): void;

  // Serialize to JSON (for interrupt state capture)
  toJSON(): GlobalStoreJSON;

  // Deserialize from JSON (for interrupt resume)
  static fromJSON(json: GlobalStoreJSON): GlobalStore;

  // Deep copy via toJSON/fromJSON round-trip (used for per-branch isolation)
  clone(): GlobalStore;

  // Create a new store with zeroed token stats
  static withTokenStats(): GlobalStore;

  // The reserved module ID for internal runtime data
  static readonly INTERNAL_MODULE: "__internal";
}
```

## Where GlobalStore lives at runtime

The canonical `GlobalStore` instance is held on the `RuntimeContext` as `ctx.globals`. The `RuntimeContext` is created once per execution and threaded through all nodes and functions.

At runtime, generated code reads/writes the `GlobalStore` on the **active ALS frame** via `__globals()` — NOT directly from `ctx.globals`. The frame's `globals` slot points at `ctx.globals` in most code paths (so behavior is identical to reading `ctx.globals`), but is replaced by a per-branch clone inside fork/parallel/race branches (see below).

Stdlib TS helpers that need the `GlobalStore` (or any other runtime field) read from the ALS frame via `getRuntimeContext()` instead of taking it as a parameter — see [async-context.md](./async-context.md).

## Per-branch isolation

Each branch of a user-facing concurrency primitive (`fork`, `parallel`, `race`) gets its own snapshot of the parent's GlobalStore by default. The mechanism:

1. **At fork time**, `runInBranchAlsFrame` (in `lib/runtime/runBatch.ts`) installs a new ALS frame for the branch body. The frame's `globals` slot is seeded with `parent.globals.clone()` — a fresh `GlobalStore` round-tripped through `toJSON`/`fromJSON` so Maps, Sets, and Dates copy correctly. `initializedModules` is preserved so `__initializeGlobals` is a no-op in branches.

2. **During branch execution**, the branch body reads and writes its own clone via `__globals()`. Sibling branches and the parent are invisible — writes only land on the branch's local copy.

3. **At join time**, the branch's GlobalStore is discarded. Only branch return values cross the join boundary.

### Interrupt resume

When an interrupt fires inside a branch body, `runInBranchAlsFrame`'s capture-on-return wrapper snapshots the branch's GlobalStore onto `BranchState.globalsJSON` before the interrupt propagates up. The snapshot rides along through the normal `BranchStateJSON` serialization path. On resume, `runInBranchAlsFrame` checks for an existing `globalsJSON` on the branch and uses `GlobalStore.fromJSON()` to restore it instead of cloning fresh from the parent. This ensures any global writes a branch made before the interrupt are still visible after resume.

### `shared: true` opt-out

Users can opt back into pointer-sharing the parent's GlobalStore with the `shared: true` named argument:

```ts
parallel(shared: true) { ... }
fork(items, shared: true) as item { ... }
race(items, shared: true) as item { ... }
```

When set, `runInBranchAlsFrame` skips the clone and seeds the branch's frame with `parent.globals` directly. Writes in the branch land on the parent's store; siblings see them; the parent observes them after join. Use for cooperative-worker patterns (shared todo lists, progress meters, dedup caches).

### Stdlib tool dispatch

`runPrompt`'s tool-dispatch loop uses `runBatch` internally to run multiple tool calls per LLM round, but those branches are NOT a user-facing concurrency primitive — tools are conceptually sequential function calls and any global state they touch (counters, retry budgets, dedup caches) should persist across calls. The runtime sets both `shareGlobals: true` and `shareThreads: true` for that path via `promptRunner.ts`. The `shareGlobals: true` part matches what user `shared: true` does for globals; the `shareThreads: true` part is additionally needed so parallel tool calls all write into the same active thread (whereas user `shared: true` keeps threads branch-local).
