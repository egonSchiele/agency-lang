# AgencyFunction Runtime Class Design

## Overview

Introduce an `AgencyFunction` runtime class that becomes the canonical representation of every Agency function. This class carries parameter metadata, tool definitions, and serialization info — moving logic that currently lives in the TypeScript builder's compile-time code into a single, testable runtime class. All Agency function calls go through `AgencyFunction.invoke()`, enabling full first-class function support including named args, defaults, variadics, fork, and pipe through dynamic function variables.

## Motivation

The current implementation handles named arguments, default values, variadic parameters, and the pipe operator at compile time in the TypeScript builder. The builder uses `programInfo` to look up parameter lists, reorder named args, pad defaults, and wrap variadics — all before emitting code. This only works when the builder knows the function being called at compile time.

With first-class functions, a variable can hold any function at runtime:

```
def add(a: number, b: number): number { return a + b }
const fn = add
fn(a: 1, b: 2)  // builder doesn't know fn's parameter list
```

The builder can't resolve named args for `fn` because it doesn't know which function `fn` holds. The same problem blocks:

- **Variadic args through variables**: `fn(1, 2, 3)` where `fn` might have a rest parameter
- **Default padding through variables**: `fn(1)` where `fn` has a second param with a default
- **Fork with variables**: `fork(fns) as func { func(2, 2) }` — the builder needs static function names today
- **Pipe with variables**: `value |> fn(?)` — same problem

The fix is to move all parameter resolution to runtime. The `AgencyFunction` class carries the metadata the builder currently looks up, and its `invoke()` method resolves arguments dynamically.

## The `AgencyFunction` Class

### Location

`lib/runtime/agencyFunction.ts`

### Shape

```typescript
type FuncParam = {
  name: string;
  position: number;
  hasDefault: boolean;
  defaultValue: unknown;
  variadic: boolean;
};

type CallType =
  | { type: "positional"; args: unknown[] }
  | { type: "named"; positionalArgs: unknown[]; namedArgs: Record<string, unknown> };

type ToolDefinition = {
  name: string;
  description: string;
  schema: ZodObject<any>;
};

class AgencyFunction {
  readonly __agencyFunction = true;
  readonly name: string;
  readonly module: string;
  readonly params: FuncParam[];
  readonly toolDefinition: ToolDefinition | null;
  private readonly _fn: Function;

  invoke(descriptor: CallType, state?: RuntimeState): Promise<unknown>;
  toJSON(): { name: string; module: string };

  static isAgencyFunction(value: unknown): value is AgencyFunction {
    return typeof value === "object" && value !== null
      && (value as any).__agencyFunction === true;
  }

  static create(
    opts: AgencyFunctionOpts,
    registry: Record<string, AgencyFunction>,
  ): AgencyFunction {
    const fn = new AgencyFunction(opts);
    registry[opts.name] = fn;
    return fn;
  }
}
```

### `invoke()` method

`invoke()` replaces the builder's compile-time `resolveNamedArgs()` and `adjustCallArgs()`. The method is named `invoke()` rather than `call()` to avoid collision with JavaScript's `Function.prototype.call`.

It performs the following steps:

1. **Resolves named args**: For `{ type: "named" }` descriptors, positional args fill parameters left-to-right. Named args then fill remaining parameters by name. It is an error if a named arg targets a position already filled by a positional arg. Same validation rules as today — no duplicates, no unknown names.
2. **Pads defaults**: If fewer args than non-variadic params, inserts `UNSET` (a dedicated singleton object) for params with defaults. The compiled function body checks `param === UNSET ? defaultValue : param`. This avoids the current bug where passing explicit `null` is indistinguishable from an omitted argument.
3. **Wraps variadics**: If the last param is variadic, collects trailing args into an array.
4. **Calls the underlying function**: `this._fn(...resolvedArgs, state)`.

The `UNSET` sentinel is exported from `agencyFunction.ts`:
```typescript
export const UNSET = "UNSET";
```

The `state` parameter replaces the current pattern where the builder constructs a config object (`{ ctx, threads, interruptData, ... }`) at every call site. `AgencyFunction` receives the full state and passes it through.

The state object shape varies by context:
- **Global init scope**: `{ ctx }` only (no threads or interrupt data available)
- **Function/node bodies**: `{ ctx, threads, interruptData, stateStack, isForked }`
- **Checkpoint calls**: adds `{ moduleId, scopeName, stepPath }`
- **LLM tool calls**: `state` may be `undefined` (the function is being called externally)

The builder still constructs the appropriate state object per scope, but does so once per scope rather than at every call site.

### `toJSON()` method

Returns `{ name, module }` for serialization. Used by the `FunctionRefReviver`.

## What the Builder Emits

### Function definitions

Today:
```typescript
async function add(a, b, __state) { ... }
const __addTool = { name: "add", description: "...", schema: z.object({ a: z.number(), b: z.number() }) };
const __addToolParams = ["a", "b"];
// ... later in __toolRegistry ...
add.__functionRef = { name: "add", module: "math.agency" };
```

After:
```typescript
async function __add_impl(a, b, __state) { ... }

const add = AgencyFunction.create({
  name: "add",
  module: "math.agency",
  fn: __add_impl,
  params: [
    { name: "a", position: 0, hasDefault: false, defaultValue: undefined, variadic: false },
    { name: "b", position: 1, hasDefault: false, defaultValue: undefined, variadic: false },
  ],
  toolDefinition: {
    name: "add",
    description: "Adds two numbers",
    schema: z.object({ a: z.number(), b: z.number() }),
  },
}, __toolRegistry);
```

`AgencyFunction.create()` constructs the instance and registers it in `__toolRegistry` under the function's name. This ensures every Agency function is automatically registered — you can't forget to add it to the registry.

### Function calls

Today (positional):
```typescript
await add(1, 2, { ctx: __ctx, threads: __threads, interruptData: __state?.interruptData });
```

After (positional):
```typescript
await add.invoke({ type: "positional", args: [1, 2] }, __state);
```

Today (named args, compile-time resolved):
```typescript
// add(b: 2, a: 1) gets reordered at compile time to:
await add(1, 2, { ctx: __ctx, threads: __threads, interruptData: __state?.interruptData });
```

After (named args, runtime resolved):
```typescript
await add.invoke({ type: "named", positionalArgs: [], namedArgs: { b: 2, a: 1 } }, __state);
```

### TypeScript imports

No change. TS imports are still called directly:
```typescript
await fetch(url);
```

The builder distinguishes Agency vs TS functions at compile time using `isAgencyFunction()`, same as today. The only difference: Agency calls emit `.invoke()`, TS calls emit direct invocation.

### The `__state` parameter

Currently the builder constructs a different config object at different call sites:

- Inside global init: `{ ctx: __ctx }`
- Inside function/node bodies: `{ ctx: __ctx, threads: __threads, interruptData: __state?.interruptData, stateStack: ..., isForked: ... }`
- For checkpoint calls: adds `{ moduleId, scopeName, stepPath }`

After this change, `AgencyFunction.invoke()` receives `__state` directly. The builder still constructs the appropriate state object per scope (see `invoke()` section above for the variations), and construction happens once per scope rather than per call site.

## Tool Registry

Today:
```typescript
const __toolRegistry = {
  add: {
    definition: __addTool,
    handler: { name: "add", params: __addToolParams, execute: add, isBuiltin: false }
  },
  ...
};
```

After:
```typescript
const __toolRegistry: Record<string, AgencyFunction> = {};
// Each AgencyFunction.create() call populates __toolRegistry automatically
```

The `AgencyFunction` instance *is* the tool definition, handler, and metadata. The `uses` directive and LLM tool resolution look up `AgencyFunction` instances directly.

For **locally defined functions**: `AgencyFunction.create()` registers the function under its name automatically.

For **imported functions**: `import { add } from "math.agency"` imports an `AgencyFunction` instance. The importing module registers it with `__toolRegistry[name] = importedFunction`.

For **aliased imports**: `import { add as plus }` — the registry key is `plus`, but `AgencyFunction.name` and `AgencyFunction.module` point to the original. The importing module does `__toolRegistry["plus"] = importedAdd`. Serialization uses the original name/module, not the alias.

For **builtin tools**: Builtin functions (`print`, `read`, etc.) get wrapped in `AgencyFunction` instances with appropriate parameter metadata. Their `_fn` implementations are thin wrappers that accept and ignore the `state` parameter, since builtins don't participate in the interrupt/state machinery.

## Serialization and the `FunctionRefReviver`

The `FunctionRefReviver` is adapted, not replaced. This keeps the reviver pattern consistent with `MapReviver`, `SetReviver`, `DateReviver`, etc.

### Serialization

The `nativeTypeReplacer` detects `AgencyFunction` instances via `AgencyFunction.isAgencyFunction()`, which checks for the `__agencyFunction` brand property. This is more reliable than `instanceof` across module boundaries. The serialized format is unchanged:

```json
{ "__nativeType": "FunctionRef", "name": "add", "module": "math.agency" }
```

### Deserialization

The reviver looks up the `AgencyFunction` instance in `__toolRegistry` by name/module and returns it. After an interrupt, a variable that held an `AgencyFunction` gets back the full instance with all parameter metadata intact.

### Reviver simplification

- `isInstance`: becomes `AgencyFunction.isAgencyFunction(value)` — no more Zod schema validation on `__functionRef`
- `serialize`: reads `value.name` and `value.module` directly
- `revive`: same registry lookup as today, returns `AgencyFunction` instead of bare function
- The `typeof raw === "function"` guard added to `nativeTypeReplacer` changes to `AgencyFunction.isAgencyFunction()` — `AgencyFunction` instances are objects, not functions, so the existing `typeof raw === "object"` guard catches them naturally

## Pipe Operator

Today:
```typescript
await __pipeBind(
  success(5, __state),
  async (__pipeArg) => multiply(10, __pipeArg, __state)
)
```

After:
```typescript
await __pipeBind(
  success.invoke({ type: "positional", args: [5] }, __state),
  async (__pipeArg) => multiply.invoke({ type: "positional", args: [10, __pipeArg] }, __state)
)
```

The pipe lambda constructs a positional descriptor with `__pipeArg` in the right slot. No parameter metadata needed at the call site. This also means pipe works with function variables:

```
const fn = multiply
value |> fn(10, ?)
```

**Named args in pipe expressions are not supported.** Pipe is inherently positional — the `?` placeholder marks a position in the argument list. Named args in pipe stages (e.g., `value |> fn(a: 10, b: ?)`) would be confusing and add complexity for little benefit. This is a known limitation, not a future work item.

## Fork

Today, fork requires static function names because the builder generates the block body at compile time. After:

```typescript
runner.fork(id, [add, subtract, divide], async (__forkItem, __forkIndex, __forkBranchStack) => {
  __forkItem.invoke({ type: "positional", args: [2, 2] }, __state);
}, "all")
```

Since `__forkItem` is an `AgencyFunction` instance, fork works with any expression that evaluates to `AgencyFunction`. This enables:

```
const fns = [add, subtract]
fork(fns) as func { func(2, 2) }
```

## What Gets Deleted / Simplified

### Builder methods deleted

- `resolveNamedArgs()` — runtime `AgencyFunction.invoke()` handles this
- `adjustCallArgs()` — same
- `getCalleeParams()` — no longer needed at call sites
- `generateFunctionRefMetadata()` — metadata is in the `AgencyFunction` constructor
- `buildToolRegistryEntry()` — registry is just `Record<string, AgencyFunction>`
- `_functionRefVars` tracking and save/restore — no longer needed

### Builder methods simplified

- `generateFunctionCallExpression()` — two clean paths: Agency calls emit `.invoke()`, TS calls emit direct invocation. No more branching on `isAgencyFunction` vs `_functionRefVars` for state passing.
- `processTool()` — no longer emits `__toolTool` and `__toolToolParams` as separate declarations. The Zod schema goes into the `AgencyFunction` constructor.
- `generateToolRegistry()` — becomes a simple object literal of `AgencyFunction` instances.

### Runtime code deleted

- `__functionRef` property monkey-patching on function objects
- The `typeof raw === "function"` guard added to `nativeTypeReplacer` (replaced by `AgencyFunction` detection)

### Things that stay the same

- `isAgencyFunction()` — still needed to distinguish Agency vs TS calls
- The preprocessor's `"functionRef"` scope type — still useful for the builder to know a bare identifier is a function reference
- Step runner, thread context, interrupt machinery — all unchanged
- Handler registration and invocation — unchanged

## Implementation Phases

### Phase 1: Build `AgencyFunction` class + unit tests

Pure runtime code, no builder changes. Write the class with `invoke()`, `resolveArgs()`, `toJSON()`. Unit test thoroughly:

- Positional calls (exact args, fewer args with defaults, extra args with variadics)
- Named calls (reordering, skipped optionals, mixed positional+named)
- Error cases (unknown name, duplicate, positional after named, missing required)
- Serialization (`toJSON()`)

### Phase 2: Adapt `FunctionRefReviver` + change the builder (atomic)

The reviver and builder changes must happen together because the reviver's registry type (`Record<string, AgencyFunction>`) depends on the builder producing `AgencyFunction` instances, and vice versa.

- Update `FunctionRefReviver` to detect/serialize/revive `AgencyFunction` instances
- Function definitions emit `AgencyFunction` constructors
- Call sites emit `.invoke(descriptor, __state)`
- Delete old builder methods
- Update tool registry generation
- Update all test fixtures

## Testing Strategy

### TDD approach — write tests first, verify they fail, then implement

### Unit tests (`lib/runtime/agencyFunction.test.ts`)

- Positional call with exact args
- Positional call with fewer args (defaults fill in)
- Positional call with extra args (variadic wrapping)
- Named call reorders to positional
- Named call with skipped optional params
- Mixed positional + named args
- Error: unknown named arg
- Error: duplicate named arg
- Error: positional after named
- Error: missing required arg
- `toJSON()` produces correct `{ name, module }`

### Unit tests for adapted `FunctionRefReviver`

- `isInstance` detects `AgencyFunction` instances
- `serialize` extracts name/module
- `revive` returns `AgencyFunction` from registry
- Round-trip through `nativeTypeReplacer` + `nativeTypeReviver`
- Aliased imports revive correctly

### Integration test fixtures (`tests/typescriptGenerator/`)

- Update all existing fixtures — generated code changes shape
- New fixtures for named args via `.invoke()`, variadic via `.invoke()`

### Agency execution tests (`tests/agency/`)

- All existing function-ref tests still pass
- Named args through a dynamic function variable
- Variadic args through a dynamic function variable
- Default args through a dynamic function variable
- Fork with function-ref variables
- Pipe with function-ref variables

## Future Work (Deferred but Architecturally Supported)

### Lambdas

A lambda compiles to an anonymous `__lambda_N_impl` function, wrapped in an `AgencyFunction` with no registry name. Captured variables serialize alongside the function reference. The `invoke()` method works identically.

### Partial application

`add.bind(a: 1)` returns a new `AgencyFunction` with `boundArgs` stored. The `invoke()` method merges bound args with call-site args before resolving. Serialization stores `{ ref, boundArgs }`.

### Dynamic `uses`

`uses fn` where `fn` is a variable — the LLM tool definition is on the `AgencyFunction` instance via `.toolDefinition`. No compile-time lookup needed.

### Dynamic fork

Already works with this design — `AgencyFunction` instances in arrays, `.invoke()` in the block body.
