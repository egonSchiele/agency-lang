# Nested Functions with Compiler-Managed Closures

## Overview

Add support for defining functions inside other functions (nested `def`). The inner function captures variables from the enclosing scope. The captured data is snapshotted into the `AgencyFunction` at creation time, travels with the value, and survives serialization through interrupts. This enables dynamic tool creation — functions whose behavior and description depend on runtime data.

## Motivation

Agency functions are first-class values, but they can only be defined at the top level of a file. You can't create a tool dynamically — one whose behavior or description depends on runtime data. Example use case:

```
def skill(dir: string) {
  const files = listFiles(dir)
  const names = files.join(", ")

  def readSkill(filename: string): string {
    """
    Reads a skill file. Available: ${names}
    """
    return readFile("${dir}/${filename}")
  }

  return readSkill
}

node main() {
  const tool = skill("./skills")
  const result = llm("Pick a skill to read", { tools: [tool] })
  print(result)
}
```

`skill()` reads a directory, caches the file list, and returns a tool whose description lists the available files. The LLM can then call this tool by filename.

## Syntax

### Nested function definition

`def` inside `def` or `node`. Statement only (not an expression):

```
def outer(x: number) {
  const multiplier = x * 2

  def inner(y: number): number {
    return y * multiplier
  }

  return inner
}
```

### Dynamic docstrings

Docstrings can contain template expressions. When the docstring is on an inner function, the template is evaluated at the point the inner function is created (not at parse time):

```
def skill(dir: string) {
  const files = listFiles(dir)

  def readSkill(filename: string): string {
    """
    Available files: ${files.join(", ")}
    """
    return readFile("${dir}/${filename}")
  }

  return readSkill
}
```

The resulting `AgencyFunction`'s `toolDefinition.description` is the evaluated string — e.g., `"Available files: foo.md, bar.md"`.

For top-level functions, docstrings remain static (evaluated at compile time) as they are today. Dynamic evaluation only applies to inner functions where the template references captured variables.

### Returning inner functions

Define the function, then return by name:

```
def outer() {
  def inner() { ... }
  return inner
}
```

Future work: `return def inner() { ... }` as sugar (statement + return in one).

### Multiple inner functions

A function can define multiple inner functions:

```
def createTools(dir: string) {
  const files = listFiles(dir)

  def readFile(filename: string): string {
    """Read a file from ${dir}"""
    return read("${dir}/${filename}")
  }

  def listAvailable(): string[] {
    """List files in ${dir}"""
    return files
  }

  return [readFile, listAvailable]
}
```

### Nesting depth

Inner functions can be nested further (closures within closures):

```
def a() {
  const x = 1
  def b() {
    const y = 2
    def c(): number {
      return x + y  // captures from both a and b
    }
    return c
  }
  return b
}
```

### Same-name inner functions

Two different outer functions can each define an inner function with the same name — they are distinguished by their full path. However, defining two inner functions with the same name in the same outer function is disallowed (even in different branches). The typechecker rejects this:

```
// ERROR: duplicate inner function name "inner" in "outer"
def outer() {
  if (x) {
    def inner() { return 1 }
  } else {
    def inner() { return 2 }  // error
  }
}
```

## Core Design: Closure Data on AgencyFunction

The closure data lives on the `AgencyFunction` instance, NOT on the state stack. This completely avoids the state stack fold/unfold problem.

When `outer()` executes:
1. `outer()` gets a normal stack frame, computes variables
2. At the inner `def`, the compiler emits code that snapshots captured variables into `closureData` on the new `AgencyFunction`
3. `outer()` returns the `AgencyFunction` and its frame is popped normally
4. The returned `AgencyFunction` (with `closureData`) is stored in whatever variable the caller assigns it to

The closure data is just data on a value that happens to live in a stack frame's locals. The stack fold/unfold proceeds exactly as before.

### Snapshot semantics

Closure data is captured at the point of the `def` statement via **shallow copy**. This means:

- **Primitives** (strings, numbers, booleans): true snapshot — mutation of the variable after `def` has no effect on the closure.
- **Objects and arrays**: the reference is snapshotted. Reassigning the variable after `def` has no effect. However, mutations to the object's properties ARE visible to the closure (same reference).

**Important difference from JavaScript:** JavaScript closures capture by *reference* (the variable binding). `let x = 1; const f = () => x; x = 2; f()` returns `2` in JavaScript, but would return `1` in Agency. This is an intentional design choice — Agency's serialization model requires snapshot semantics because live variable bindings cannot survive serialization/deserialization across interrupt boundaries. This should be documented prominently in the language guide.

Capture by reference is not feasible because: (1) after the outer function returns, its stack frame is popped — there's no binding to share, and (2) serialization destroys shared object identity — two references to the same object become independent copies after deserialization.

If users want true isolation for objects, they should clone before capturing:

```
def outer() {
  const data = { count: 0 }
  const snapshot = { ...data }  // explicit shallow clone

  def inner() {
    return snapshot.count  // won't see mutations to data
  }
}
```

## Compilation

### Hoisting

The inner function's implementation is hoisted to module level with a unique namespaced name:

```typescript
// Hoisted to module level
async function __outer__inner_impl(y, __state) {
  const { stateStack, stack } = setupFunction({ state: __state });
  const __self = stack.locals;
  const __args = stack.args;
  __args.y = y;

  // Initialize closure data into locals on first entry
  if (__self.__closureInit === undefined) {
    __self.__closureInit = true;
    __self.__c_multiplier = __state.closure.multiplier;
  }

  // step 0
  if (stack.step <= 0) {
    __self.__step0 = __args.y * __self.__c_multiplier;
    stack.step = 1;
  }

  stateStack.pop();
  return __self.__step0;
}
```

Key points:
- Full `setupFunction` / stack frame / step tracking — interrupts work everywhere
- Closure variables are copied from `__state.closure` into `__self` on first initialization
- On interrupt resume, `setupFunction` restores the frame (which already has `__c_multiplier` in locals), so the `__closureInit` check is skipped (it's already set to `true`)
- The `__c_` prefix distinguishes closure-derived locals from regular locals
- The `__closureInit` prefix is reserved (like existing `__substep_`, `__condbranch_` prefixes)

### Closure registry

A global registry maps namespaced keys to hoisted implementations along with their param metadata. The `FunctionRefReviver` uses this to find the implementation on deserialization.

The registry lives in its own file (`lib/runtime/closureRegistry.ts`):

```typescript
// lib/runtime/closureRegistry.ts
const globalClosureRegistry: Record<string, { fn: Function, params: FuncParam[] }> = {};

export function registerClosure(key: string, entry: { fn: Function, params: FuncParam[] }): void {
  globalClosureRegistry[key] = entry;
}

export function lookupClosure(key: string): { fn: Function, params: FuncParam[] } | undefined {
  return globalClosureRegistry[key];
}
```

Each compiled module registers its closure entries at module load time:

```typescript
// In compiled module (top-level side effect)
import { registerClosure } from "agency-lang/runtime";

registerClosure("main.agency:outer::inner", {
  fn: __outer__inner_impl,
  params: [{ name: "y", hasDefault: false, defaultValue: undefined, variadic: false }],
});
```

The registry stores `{ fn, params }` tuples because the reviver needs param metadata to reconstruct the `AgencyFunction` on deserialization.

### Registry design: why a global registry is safe

The closure registry only stores **static code** — hoisted implementation functions and their parameter metadata. It is populated at module load time and is read-only after that. It is analogous to a vtable: shared, static, and immutable.

This does NOT violate Agency's execution isolation guarantee. Each concurrent agent invocation shares the same compiled module code (the same JavaScript functions). What's isolated is the *data* — the state stack, globals, and the `closureData` on each `AgencyFunction` instance. The registry maps closure keys to code; the per-invocation data travels on the `AgencyFunction` value inside each invocation's isolated state.

### Cross-module closure resolution

The global registry handles cross-module usage automatically. If module A defines an inner function and passes it (as a tool, argument, or via globals) to module B:

1. Module A's closure entries are registered at module A's load time
2. Module B serializes the `AgencyFunction` (including `closureKey` and `closureData`)
3. On deserialization, the reviver calls `lookupClosure(closureKey)` and finds module A's entry

This works because all imported modules are loaded before any node execution begins. The `closureKey` includes the module path for global uniqueness (e.g., `"main.agency:outer::inner"`).

### Closure snapshot at creation point

At the point where the inner `def` appears in the outer function's compiled code:

```typescript
// Inside __outer_impl, at the step where inner is defined:
__self.inner = new AgencyFunction({
  name: "inner",
  module: "main.agency",
  fn: __outer__inner_impl,
  params: [{ name: "y", hasDefault: false, defaultValue: undefined, variadic: false }],
  toolDefinition: {
    name: "inner",
    description: `${__self.multiplier}`,
    schema: z.object({ y: z.number() }),
  },
  closureData: { multiplier: __self.multiplier },
  closureKey: "main.agency:outer::inner",
});
```

Note: `AgencyFunction.name` is the **short name** (`"inner"`), used by the LLM for tool calls and by `runPrompt` for handler lookup. The `closureKey` is the **namespaced key** (`"main.agency:outer::inner"`), used only for registry lookup during serialization/deserialization.

### Dynamic docstring compilation

The docstring template `"Available files: ${files.join(", ")}"` compiles to a template literal expression evaluated at the creation point:

```typescript
toolDefinition: {
  name: "readSkill",
  description: `Available files: ${__self.files.join(", ")}`,
  schema: ...
}
```

This means the description is a plain string by the time it's stored on the `AgencyFunction`. It references the outer function's locals, which are in scope at creation time.

### Naming convention for hoisted functions

Implementation function: `__<outerName>__<innerName>_impl`
For deeper nesting: `__<a>__<b>__<c>_impl`
Registry key: `"<module>:<outer>::<inner>"` (e.g., `"main.agency:outer::inner"` or `"utils.agency:a::b::c"`)

The module path prefix ensures global uniqueness across modules. Different outer functions with identically-named inner functions produce different keys:
- `main.agency:foo::helper` and `main.agency:bar::helper` are distinct
- `main.agency:outer::inner` and `utils.agency:outer::inner` are distinct

## AgencyFunction Changes

### New fields

```typescript
export type AgencyFunctionOpts = {
  name: string;
  module: string;
  fn: Function;
  params: FuncParam[];
  toolDefinition: ToolDefinition | null;
  closureData?: Record<string, unknown> | null;  // NEW
  closureKey?: string | null;                     // NEW
};

export class AgencyFunction {
  // ... existing fields ...
  readonly closureData: Record<string, unknown> | null;
  readonly closureKey: string | null;

  constructor(opts: AgencyFunctionOpts) {
    // ... existing ...
    this.closureData = opts.closureData ?? null;
    this.closureKey = opts.closureKey ?? null;
  }
}
```

- `closureData`: the captured variable values (null for top-level functions)
- `closureKey`: the namespaced registry key for deserialization (null for top-level functions)

### Updated `invoke()`

When invoking an `AgencyFunction` with closure data, the `__state` passed to the underlying `_fn` includes the closure:

```typescript
async invoke(descriptor: CallType, state?: unknown): Promise<unknown> {
  const resolvedArgs = this.resolveArgs(descriptor);
  const effectiveState = this.closureData
    ? { ...(state as any), closure: this.closureData }
    : state;
  return this._fn(...resolvedArgs, effectiveState);
}
```

This injects `closure` into the state object. `setupFunction` ignores unknown fields on state, so this is non-breaking. The hoisted implementation reads `__state.closure` after `setupFunction` (the parameter is still in scope).

### `isAgencyFunction` and `create()`

No changes needed. Inner functions are created with `new AgencyFunction(...)` directly — they do NOT use `AgencyFunction.create()` because they should NOT be auto-registered in `__toolRegistry`. They only become tools when explicitly passed to `llm()`.

## Serialization

### Serialized form

```json
{
  "__nativeType": "FunctionRef",
  "name": "inner",
  "module": "main.agency",
  "closureKey": "main.agency:outer::inner",
  "closureData": { "multiplier": 6 },
  "toolDefinition": {
    "name": "inner",
    "description": "Multiplies by 6",
    "schema": {}
  },
  "params": [
    { "name": "y", "hasDefault": false, "defaultValue": null, "variadic": false }
  ]
}
```

Closure functions serialize: `name`, `module`, `closureKey`, `closureData`, `toolDefinition`, and `params`. The `closureKey` includes the module path for global uniqueness (e.g., `"main.agency:outer::inner"`). The `params` are included because they aren't available from just the registry entry (the registry has the full params, but chained binds could have modified them — including params in the serialized form is simpler and more robust).

Top-level functions continue to serialize as `{ name, module }` only — no closureKey, no closureData.

### FunctionRefReviver changes

**`serialize()`**: If `value.closureKey` is non-null, include closureKey, closureData, toolDefinition, and params:

```typescript
serialize(value: AgencyFunction): Record<string, unknown> {
  const result: Record<string, unknown> = {
    __nativeType: this.nativeTypeName(),
    name: value.name,
    module: value.module,
  };
  if (value.closureKey) {
    result.closureKey = value.closureKey;
    result.closureData = value.closureData;
    result.toolDefinition = value.toolDefinition;
    result.params = value.params;
  }
  return result;
}
```

**`validate()`**: Accept records with or without `closureKey`.

**`revive()`**:

```typescript
import { lookupClosure } from "./closureRegistry.js";

revive(value: Record<string, unknown>): AgencyFunction {
  const name = value.name as string;
  const module = value.module as string;

  // Closure function path
  if (value.closureKey) {
    const key = value.closureKey as string;
    const entry = lookupClosure(key);
    if (!entry) {
      throw new Error(`Cannot revive closure function "${key}" — module not loaded`);
    }
    const fn = new AgencyFunction({
      name,
      module,
      fn: entry.fn,
      params: value.params as FuncParam[],
      toolDefinition: value.toolDefinition as ToolDefinition | null,
      closureData: value.closureData as Record<string, unknown>,
      closureKey: key,
    });
    // Replace __self__ sentinels for recursive inner functions
    if (fn.closureData) {
      for (const [k, v] of Object.entries(fn.closureData)) {
        if (v === "__self__") fn.closureData[k] = fn;
      }
    }
    return fn;
  }

  // Regular function path (unchanged)
  // ... existing lookup in this.registry ...
}
```

The reviver uses the global `lookupClosure()` function — no per-instance registry field needed for closures.

### Closure data serialization

The `closureData` object goes through the same `nativeTypeReplacer` / reviver pipeline as any other value in the state stack. Closure values must be serializable:
- Primitives, objects, arrays: fine
- Other `AgencyFunction` instances: fine (recursive serialization via FunctionRefReviver)
- Non-serializable values (file handles, etc.): fail at serialize time (same constraint as any stack frame local)

## Tool Name Resolution in runPrompt

When the LLM calls a tool, `runPrompt` looks up the handler by name (line ~304 in prompt.ts):

```typescript
const handler = toolFunctions.find((fn) => fn.name === toolCall.name);
```

The LLM receives tool definitions from `toolDefinition.name`. For inner functions, both `AgencyFunction.name` and `toolDefinition.name` are the **short name** (e.g., `"readSkill"`), so this lookup works correctly.

The namespaced `closureKey` (`"skill::readSkill"`) is only used for registry lookup during serialization/deserialization — it never appears in the LLM's tool schema.

## Closure Analysis (Preprocessor)

### New scope type: `captured`

When the preprocessor encounters a `def` inside another `def` or `node`, it creates a new scope. Variables referenced from the enclosing function scope get a new scope type:

- Variables declared in the inner function → `local`
- Variables from the enclosing function's args or locals → `captured`
- Variables from the global scope → `global` (unchanged)
- Imports → `imported` (unchanged)
- Function references → `functionRef` (unchanged)

### Algorithm

The preprocessor already walks up the scope chain for variable resolution (it does this for blocks). The extension:

1. When resolving a variable inside an inner function body, if it resolves to a local/arg in an enclosing FUNCTION scope (not the immediate function — that's just `local`), mark it as `captured`.
2. Collect the set of captured variables for each inner function definition and attach it to the AST node.

### What the builder receives

The inner function's AST node carries a `capturedVariables` list:

```
capturedVariables: [
  { name: "multiplier", sourceScope: "outer", sourceType: "local" },
  { name: "dir", sourceScope: "outer", sourceType: "arg" },
]
```

The builder uses this to:
1. Generate the `closureData` snapshot at the creation point
2. Generate the `__closureInit` block in the hoisted implementation
3. Rewrite variable references in the inner function body from `__self.multiplier` to `__self.__c_multiplier`

### Nested closures (closures capturing from closures)

```
def a() {
  const x = 1
  def b() {
    const y = 2
    def c(): number {
      return x + y
    }
    return c
  }
  return b
}
```

When `b()` captures `x` from `a()`, `x` becomes a closure variable in `b`'s locals as `__c_x`. When `c()` captures from `b()`, it sees `__c_x` and `y` as locals of `b` — both are capturable. The preprocessor doesn't need to know whether `__c_x` was itself captured; it's just a local in `b`'s scope.

In the compiled output:
- `b`'s closureData: `{ x: __self.x }` (from `a`'s frame)
- `c`'s closureData: `{ x: __self.__c_x, y: __self.y }` (from `b`'s frame)

Each level snapshots from its immediate enclosing scope's locals. No transitive capture needed.

### Distinguishing from blocks

Blocks already capture from enclosing scope and reference `__stack` directly. Inner functions are different:
- Blocks execute immediately in the same stack frame context.
- Inner functions are values that may be called later, in a different context.

The preprocessor distinguishes these via AST node type: blocks are `blockExpression` nodes, inner functions are `functionDefinition` nodes nested inside another function.

### Tool/async marking

The preprocessor should NOT mark inner function definitions as async LLM calls or tool registrations. Inner functions become tools only when passed to `llm()` at the call site. The preprocessor treats the inner `def` as a regular assignment step.

## Builder Changes

### Detecting inner function definitions

When processing a `functionDefinition` node, the builder checks if it's nested inside another function (the current scope is a function/node body, not the module top level). If so, it's an inner function.

### What the builder emits for an inner function

1. **Hoisted implementation** (emitted at module level):
   - Full function with `setupFunction`, step tracking, interrupt support
   - `__closureInit` block that copies closure data into locals
   - Variable references for captured vars use `__self.__c_varName`

2. **Closure registry entry** (emitted at module level):
   ```typescript
   __closureRegistry["main.agency:outer::inner"] = {
     fn: __outer__inner_impl,
     params: [{ name: "y", hasDefault: false, defaultValue: undefined, variadic: false }],
   };
   ```

3. **Creation point** (emitted inline where the `def` appears in the outer function):
   ```typescript
   __self.inner = new AgencyFunction({
     name: "inner",
     module: "main.agency",
     fn: __outer__inner_impl,
     params: [{ name: "y", hasDefault: false, defaultValue: undefined, variadic: false }],
     toolDefinition: { name: "inner", description: `...`, schema: ... },
     closureData: { multiplier: __self.multiplier, dir: __args.dir },
     closureKey: "outer::inner",
   });
   ```

### Step tracking at the creation point

The inner function definition IS a step in the outer function. It gets a step number and participates in the step counter for interrupt resume.

### Tool definition generation

The inner function's tool definition (Zod schema, description) is generated at the creation point using the same logic as top-level functions, but the description template is evaluated as a runtime expression rather than a static string.

## Typechecker Changes

- Inner function definitions typecheck like top-level functions — params, return type, body.
- Captured variable types are inferred from the enclosing scope.
- Template expressions in docstrings must reference in-scope variables.
- Same-name inner functions within the same outer function are rejected.
- The return type of a function that returns an inner function is `AgencyFunction` (or a more specific function type if we add that later).
- `export` on inner function definitions is rejected (inner functions are not at module scope).
- `safe` on inner function definitions is allowed and handled the same as top-level functions.

## Formatter Changes

The formatter (`AgencyGenerator`) needs to handle nested `def` statements. Changes:
- Indent inner function definitions to match the enclosing scope
- Handle blank lines around inner function definitions (same rules as top-level functions)
- Format `safe def` inside function bodies

## Debugger and Source Map Changes

Inner functions are hoisted to module level in compiled output, but the debugger should show the original nested source location.

- The Runner for a hoisted inner function uses `scopeName` set to the user-facing namespaced name (e.g., `"outer::inner"`), not the implementation name (`"__outer__inner_impl"`)
- Source map entries for the hoisted implementation point back to the original nested `def` position in the `.agency` file
- Stepping into an inner function call works the same as stepping into a regular function — the debugger enters the hoisted implementation's steps via the Runner's `debugStep` hooks

No fundamental issues expected — inner functions get full Runner/step tracking, so the debugger's checkpoint and time-travel features work as-is. The main work is ensuring the source mapping displays correctly.

## Parser Changes

Minimal. The parser already knows how to parse `def`. The changes:
- Allow `functionDefinition` nodes inside `functionBody` / `nodeBody` (currently only allowed at the top level).
- Parse docstrings with template expressions as template literals rather than plain strings (if not already the case).

## Edge Cases

### Captured variable is an AgencyFunction

```
def outer() {
  def helper(): string { return "hi" }

  def tool(): string {
    """Uses helper internally"""
    const result = helper()
    return result
  }

  return tool
}
```

`tool` captures `helper`. `helper` is itself an `AgencyFunction`. This works because:
- `AgencyFunction` instances are serializable via `FunctionRefReviver`
- `closureData: { helper: <AgencyFunction> }` serializes recursively
- On deserialization, `helper` is revived first (it has its own closureKey), then `tool`'s closure data gets the revived instance

### Captured variable is mutated after creation

```
def outer() {
  let x = 1
  def inner(): number { return x }
  x = 2
  return inner
}
```

`inner` captures `x` at the point of the `def inner()` statement. The closure snapshot is taken at that point, so `closureData.x = 1`. The subsequent `x = 2` does NOT affect the captured value (shallow copy of a primitive). See the "Snapshot semantics" section above for object behavior.

### Inner function calls another inner function

```
def outer() {
  def a(): number { return 1 }
  def b(): number {
    return a()
  }
  return b
}
```

`b` captures `a`. When `b` is invoked, it reads `a` from its closure data and calls it via `__call()`. This works because `a` is an `AgencyFunction` stored in `b`'s closure.

### Inner function with no captures

```
def outer() {
  def inner(x: number): number { return x + 1 }
  return inner
}
```

If the inner function captures nothing, `closureData` is `null`. The hoisted implementation has no `__closureInit` block. It behaves identically to a top-level function, just defined in a nested position.

### Recursive inner functions

```
def outer() {
  def fib(n: number): number {
    if (n <= 1) { return n }
    return fib(n - 1) + fib(n - 2)
  }
  return fib
}
```

`fib` references itself. A naive approach would store the `AgencyFunction` in its own `closureData`, creating a circular reference that breaks `JSON.stringify`. Instead, we use a **sentinel value** (`"__self__"`).

At creation time, the builder emits:

```typescript
__self.fib = new AgencyFunction({
  name: "fib",
  module: "main.agency",
  fn: __outer__fib_impl,
  params: [...],
  toolDefinition: ...,
  closureData: { fib: "__self__" },
  closureKey: "main.agency:outer::fib",
});
```

No circular reference — `closureData.fib` is just the string `"__self__"`.

In `invoke()`, `__state.self` is set to the `AgencyFunction` instance itself (alongside `__state.closure`):

```typescript
const effectiveState = this.closureData
  ? { ...(state as any), closure: this.closureData, self: this }
  : state;
```

In the hoisted implementation's `__closureInit` block, the sentinel is replaced with the actual instance:

```typescript
if (__self.__closureInit === undefined) {
  __self.__closureInit = true;
  for (const [k, v] of Object.entries(__state.closure)) {
    __self[`__c_${k}`] = v === "__self__" ? __state.self : v;
  }
}
```

In `FunctionRefReviver.serialize()`, self-references are detected and emitted as the sentinel:

```typescript
if (value.closureData) {
  result.closureData = {};
  for (const [k, v] of Object.entries(value.closureData)) {
    result.closureData[k] = v === value ? "__self__" : v;
  }
}
```

In `FunctionRefReviver.revive()`, the sentinel is replaced after construction:

```typescript
const fn = new AgencyFunction({ ... });
if (fn.closureData) {
  for (const [k, v] of Object.entries(fn.closureData)) {
    if (v === "__self__") fn.closureData[k] = fn;
  }
}
return fn;
```

The builder detects self-references during closure analysis (the inner function's name appears in its own captured variables list) and emits the sentinel pattern.

Note: mutual recursion between two inner functions (`a` calls `b`, `b` calls `a`) would also create cycles. This can be deferred — it's rare in practice. If needed later, the sentinel can be extended to `"__ref__:outer::a"` to reference other inner functions by key.

### Inner function used as tool — interrupts

```
def skill(dir: string) {
  const files = listFiles(dir)

  def readSkill(filename: string): string {
    return interrupt("Read ${filename}?")
    return readFile("${dir}/${filename}")
  }

  return readSkill
}

node main() {
  const tool = skill("./skills")
  handle {
    const result = llm("Pick a skill", { tools: [tool] })
  } with (data) {
    return approve()
  }
}
```

When the LLM calls `readSkill`:
1. `runPrompt` finds `tool` in the tools array by matching `fn.name` ("readSkill") against `toolCall.name`
2. Calls `tool.invoke({ type: "named", namedArgs: { filename: "foo.md" } }, state)`
3. `invoke()` injects `closureData` into state as `state.closure`
4. The hoisted implementation runs with full step tracking
5. `interrupt()` fires — the stack frame (with `__c_dir`, `__c_files` in locals) is serialized
6. On resume, `setupFunction` restores the frame — closure data is already in locals via `__closureInit`
7. Execution continues past the interrupt

The closure data does NOT need to be re-injected from `__state.closure` on resume — it was copied into the stack frame's locals on first init, and the frame was serialized with those values.

### Inner function defined inside a loop

```
def createTools(items: string[]) {
  const tools = []
  for (item in items) {
    def handler(query: string): string {
      """Handles ${item}"""
      return process(item, query)
    }
    tools.push(handler)
  }
  return tools
}
```

Each iteration creates a new `AgencyFunction` with the same `closureKey` (e.g., `"main.agency:createTools::handler"`) but different `closureData` (different `item` value). This works because:
- The `closureKey` maps to the static hoisted implementation (shared code)
- The `closureData` is per-instance (different data on each `AgencyFunction`)
- On serialization, each instance serializes its own `closureData`
- On deserialization, each is revived with its own `closureData` + the shared implementation

### Inner function inside a conditional

```
def outer(mode: string) {
  if (mode == "a") {
    def handler(): string { return "mode a" }
    return handler
  }
  return null
}
```

The hoisted implementation and closure registry entry are always emitted (they're static module-level code). Unused registry entries are harmless. The conditional branch's step tracking ensures the `closureData` snapshot and `AgencyFunction` construction only happen when the branch executes.

### `safe` keyword on inner functions

Inner functions can be marked `safe`:

```
def outer() {
  safe def helper(x: number): number {
    return x + 1
  }
  return helper
}
```

The `safe` annotation is stored on the `AgencyFunction` and affects retry behavior when the inner function is used as a tool, same as top-level functions.

### `export` on inner functions

Inner functions cannot be exported — they are defined inside a function body, not at module scope. The typechecker rejects `export` on inner function definitions.

### Direct calls to inner functions via `__call()`

When an inner function is called directly in Agency code (not as a tool by the LLM):

```
def outer() {
  def inner(x: number): number { return x + 1 }
  const result = inner(5)
}
```

The compiled code uses `__call(target, descriptor, state)`. The `target` is the `AgencyFunction` in `__self.inner`. `__call` checks `AgencyFunction.isAgencyFunction(target)` and calls `target.invoke(descriptor, state)`. The `invoke` method then injects closure data into state. This works identically to the tool-call path.

## Testing Strategy

### Unit tests (`lib/runtime/agencyFunction.test.ts`)

- `AgencyFunction` with `closureData` — invoke injects closure into state
- `closureData: null` — invoke passes state unchanged
- `closureKey` field stored correctly
- Serialization round-trip with closureData
- Serialization of nested closureData (closure containing another AgencyFunction)

### Unit tests for FunctionRefReviver

- `serialize()` includes closureKey/closureData/toolDefinition/params when closureKey present
- `serialize()` produces minimal output for non-closure functions (backward compatible)
- `revive()` reconstructs AgencyFunction from closureRegistry + closureData
- `revive()` falls back to toolRegistry for non-closure functions
- Round-trip with closureData containing various types (primitives, objects, arrays, AgencyFunction)

### Preprocessor tests

- Variable inside inner function referencing enclosing local → marked as `captured`
- Variable inside inner function referencing enclosing arg → marked as `captured`
- Variable inside inner function referencing global → marked as `global` (not captured)
- Variable inside inner function referencing its own local → marked as `local`
- Nested inner functions — correct capture attribution at each level
- Inner function with no captures — empty captured list
- Self-referencing inner function detected

### Parser tests

- `def` inside `def` body parses correctly
- `def` inside `node` body parses correctly
- Multiple `def`s inside one function
- Nested `def` inside `def` inside `def`
- Docstring with template expression inside inner function

### Builder / fixture tests (`tests/typescriptGenerator/`)

- Inner function hoisted to module level with correct name
- Closure registry entry generated with fn and params
- closureData snapshot generated at creation point
- `__closureInit` block in hoisted implementation
- Captured vars rewritten to `__self.__c_varName`
- Dynamic docstring compiled as template literal at creation point
- Step tracking in hoisted implementation
- Self-referencing inner function uses two-step construction
- `AgencyFunction.name` is short name, `closureKey` is namespaced

### Integration tests (`tests/agency/`)

- Define inner function, call it — basic closure works
- Define inner function, return it, caller calls it — closure survives return
- Inner function captures multiple variables
- Inner function captures an argument of the outer function
- Inner function captures another AgencyFunction
- Nested closures (3 levels)
- Inner function used as tool with `llm()` — LLM calls it successfully
- Inner function throws interrupt — serialize, resume, completes
- Inner function in a handler block — interrupt propagation works
- Inner function in fork — each branch gets correct closure
- Dynamic docstring with template expression — LLM sees correct description
- Snapshot semantics — reassignment after def doesn't affect closure
- Recursive inner function works correctly
- Inner function with no captures works (closureData is null)
- Inner function defined inside a loop — each iteration captures different data
- Inner function passed cross-module — interrupt resume works
- Two different outer functions with same-named inner functions — tool name collision (first match wins, same as regular functions)
- `safe` inner function used as tool — retry works correctly
- Inner function inside a conditional branch — only created when branch executes

## Implementation Phases

### Phase 1: Runtime changes

- Create `lib/runtime/closureRegistry.ts` with `registerClosure()` and `lookupClosure()`
- Add `closureData` and `closureKey` fields to `AgencyFunction` constructor and class
- Update `invoke()` to inject closure data and self-reference into state
- Update `FunctionRefReviver` to serialize/revive closure functions using the global registry
- Handle `__self__` sentinel in serialize/revive for recursive inner functions
- Unit tests for AgencyFunction and FunctionRefReviver changes

### Phase 2: Parser

- Allow `functionDefinition` inside function/node bodies
- Ensure docstring template expressions parse correctly in nested position
- Parser tests

### Phase 3: Preprocessor — closure analysis

- Detect inner function definitions (nested `def`)
- Walk scope chain to identify captured variables
- Mark captured variables with new `captured` scope type
- Attach `capturedVariables` metadata to inner function AST nodes
- Detect self-references for recursive inner functions
- Preprocessor tests

### Phase 4: Builder — code generation

- Hoist inner function implementations to module level
- Generate `registerClosure()` calls at module level (with module-prefixed keys)
- Generate `closureData` snapshot at creation point
- Generate `__closureInit` block in hoisted functions (with `__self__` sentinel handling)
- Rewrite captured variable references to `__self.__c_varName`
- Compile dynamic docstrings as runtime template literals
- Generate unique namespaced names for hoisted functions
- Handle self-referencing inner functions (sentinel pattern)
- Fixture tests

### Phase 5: Typechecker

- Type-check inner function bodies with captured variable types in scope
- Validate captured variables are used correctly
- Reject same-name inner functions in same outer function
- Reject `export` on inner function definitions
- Allow `safe` on inner function definitions
- Infer return type when returning an inner function

### Phase 6: Formatter and debugger

- Update formatter to handle nested `def` statements (indentation, blank lines)
- Ensure source maps for hoisted implementations point to original nested `def` location
- Set `scopeName` to user-facing namespaced name (e.g., `"outer::inner"`) in hoisted implementations

### Phase 7: Integration tests and documentation

- Full end-to-end tests (see testing strategy above)
- Interrupt survival tests
- Dynamic tool with LLM tests
- Cross-module inner function tests
- Write `docs/dev/closures.md` documenting the mental model, data flow, and naming conventions
- Update the language guide to document nested functions and snapshot semantics
