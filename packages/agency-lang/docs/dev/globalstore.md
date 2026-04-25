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

When the preprocessor marks a variable assignment as `scope: "global"`, the builder emits a `__ctx.globals.set()` call instead of a normal assignment:

```typescript
// Agency source:
// counter = 0
//
// Generated:
__ctx.globals.set("foo.agency", "counter", 0);
```

This is produced by the `ts.globalSet(moduleId, varName, value)` IR builder, which emits `__ctx.globals.set(moduleId, varName, value)`.

### Reading globals

When the preprocessor marks a variable reference as `scope: "global"`, the pretty printer emits a `__ctx.globals.get()` call:

```typescript
// Agency source:
// return counter
//
// Generated:
return __ctx.globals.get("foo.agency", "counter");
```

This is produced by the `ts.scopedVar(name, "global", moduleId)` IR node, which the pretty printer renders as `__ctx.globals.get(moduleId, name)`.

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

  // Create a new store with zeroed token stats
  static withTokenStats(): GlobalStore;

  // The reserved module ID for internal runtime data
  static readonly INTERNAL_MODULE: "__internal";
}
```

## Where GlobalStore lives at runtime

The `GlobalStore` instance is held on the `RuntimeContext` as `ctx.globals`. The `RuntimeContext` is created once per execution and threaded through all nodes and functions. In the generated code, the runtime context is accessible as `__ctx`, so all global variable access goes through `__ctx.globals`.
