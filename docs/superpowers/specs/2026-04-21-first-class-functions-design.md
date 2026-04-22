# First-Class Functions Design

## Overview

Add first-class function support to Agency: named `def` functions can be assigned to variables, passed as arguments, stored in data structures, and called dynamically. No anonymous functions, closures, or partial application (those are future follow-ups).

## Syntax & Semantics

### Assigning functions to variables

```
def greet(name: string): string { return "hi ${name}" }

node main() {
  const fn = greet
  const result = fn("Bob")
}
```

A bare function name (no parentheses) on the right side of an assignment produces a function reference, not a call.

### Passing functions as arguments

```
def double(x: number): number { return x * 2 }

def applyToAll(items: number[], transform: (number) => number): number[] {
  const result: number[] = []
  for (item in items) {
    result.push(transform(item))
  }
  return result
}

node main() {
  const doubled = applyToAll([1, 2, 3], double)
}
```

### Storing functions in data structures

```
const handlers: { onSuccess: (string) => void, onError: (string) => void } = {
  onSuccess: handleSuccess,
  onError: handleError
}
handlers.onSuccess("it worked")
```

### Function type syntax

`(ParamType1, ParamType2) => ReturnType`

This aligns with the existing block parameter type syntax.

### What's NOT supported (yet)

- Anonymous functions / lambdas (future follow-up; blocks already solve the compilation side, main gap is serialization of captured state)
- Defining functions inside nodes or other functions
- Partial application (future follow-up; serialization story is clean since bound args are explicit)
- Returning newly-created functions from functions

## Function Registry & Serialization

### Problem

If a variable holds a function reference and an interrupt fires, that variable is in `__stack.locals` and needs to serialize. JavaScript functions aren't JSON-serializable.

### Solution

A function registry maps module-qualified names to function objects. Serialization stores the name; deserialization looks it up.

### Registry

The `__toolRegistry` already maps function names to their implementations. Every `def` function and imported function is already registered there (via `programInfo.functionDefinitions`). We build on this rather than creating a parallel registry. Stdlib functions that the user explicitly imports also need registry entries.

Note: the actual function is at `__toolRegistry[name].handler.execute`, not directly at `__toolRegistry[name]`. The registry lookup helpers need to account for this nested structure.

For imported functions, the key is module-qualified to avoid collisions:
- Local function: `"greet"`
- Imported function: `"utils.agency::greet"`

For aliased imports (`import { greet as sayHello }`), the serialization format stores the **original** function name and module, not the local alias. The alias is a local concern; the registry key must be stable across modules.

**Note**: The current `generateToolRegistry` registers imported functions under their *local* name (alias) as the key. For serialization to work correctly, the `__functionRef` metadata attached to the function must use the original name and source module — not the local alias. This way, even though the registry key is the alias, the serialization format is module-stable. On deserialization, the reviver resolves by original name + module, then looks up the function via the importing module's registry (which maps the alias to the same function object).

**Important**: Aliased imports must continue to work as LLM tools. If a user writes `import { greet as sayHello }` and then `uses sayHello`, the LLM should see a tool called `sayHello`. The `__functionRef` metadata is only for serialization — it does not affect the tool name seen by the LLM, which is still the local alias. There is no existing test for aliased imports used as LLM tools, so one should be added as part of this work.

### Reverse lookup (function → registry name)

The `nativeTypeReplacer` receives a bare JavaScript function object during `JSON.stringify`. It has no way to determine which registry entry it belongs to without additional metadata.

**Approach**: When registering functions in the tool registry, also attach metadata to the function object itself:

```js
greet.__functionRef = { name: "greet", module: "foo.agency" };
```

This assignment should be emitted in `generateToolRegistry` (or immediately after function definition), so every registered function gets its metadata before any user code runs.

The replacer checks for `__functionRef` on function values and uses it to produce the serialization marker. This avoids needing a `WeakMap` or reverse-index and keeps the lookup O(1).

### Serialization format

Extends the existing native type reviver:

```json
{ "__nativeType": "FunctionRef", "name": "greet", "module": "foo.agency" }
```

### FunctionRefReviver (BaseReviver subclass)

For consistency with the existing reviver pattern (MapReviver, SetReviver, DateReviver, etc.), `FunctionRef` gets its own `BaseReviver` subclass in `lib/runtime/revivers/functionRefReviver.ts`:

```ts
class FunctionRefReviver implements BaseReviver<Function> {
  nativeTypeName(): string { return "FunctionRef"; }
  isInstance(value: unknown): value is Function {
    return typeof value === "function" && "__functionRef" in value;
  }
  serialize(value: Function): Record<string, unknown> {
    const ref = (value as any).__functionRef;
    return { __nativeType: "FunctionRef", name: ref.name, module: ref.module };
  }
  validate(value: Record<string, unknown>): boolean {
    return typeof value.name === "string" && typeof value.module === "string";
  }
  revive(value: Record<string, unknown>): Function {
    return this.registry.lookup(value.module as string, value.name as string);
  }
}
```

This keeps all serialization/deserialization logic in one place, consistent with the other revivers.

**However**, the existing `nativeTypeReplacer` guards on `typeof raw === "object"`, which means functions (`typeof "function"`) are silently dropped before the reviver loop is reached. The replacer must be updated to also check `typeof raw === "function"` so that `FunctionRefReviver.isInstance` gets a chance to run. This is a small change to the guard in `nativeTypeReplacer`:

```ts
// Before:
if (typeof raw !== "object" || raw === null) return value;

// After:
if (raw === null) return value;
if (typeof raw !== "object" && typeof raw !== "function") return value;
```

Functions without `__functionRef` (e.g., raw JS functions from TypeScript interop) will not match `FunctionRefReviver.isInstance` and will fall through unchanged — `JSON.stringify` will still drop them, but that's the expected behavior for non-Agency functions.

### Registry access for deserialization

The `FunctionRefReviver` needs access to the function registry to look up functions by name during `revive()`. The other revivers don't need external state — they reconstruct values from the serialized data alone. For `FunctionRefReviver`, the registry must be provided.

**Approach**: The reviver instance receives the registry at construction time. The `revivers` array in `lib/runtime/revivers/index.ts` is currently a module-level constant. To support this, either:

1. Make the revivers array constructed per-context, with the `FunctionRefReviver` receiving the registry from `RuntimeContext`, or
2. Give `FunctionRefReviver` a mutable `registry` property that gets set once the `__toolRegistry` is available at module load time.

Option 2 is simpler and avoids changing the reviver initialization pattern for all other revivers. The generated code would set `functionRefReviver.registry = __toolRegistry` alongside the `__functionRef` metadata assignments.

On lookup failure (function not found), throw a descriptive error. This is infrastructure code running during deserialization, not user-facing Agency code, so a thrown error is appropriate rather than an Agency `failure` Result.

### Edge cases

- **Function not found in registry on deserialize**: Code changed between serialize and deserialize. Throw a descriptive error explaining which function reference could not be resolved.
- **Stdlib functions** (like `print`, `read`): Already in `__toolRegistry`, so they work automatically. Explicitly imported stdlib functions (like `map`, `filter`) need registry entries added and `__functionRef` metadata attached.
- **Functions stored in nested structures**: The native type reviver already walks objects recursively (handles nested Maps/Sets today), so `{ callbacks: [greet, farewell] }` serializes each function ref individually.
- **Graph node references**: Assigning a node to a variable (`const fn = main`) is **not supported**. Node calls trigger state machine transitions and have fundamentally different semantics from function calls. The preprocessor should emit an error if a node name is used as a value expression. Nodes are not registered in the function registry.

## Compiler Changes

### Parser

The `blockTypeParser` already parses `(ParamType) => ReturnType` syntax and produces a `BlockType` AST node. This can be reused directly for function type annotations — no new parser work is needed for the type syntax itself.

The parser also needs to recognize that a bare function name on the right side of an assignment is a reference rather than a call. This should mostly work already since the parser distinguishes identifiers from call expressions.

### Preprocessor (scope resolution)

When the preprocessor encounters `const fn = greet`, it needs to recognize that `greet` is a function reference, not a regular variable. This matters because:
- The variable `fn` needs to be stored in `__stack.locals` like any other local
- But the value being assigned is a function from the registry, not a literal

The preprocessor already knows about all function definitions (via `programInfo`). When it sees an identifier that matches a known function name being used as a value (not a call), it flags it by setting the AST node's `scope` to a new `"functionRef"` scope type.

This new scope type must be added in two places:
- `ScopeType` union in `lib/types.ts` (AST level)
- `TsScopedVar["scope"]` union in `lib/ir/tsIR.ts` (IR level)
- `scopeToPrefix` in `lib/ir/prettyPrint.ts` — maps to `""` (bare name), same as `"imported"` and `"shared"`, since function references are top-level bindings

**Important distinction**: `"functionRef"` is the scope of the *value expression* (the right-hand side `greet`), not the variable being assigned to. In `const fn = greet`, `fn` has scope `"local"` (stored in `__stack.locals`), while `greet` has scope `"functionRef"` (emitted as a bare name).

This approach fits the existing pattern — `scope` is already the mechanism the preprocessor uses to communicate variable resolution to the builder. The builder can then check `scope === "functionRef"` to know it should emit the function reference as a bare name.

For *calling* a function-typed variable (`fn("Bob")`), the builder needs to know that `fn` holds a function reference so it can pass `__state`. The simplest approach: check the variable's type annotation. If the variable has a function type (from an explicit annotation or inferred from the assignment), the builder passes `__state`. This avoids needing to track assignment provenance across the builder.

The node-as-value check also happens here during scope resolution: if the identifier matches a node name in `programInfo`, emit a compile error rather than flagging it as `"functionRef"`.

### Builder (code generation)

For `const fn = greet`, the builder generates:

```js
__stack.locals.fn = greet;
```

Straightforward — assign the function directly. The serialization system handles the rest when an interrupt fires.

For calling a function-typed variable (`fn("Bob")`), the builder emits the same calling convention as a regular function call — passing `{ ctx: __ctx, threads: __threads, interruptData: __state?.interruptData }` as the state argument. The difference is that regular calls are resolved statically, but variable calls are dynamic:

```js
__stack.locals.fn("Bob", { ctx: __ctx, threads: __threads, interruptData: __state?.interruptData });
```

**Important**: The builder currently uses `isAgencyFunction(name)` to decide whether to pass the `__state` argument. This checks against statically known function names. For dynamic calls via variables, this check will fail. The builder needs a new path: when the call target has a function type (from type annotation or inferred from assignment), always pass `__state` regardless of `isAgencyFunction`. See the preprocessor section above for details.

### Type checker

Type checker updates are **deferred** — not included in this initial implementation. Function-typed variables will not be type-checked at compile time. This is intentional to keep scope manageable; type checking for function types can be added in a follow-up.

## What Doesn't Change

- **Step runner**: The called function already has its own Runner and step tracking, regardless of how it's invoked.
- **Thread context**: Functions receive `__ctx` and `__threads` through the `__state` parameter. Whether called by name or via variable, same calling convention.
- **Interrupts**: If an interrupt fires inside a function called via variable, the function's own interrupt machinery handles it. The caller sees the interrupt result and propagates it the same way.
- **Handlers**: Handler blocks wrap call sites, not function definitions. `handle { fn("Bob") } with ...` works the same whether `fn` is a direct name or a variable.
- **Blocks**: Passing a `def` function where a block is expected works at runtime — both are async functions that receive `__state`. No changes needed.
- **Audit logging**: Audit calls are generated at call sites. For dynamic calls, the audit entry uses the variable name rather than the original function name. Slightly less informative but acceptable for now.

## Testing Strategy

### Unit tests

- Parser: function type syntax `(number, string) => boolean` parses correctly as a type expression
- Preprocessor: function references are correctly scoped (recognized as function refs, not unknown variables)
- Serialization: `FunctionRef` round-trips through serialize/deserialize correctly, including imported functions

### Integration test fixtures (tests/typescriptGenerator/)

- Assigning a function to a variable and calling it
- Passing a function as an argument to another function
- Storing functions in objects/arrays
- Imported function references (from another `.agency` file, from stdlib)

### Agency execution tests (tests/agency/)

- Function reference survives an interrupt (serialize, deserialize, call after resume)
- Function stored in a data structure survives an interrupt
- Passing a `def` function where a block is expected
- Aliased import (`import { greet as sayHello }`) assigned to variable, survives interrupt
- Aliased import used as LLM tool (`uses sayHello`) — verifies aliasing doesn't break tool registration
- Error case: registry lookup fails on deserialize (e.g., function was removed)

## Future Work

- **Lambdas / anonymous functions**: Blocks already solve the compilation side (own Runner, step tracking, scope analysis). Main remaining work is serialization of captured variables. Each lambda would compile as a named internal function; captured vars would serialize alongside the code reference.
- **Partial application**: Clean serialization story since bound args are explicit: `{ ref: "foo.agency::add", boundArgs: { a: 5 } }`. Needs syntax design to avoid conflict with named parameter calls.
- **LLM tool integration**: Allowing `uses` with dynamic function references. Part of a larger tools redesign.
