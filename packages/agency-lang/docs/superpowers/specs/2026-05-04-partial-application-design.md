> **Note:** This spec has been superseded by `2026-05-05-partial-application-capability-constraints-design.md`, which replaces the `?` placeholder syntax with `.partial()` method syntax.

# Partial Application (Currying) for AgencyFunction

## Overview

Add partial application to Agency via a `?` placeholder syntax in function calls. When a function call contains `?` placeholders, it returns a new `AgencyFunction` with some parameters bound, rather than invoking the function. The resulting function can be stored, passed as a tool to `llm()`, serialized through interrupts, etc.

## Motivation

Agency functions are first-class values thanks to `AgencyFunction`, but there's no way to create a specialized version of a function with some arguments pre-filled. This is useful for:

- Creating tools dynamically: `readFile("./skills", ?)` produces a 1-param tool from a 2-param function
- Building tool arrays with different configurations
- Passing specialized functions to `fork`, `map`, pipe chains, etc.

## Syntax

### Positional binding

Place `?` at positions you want to leave unbound. Values at other positions are bound:

```
def add(a: number, b: number, c: number): number {
  return a + b + c
}

const add5 = add(5, ?, ?)       // binds a=5, new sig: (b: number, c: number)
const addMiddle = add(?, 2, ?)  // binds b=2, new sig: (a: number, c: number)
```

### Named binding

If any parameter uses a name, ALL parameters must be named. Named args with values are bound, named args with `?` are unbound:

```
const add5 = add(a: 5, b: ?, c: ?)    // binds a=5
const addMiddle = add(a: ?, b: 2, c: ?) // binds b=2
```

### Rules

1. A function call containing at least one `?` is a bind expression, not a call.
2. Positional and named styles cannot be mixed in a single bind expression. The typechecker and builder enforce this.
3. The resulting function's parameters are the unbound params in **original declaration order**, regardless of the order `?`s appear in the bind expression.
4. All params must be explicitly mentioned — every position must have either a value or `?`. No trailing omission.
5. Bind expressions are NOT supported inside pipe expressions (where `?` already means the pipe placeholder). Create the bound function beforehand.
6. All-placeholder binds (e.g., `add(?, ?, ?)`) are allowed — they produce a function with the same signature as the original.

## AgencyFunction Changes

### New fields

```typescript
export type BoundArgs = {
  // Indices into the ORIGINAL function's param list
  indices: number[];
  // The bound values, corresponding to indices
  values: unknown[];
  // Total number of params in the original function (needed for mergeWithBound)
  originalParamCount: number;
};

export class AgencyFunction {
  // ... existing fields ...
  readonly boundArgs: BoundArgs | null;
  // ... existing constructor gains optional boundArgs param ...
}
```

### New method: `bind()`

```typescript
bind(boundIndices: number[], boundValues: unknown[]): AgencyFunction {
  // If this is already a bound function, merge the bindings.
  // Translate boundIndices from the reduced param list back to original positions.
  const effectiveIndices = this.boundArgs
    ? this.translateIndices(boundIndices)
    : boundIndices;
  const effectiveValues = this.boundArgs
    ? [...this.boundArgs.values, ...boundValues]
    : boundValues;

  const originalParamCount = this.boundArgs
    ? this.boundArgs.originalParamCount
    : this.params.length;

  // Compute cumulative bound indices
  const allBoundIndices = this.boundArgs
    ? [...this.boundArgs.indices, ...effectiveIndices]
    : effectiveIndices;

  // Compute new params: filter the ORIGINAL param list to only unbound ones.
  // We need the original params — for a fresh function that's this.params,
  // for an already-bound function we reconstruct from the original.
  const unboundParams = this.getOriginalParams().filter(
    (_, i) => !allBoundIndices.includes(i)
  );

  // Compute new tool definition with reduced schema
  const newToolDef = this.toolDefinition
    ? {
        ...this.toolDefinition,
        schema: buildReducedSchema(this.toolDefinition.schema, unboundParams),
      }
    : null;

  return new AgencyFunction({
    name: this.name,
    module: this.module,
    fn: this._fn,
    params: unboundParams,
    toolDefinition: newToolDef,
    boundArgs: {
      indices: allBoundIndices,
      values: [...(this.boundArgs?.values ?? []), ...boundValues].length === effectiveValues.length
        ? effectiveValues
        : effectiveValues,
      originalParamCount,
    },
  });
}
```

### `translateIndices()` — mapping reduced indices back to original positions

When binding an already-bound function, the caller provides indices relative to the *reduced* param list. These must be translated back to the original function's param positions:

```typescript
private translateIndices(reducedIndices: number[]): number[] {
  // this.params is the reduced param list (unbound params only).
  // Each entry in this.params corresponds to a position in the original param list.
  // We need to find the original index for each reduced index.
  const originalParams = this.getOriginalParams();
  const unboundOriginalIndices: number[] = [];

  for (let i = 0; i < originalParams.length; i++) {
    if (!this.boundArgs!.indices.includes(i)) {
      unboundOriginalIndices.push(i);
    }
  }

  // reducedIndices[k] maps to unboundOriginalIndices[reducedIndices[k]]
  return reducedIndices.map(ri => unboundOriginalIndices[ri]);
}
```

### `getOriginalParams()`

Returns the full original param list. For a fresh function, that's `this.params`. For an already-bound function, we reconstruct it. Since we store `originalParamCount` and the bound function only has the reduced params, we need the original params available. The simplest solution: look up the original function in the registry via `this.name` / `this.module`. Alternatively, store `originalParams` on `BoundArgs`:

```typescript
export type BoundArgs = {
  indices: number[];
  values: unknown[];
  originalParamCount: number;
  originalParams: FuncParam[];  // the full original param list
};
```

This avoids a registry lookup at runtime and makes `bind()` self-contained.

### Updated `invoke()`

```typescript
async invoke(descriptor: CallType, state?: unknown): Promise<unknown> {
  if (this.boundArgs) {
    const callArgs = this.resolveArgs(descriptor);
    const fullArgs = this.mergeWithBound(callArgs);
    return this._fn(...fullArgs, state);
  }
  // ... existing logic unchanged ...
}

private mergeWithBound(unboundArgs: unknown[]): unknown[] {
  // Reconstruct the full argument list:
  // - bound positions get their stored values
  // - unbound positions get filled from unboundArgs in order
  const totalParams = this.boundArgs!.originalParamCount;
  const fullArgs: unknown[] = new Array(totalParams);
  let unboundIdx = 0;

  for (let i = 0; i < totalParams; i++) {
    const boundPos = this.boundArgs!.indices.indexOf(i);
    if (boundPos !== -1) {
      fullArgs[i] = this.boundArgs!.values[boundPos];
    } else {
      fullArgs[i] = unboundArgs[unboundIdx++];
    }
  }
  return fullArgs;
}
```

### `buildReducedSchema()`

The tool definition schema is a Zod object schema. To remove bound params, we rebuild the schema keeping only the unbound param names:

```typescript
function buildReducedSchema(
  originalSchema: ZodObject<any>,
  unboundParams: FuncParam[]
): ZodObject<any> {
  const unboundNames = new Set(unboundParams.map(p => p.name));
  const shape = originalSchema.shape;
  const reducedShape: Record<string, any> = {};
  for (const [key, value] of Object.entries(shape)) {
    if (unboundNames.has(key)) {
      reducedShape[key] = value;
    }
  }
  return z.object(reducedShape);
}
```

## Serialization

### Serialized form

```json
{
  "__nativeType": "FunctionRef",
  "name": "readSkill",
  "module": "main.agency",
  "boundArgs": {
    "indices": [0],
    "values": ["./skills"],
    "originalParamCount": 2,
    "originalParams": [
      { "name": "dir", "hasDefault": false, "defaultValue": null, "variadic": false },
      { "name": "filename", "hasDefault": false, "defaultValue": null, "variadic": false }
    ]
  }
}
```

### FunctionRefReviver changes

**`serialize()`**: If `value.boundArgs` is non-null, include it in the output alongside name and module.

**`validate()`**: Accept records with or without `boundArgs`.

**`revive()`**:
1. Look up the original function by name/module in the registry.
2. If `boundArgs` is present in the serialized data, call `.bind()` with the stored indices and values.
3. Return the resulting `AgencyFunction`.

The original unbound function is always in the static `__toolRegistry` (registered at module load time). Bound versions are derived from it on deserialization.

### Bound values must be serializable

Since bound values are serialized as part of the function reference, they go through the same `nativeTypeReplacer` / reviver pipeline as any other value in the state stack. This means bound values must be serializable — primitives, objects, arrays, other `AgencyFunction` instances. Non-serializable values (e.g., raw TypeScript objects with function properties) will fail at serialization time.

## Parser Changes

### New AST node: `placeholderExpression`

A `?` in a function call argument position produces a `placeholderExpression` node. The node has no fields — it's just a marker.

Note: Agency already has a `placeholder` node used in pipe expressions. The bind placeholder is semantically different. Options:
- Reuse the same node type and let the builder distinguish by context (inside pipe vs. inside function call).
- Create a distinct `bindPlaceholder` node.

Recommendation: reuse the existing `placeholder` node. The builder already knows whether it's processing a pipe expression or a function call, so it can determine the meaning from context.

### Detection in function calls

When parsing a function call's argument list, if any argument parses as a `placeholder`, the call is a bind expression. No separate `bindExpression` AST node is needed — the builder detects this by inspecting the arguments.

## Typechecker Changes

- Validate: positional and named styles cannot be mixed in a bind expression.
- Validate: in positional mode, the number of arguments (values + placeholders) must equal the function's param count.
- Validate: in named mode, every parameter must be mentioned (either `name: value` or `name: ?`).
- Validate: variadic parameters cannot be bound (must be `?`).
- Validate: bind expressions on plain TypeScript imports are an error.
- Infer: the result type of a bind expression is a function type with the unbound parameter types.

## Preprocessor Changes

Minimal. The preprocessor needs to recognize that a function call with `?` is a bind expression so it doesn't try to resolve it as a regular call (e.g., for async marking, tool usage tracking). The resulting variable should be marked as scope type `"functionRef"`.

## Builder Changes

### Detecting bind expressions

When processing a function call, the builder checks if any argument is a `placeholder`. If so, it emits a `.bind()` call instead of `.invoke()`.

### Emitted code for positional bind

```
// Agency: const add5 = add(5, ?, ?)
// TypeScript:
const add5 = add.bind([0], [5]);
```

### Emitted code for named bind

```
// Agency: const add5 = add(a: 5, b: ?, c: ?)
// TypeScript:
const add5 = add.bind([0], [5]);
```

Named bind is resolved at compile time — the builder maps parameter names to indices using the function's param list from the compilation unit, then emits the same positional `.bind()` call.

### TypeScript imports

Bind expressions on plain TypeScript imports are an error — the builder can't know the param list of a TS function. The typechecker should catch this.

## Edge Cases

### Binding an already-bound function

```
const add5 = add(5, ?, ?)
const add5and2 = add5(2, ?)
```

Works. The second bind operates on the reduced param list. `AgencyFunction.bind()` uses `translateIndices()` to map back to original positions, then merges with existing bound args. Serialization stores the cumulative bindings against the original function.

### Variadic parameters

Binding a variadic parameter is not supported. If the last param is variadic, it must always be `?` (unbound). The typechecker enforces this.

### Default parameters

Binding a param that has a default value works — the bound value overrides the default. Leaving a default param as `?` means callers can still omit it (the UNSET sentinel fills in, and the function body uses the default).

### Pipe operator

`?` in a pipe expression is already the pipe placeholder. Bind syntax is NOT allowed inside pipe stages. Use a variable:

```
// ERROR: ambiguous ?
value |> add(5, ?, ?)

// OK: bind first, then pipe
const add5 = add(5, ?, ?)
value |> add5(?)
```

The builder distinguishes these by context: inside a `pipeExpression`, `?` is always the pipe placeholder. Inside a standalone function call, `?` triggers bind.

### Fork

Bound functions work in fork like any other `AgencyFunction`:

```
const fns = [add(1, ?, ?), add(2, ?, ?), add(3, ?, ?)]
const results = fork(fns) as fn {
  fn(10, 20)
}
```

### Tool usage with `uses`

A bound function can be used as a tool:

```
const tool = readFile("./skills", ?)
uses tool
const result = llm("Read a file", { tools: [tool] })
```

The LLM sees only the unbound parameters in the tool schema.

### Method partial application

Not supported in this iteration. `obj.method(5, ?)` is not valid. Methods on objects go through `__callMethod`, which preserves `this` binding — partial application of methods would require storing the receiver object alongside the bound args. This can be added later if needed.

## Testing Strategy

### Unit tests (`lib/runtime/agencyFunction.test.ts`)

- `bind()` with single bound arg produces correct reduced params
- `bind()` with multiple bound args at different positions
- `bind()` on already-bound function (chained binding)
- `bind()` all-placeholder (produces identical signature)
- `invoke()` on bound function merges args correctly
- `invoke()` on bound function with named call-site args
- `invoke()` on bound function with default params (UNSET handling)
- `invoke()` on bound function with variadic unbound param
- Serialization round-trip: bound function serializes and deserializes correctly
- Serialization round-trip: chained bound function serializes correctly
- `translateIndices()` correctness for chained binds

### Parser tests

- `?` in positional call produces arguments with placeholder nodes
- `?` in named call produces arguments with placeholder nodes
- All positions filled with `?` parses correctly
- `?` not confused with other syntax (optional chaining, etc.)

### Typechecker tests

- Mixed positional/named in bind — error
- Positional with wrong arg count — error
- Named with missing param — error
- Variadic param bound — error
- Bind on TS import — error
- Result type inference for bound function

### Integration tests (`tests/agency/`)

- Bind a function, call the bound function
- Bind a function, pass as tool to `llm()`
- Bind a function, interrupt fires, state serializes and deserializes, bound function still works
- Bind a function inside a fork block
- Chain two binds
- Bind with named syntax

### Fixture tests (`tests/typescriptGenerator/`)

- Verify generated code shape for positional bind
- Verify generated code shape for named bind
- Verify generated code for chained bind

## Implementation Phases

### Phase 1: Runtime (`AgencyFunction` changes)

- Add `BoundArgs` type and `boundArgs` field to constructor
- Implement `bind()`, `translateIndices()`, `mergeWithBound()`, `getOriginalParams()`
- Implement `buildReducedSchema()`
- Update `invoke()` to handle bound args
- Update `FunctionRefReviver` for serialization/deserialization of bound functions
- Unit tests for all of the above

### Phase 2: Parser

- Recognize `?` (placeholder) in function call argument positions
- Ensure no conflict with existing pipe placeholder usage
- Parser tests

### Phase 3: Builder

- Detect bind expressions (calls containing placeholder arguments)
- Emit `.bind()` calls with correct indices/values
- Handle named bind (resolve names to indices at compile time)
- Fixture tests (including negative cases that Phase 4 typechecker will later catch)

### Phase 4: Typechecker

- Validate no mixing of positional/named in bind
- Validate correct arg count / all params mentioned
- Validate variadic params cannot be bound
- Validate bind not used on TS imports
- Infer result type of bind expression

### Phase 5: Integration tests

- End-to-end agency execution tests
- Interrupt survival tests
- Tool usage tests
