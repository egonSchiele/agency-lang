# Global Variable Initialization

## The Problem

When a user writes top-level code that calls a function, like:

```agency
contents = read("README.md")

node main() {
  print(contents)
}
```

The compiled output places that assignment inside `__initializeGlobals`, a function that runs outside any graph node context. This causes several issues:

1. **esbuild error**: `__initializeGlobals` wasn't `async`, but function calls are `await`ed. esbuild rejects `await` outside an async function.
2. **`__state` not in scope**: Function call configs reference `__state?.interruptData`, but `__state` doesn't exist inside `__initializeGlobals`.
3. **Checkpoint creation fails**: stdlib functions like `read()`, `fetch()`, and `fetchJSON()` create checkpoints internally. Checkpoint creation requires a node ID from the state stack (`ctx.stateStack.currentNodeId()`), which is `undefined` outside a graph node. The node ID is used for rewind — it tells `graph.run()` which node to restart from.
4. **No debugger support**: `__initializeGlobals` isn't processed through `processBodyAsParts`, so it has no step blocks or source map entries. The debugger can't step through top-level code.
5. **No interrupt support**: Interrupts require a node context for state serialization and resumption.
6. **No handler support**: Handlers require step machinery from `processBodyAsParts`.

## Approaches Considered

### 1. Minimal fix: make `__initializeGlobals` async + skip checkpoints

Make `__initializeGlobals` async, add a dummy `const __state = {};` for the interruptData reference, and silently skip checkpoint creation when there's no node context (return -1 from `CheckpointStore.create`).

**Pros:**
- Extremely simple — 4 small changes across 3 files
- No new concepts, no architectural changes
- Cross-module init and tool calls work (functions still call `__initializeGlobals`)

**Cons:**
- No debugger stepping through top-level code
- No rewind support for top-level code (checkpoints silently skipped)
- No interrupt or handler support at top level
- `const __state = {};` is a hack

**This is what we went with** (see "Current State" below).

### 2. Explicit `initialize` block (new syntax)

Add a new `initialize { ... }` keyword/block to the language. All variables inside are implicitly global. The block compiles to a graph node called `__initialize`.

```agency
initialize {
  contents = read("README.md")
}

node main() {
  print(contents)
}
```

**Pros:**
- Explicit — users know what's happening
- Compiles to a real graph node, so debugger, checkpoints, rewind, interrupts, and handlers all work
- No magic or special cases

**Cons:**
- New AST type, parser, preprocessor changes, walker changes, builder changes — touches many files
- New concept for users to learn
- Scoping exception: variables inside `initialize` are implicitly global, unlike every other block where variables are local
- Doesn't solve cross-module init (imported modules' globals still need `__initializeGlobals`)

A plan was written but has since been removed.

### 3. Implicit `__init` graph node (no new syntax)

The builder automatically detects executable top-level statements and compiles them into an auto-generated `__init` graph node. No new syntax — `contents = read("README.md")` at the top level just works.

**Pros:**
- No new syntax or concepts for users
- Real graph node, so debugger, checkpoints, rewind, interrupts, handlers all work
- Could process through `processBodyAsParts` for full step handling

**Cons — several unsolved challenges:**

1. **Dynamic edge problem.** At compile time, we don't know which node the user will call (`main()` from CLI, or `other()` from TypeScript). The init node needs to transition to the right target, but edges are normally static. Would need `GoToNode` with a dynamic target + `conditionalEdge` from `__init` to all user-defined nodes.

2. **Parameter forwarding.** The init node receives `data` from `runNode`, but that data is meant for the target node. The init node needs to forward params when doing the GoToNode transition.

3. **Unique node names across modules.** Agency requires unique node names. If multiple files each generate an `__init` node, they'd collide. Names need to be scoped to the module, e.g., `__init_foo_agency`.

4. **All entry points must go through `__init`.** Not just the first node — every wrapper function needs to start at `__init` and pass the real target as data.

5. **Cross-module init before tool calls.** When module A imports a tool from module B, module B's globals need to be initialized before the tool runs. Currently `__initializeGlobals` handles this because it's called from every function's setup code. With an init node, tool calls wouldn't go through a node entry point.

6. **Rewind across separate graph runs.** If init nodes run as separate `graph.run()` calls (Approach A for cross-module init), rewinding to a checkpoint created during init would re-run the init but not continue to the target node, because they're separate graph traversals.

A plan was written but has since been removed.

### 4. `FunctionDefinition` instead of graph node

Instead of creating a graph node, create a `FunctionDefinition` AST node for `__initializeGlobals` and inject it into the program. The existing pipeline (`processFunctionDefinition` → `processBodyAsParts`) would handle it, giving debugger support and source maps for free.

**Pros:**
- Debugger stepping works (via `processBodyAsParts` step blocks + source maps)
- Reuses existing function processing pipeline — minimal new code
- Cross-module init and tool calls still work (functions call `__initializeGlobals`)

**Cons:**
- Checkpoints still fail — functions don't set a node ID, so `currentNodeId()` is undefined. The node ID on a checkpoint is specifically "which graph node to restart from during rewind," and a function isn't a graph node. Setting a fake node ID would cause rewind to try `graph.run("__initializeGlobals")`, which would fail because it's not registered as a graph node.
- No interrupt or handler support (same as minimal fix)
- Self-referential problem: `processFunctionDefinition` injects a call to `__initializeGlobals` at the top of every function. If `__initializeGlobals` itself is processed this way, it would call itself recursively. Would need a special case to skip.

### 5. Disallow function calls in global scope entirely

Force users to initialize globals inside nodes. Top-level code is limited to simple expressions (literals, arithmetic). Function calls at the top level produce a compile error.

**Pros:**
- No runtime changes needed
- Clear, simple rule
- All runtime machinery works because code is always inside nodes

**Cons:**
- Less ergonomic — users must restructure code
- Splits declaration from initialization

## Current State

We went with **Approach 1 (minimal fix)** as a pragmatic starting point. The changes are:

1. `__initializeGlobals` is marked `{ async: true }` in the builder (`lib/backends/typescriptBuilder.ts`)
2. `const __state = {};` is added inside `__initializeGlobals` so `__state?.interruptData` resolves to `undefined`
3. `initializeGlobals` type in `runNode` accepts `void | Promise<void>` and the call is `await`ed (`lib/runtime/node.ts`)
4. `CheckpointStore.create` returns -1 when `currentNodeId()` is undefined (`lib/runtime/state/checkpointStore.ts`)

**Known limitations:**
- No debugger stepping through top-level code
- No rewind from top-level code
- No interrupts or handlers at top level
- Checkpoint data is lost for top-level function calls (checkpoint ID is -1)
- Some debugger tests fail because they create checkpoints in a mock context without a node ID (the silent -1 return breaks their assertions)

## Future Work

The ideal solution is likely Approach 3 (implicit init node) with the cross-module challenges solved, or Approach 2 (explicit `initialize` block) if we're willing to add new syntax. The key unsolved problem is making init code run in a proper graph node context while also handling cross-module initialization for imported tools/functions.
