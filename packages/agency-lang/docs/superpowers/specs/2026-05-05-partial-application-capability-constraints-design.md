# Partial Application as Capability Constraint

## Overview

This spec extends the original partial application design (`2026-05-04-partial-application-design.md`) with three additions:

1. **Revised syntax**: `.partial()` method with named-only params, replacing the `?` placeholder syntax
2. **Tool description management**: auto-stripping of `@param` lines and a `.describe()` method for custom descriptions
3. **Known TypeScript Registry**: a generalizable mechanism for making TypeScript functions/methods feel native in Agency

It also reframes partial application as a **capability-constraining mechanism** for tools — one of three pillars alongside interrupts (approval gates) and in-function validation (range constraints).

## Motivation: Capability Constraints

Agency functions are tools. When you pass a tool to an LLM, the agent can use it however it wants. Partial application lets you restrict what a tool can do by fixing some of its parameters:

```
def readFile(dir: string, filename: string) {
  """
  Read a file and return its contents.
  @param dir - The directory to read from
  @param filename - The name of the file to read
  """
  // ...
}

// The agent can read any file on the system
llm("Read some file", { tools: [readFile] })

// The agent can only read files inside ~/foo/
const tool = readFile.partial(dir: "~/foo/")
llm("Read some file", { tools: [tool] })
```

The three capability constraint mechanisms in Agency:

- **Partial application** — fix a value, restrict what the tool can do
- **Interrupts + handlers** — require approval before destructive actions
- **Validation in function bodies** — constrain the range of acceptable values

## Syntax: `.partial()` Method

### Basic usage

```
const add5 = add.partial(a: 5)
const readFoo = readFile.partial(dir: "~/foo/")
```

### Rules

1. `.partial()` is a method on `AgencyFunction`. It takes named parameters corresponding to the original function's params. Named parameters are required — positional binding is not supported.
2. Unmentioned parameters are implicitly unbound. `add.partial(a: 5)` binds `a` and leaves all other params unbound.
3. The resulting function's parameters are the unbound params in original declaration order.
4. Variadic parameters cannot be bound.
5. `.partial()` only works on Agency functions, not imported TypeScript functions. Users can wrap TypeScript functions in Agency functions if needed. `.partial()` does work on Agency functions imported from other Agency modules.
6. Adding new optional parameters to a function does not break existing `.partial()` calls.
7. `.partial()` with no bindings (empty call) returns a clone of the function with identical signature.
8. Binding an already-bound param in a chained `.partial()` call is an error.
9. Duplicate param names in a single `.partial()` call is an error.

### Chained partial application

```
const add5 = add.partial(a: 5)
const add5and2 = add5.partial(b: 2)
```

Each `.partial()` operates on the remaining unbound params.

### Pipe operator

`.partial()` replaces the old `?` pipe placeholder. Each pipe stage is a function expression with exactly one unbound parameter:

```
// Old syntax (removed):
const result = success(10) |> half |> divide(?, 3)

// New syntax:
const result = success(10) |> half |> divide.partial(b: 3)
```

The `?` placeholder is removed from the language entirely.

### Compilation

The Agency compiler sees `readFile.partial(dir: "~/foo/")` and emits:

```typescript
readFile.partial({ dir: "~/foo/" })
```

Named args are compiled to an object literal. The runtime `.partial()` method receives a `Record<string, unknown>` and maps keys to param indices.

## Tool Description Management

### Problem

When a function is partially applied and used as a tool, the original docstring may reference parameters the LLM can no longer see. This is confusing. Additionally, the bound values should not be leaked to the LLM — if the purpose of partial application is to constrain capabilities, revealing the bound value (e.g., a directory path, API key, or connection string) could be a security concern.

### Solution: Auto-stripping `@param` lines

When `.partial()` creates a new bound function, it strips `@param` lines for bound parameters from the tool description. No information about bound values is included — the bound parameters simply disappear from the description.

**Format recognized:** Lines matching `/^\s*@param\s+(\w+)/` — that is, `@param` with optional leading whitespace, followed by the parameter name:

```
@param paramName - Description text
@param paramName Description text (dash is optional)
  @param paramName - Indented is also recognized
```

**Multi-line `@param` entries:** When a `@param` line for a bound parameter is found, all following lines are also stripped until either another `@param` line or a blank line is encountered.

**Example:**

```
def readFile(dir: string, filename: string) {
  """
  Read a file and return its contents.
  @param dir - The directory to read from
  @param filename - The name of the file to read
  """
}

const tool = readFile.partial(dir: "~/foo/")
```

The bound tool's description becomes:

> Read a file and return its contents.
> @param filename - The name of the file to read

**No `@param` lines?** Nothing is stripped. The description passes through unchanged. The schema is still correct (only unbound params), so the LLM gets the right parameters — it just might see prose that mentions the bound param by name. This is acceptable degradation.

**Implementation:** A `stripBoundParams(description, boundParamNames)` helper does the string processing. It is called inside `.partial()`. It runs once at bind time, not on every invocation.

### Solution: `.describe()` method

For full control over the tool description — including dynamic descriptions generated from code — use `.describe()`:

```
const skills = listDir("./skills")
const tool = readSkill.partial(dir: "./skills/")
  .describe("Read a skill file. Available skills: ${join(skills, ', ')}")

llm("Pick a skill to read", { tools: [tool] })
```

**Behavior:**

- Returns a new `AgencyFunction` — does not mutate the original
- Replaces the entire tool description (does not append)
- Works on any `AgencyFunction`, bound or not
- The returned function is otherwise identical (same `fn`, `params`, `schema`, `boundArgs`, etc.)

**Ordering with `.partial()`:** These compose in either order.

- `.describe()` then `.partial()`: auto-stripping runs on the custom description
- `.partial()` then `.describe()`: the custom description replaces whatever auto-stripping produced

**Serialization:** `.describe()` produces a regular `AgencyFunction` with a modified `toolDefinition`. The existing serialization pipeline handles it — the custom description is stored in `toolDefinition.description`.

### Secure by default

The layering is:

1. **Default**: strip `@param` lines for bound params, reveal nothing about bound values
2. **Explicit**: use `.describe()` to share whatever context you choose with the LLM

No information leaks unless the user opts in.

## Known TypeScript Functions and Methods Registry

### Problem

`.partial()` and `.describe()` are TypeScript methods on the `AgencyFunction` class. For them to feel native in Agency (named params, typechecking, correct compilation), the compiler needs to know about them. Currently, builtin functions are special-cased in various places. We want a general mechanism.

### Solution

A registry that maps function/method names to their signatures. The builder and typechecker consult this registry. Adding a new function or method means adding a registry entry, not modifying parser or builder logic.

```typescript
type KnownSignature = {
  params: ParamDef[];
  returnType: TypeDescriptor;
};

type Registry = {
  functions: Record<string, KnownSignature>;
  methods: Record<string, Record<string, KnownSignature>>;  // type -> method -> definition
};
```

**Initial entries:**

```typescript
const registry: Registry = {
  functions: {},
  methods: {
    AgencyFunction: {
      partial: {
        params: [{ name: "bindings", type: "Record<string, any>" }],
        returnType: "AgencyFunction",
      },
      describe: {
        params: [{ name: "description", type: "string" }],
        returnType: "AgencyFunction",
      },
    },
  },
};
```

**Builder rules for registry entries:**

- Registered methods compile as direct method calls (not through `__callMethod`)
- Named args compile to an object literal
- The registry is consulted **after** the builder has resolved named args — the registry signature describes the TypeScript-level method signature (e.g., `Record<string, any>` for `.partial()`), not the Agency-level calling convention with named params

**Typechecker rules for registry entries:**

- The typechecker needs to know the type of a variable to look it up in the registry. For `AgencyFunction` instances, the typechecker already tracks function-reference types (variables assigned from function definitions, import statements, or other `.partial()` calls). The registry key `"AgencyFunction"` maps to this existing internal type representation.
- When the typechecker sees `foo.method(...)`, it checks if the type of `foo` has a matching entry in the registry. If not, type error.
- For `.partial()` specifically, the typechecker does extra validation: it checks that the keys in the bindings match actual param names on the function. This special-case logic is keyed off the method name.

**Future extensibility:** New TypeScript functions or methods that should feel native in Agency are added as registry entries. The builder and typechecker handle them automatically as long as the compilation rules (direct call, named args as object) apply.

## AgencyFunction Runtime Changes

### `.partial()` method

```typescript
partial(bindings: Record<string, unknown>): AgencyFunction {
  const originalParams = this.getOriginalParams();
  const boundNames = Object.keys(bindings);

  // Validate: no unknown param names
  for (const name of boundNames) {
    const index = originalParams.findIndex(p => p.name === name);
    if (index === -1) {
      throw new Error(`Unknown parameter '${name}' in .partial() call`);
    }
  }

  // Validate: no re-binding of already-bound params (for chained calls)
  if (this.boundArgs) {
    for (const name of boundNames) {
      const origIndex = originalParams.findIndex(p => p.name === name);
      if (this.boundArgs.indices.includes(origIndex)) {
        throw new Error(`Parameter '${name}' is already bound`);
      }
    }
  }

  // Map param names to indices
  const boundIndices: number[] = [];
  const boundValues: unknown[] = [];
  for (const [name, value] of Object.entries(bindings)) {
    const index = originalParams.findIndex(p => p.name === name);
    boundIndices.push(index);
    boundValues.push(value);
  }

  // Delegate to existing bind() logic (from original spec)
  // which handles chained binds, translateIndices, etc.
  // bind() returns a new immutable AgencyFunction — it does not mutate.
  const bound = this.bind(boundIndices, boundValues);

  // Strip @param lines from description, returning a new AgencyFunction
  // with the updated toolDefinition (immutable — no mutation of bound).
  if (bound.toolDefinition) {
    const strippedDescription = stripBoundParams(
      bound.toolDefinition.description,
      boundNames
    );
    return bound.withToolDefinition({
      ...bound.toolDefinition,
      description: strippedDescription,
    });
  }

  return bound;
}
```

Note: `withToolDefinition()` is a private helper that returns a new `AgencyFunction` with an updated `toolDefinition`, leaving all other fields unchanged. This avoids mutating the `readonly` fields on the instance returned by `bind()`.

### `.describe()` method

```typescript
describe(description: string): AgencyFunction {
  // Returns a new AgencyFunction with updated toolDefinition.
  // Uses withToolDefinition() to clone immutably.
  // An empty string is valid — it clears the description.
  const newToolDef = this.toolDefinition
    ? { ...this.toolDefinition, description }
    : { name: this.name, description, schema: null };
  return this.withToolDefinition(newToolDef);
}
```

Note: `AgencyFunctionOpts` will need to be extended with an optional `boundArgs` field so that `withToolDefinition()` (and any similar clone helpers) can preserve bound state when constructing a new instance.

### `stripBoundParams()` helper

```typescript
function stripBoundParams(
  description: string,
  boundParamNames: string[]
): string {
  const lines = description.split("\n");
  const result: string[] = [];
  let stripping = false;

  for (const line of lines) {
    const paramMatch = line.match(/^\s*@param\s+(\w+)/);
    if (paramMatch) {
      if (boundParamNames.includes(paramMatch[1])) {
        stripping = true;
        continue;
      } else {
        stripping = false;
      }
    } else if (stripping) {
      if (line.trim() === "") {
        // Blank line ends the stripping run.
        // Preserve the blank line in the output so surrounding
        // sections remain separated.
        stripping = false;
        result.push(line);
        continue;
      }
      // Non-blank continuation line of a stripped @param — skip it
      continue;
    }
    result.push(line);
  }

  return result.join("\n");
}
```

## Related Work: Type System and Block Interop

These features are needed to fully realize the capability-constraint pattern. They can be implemented as fast follows if they are too much work for the initial phases.

### Function types in return position

To support the "factory" pattern where a function returns a configured tool:

```
def readSkill(dir: string): (string) => string {
  const files = readDir(dir)
  const desc = "Read a skill. Available: ${join(keys(files), ', ')}"
  return _readSkill.partial(files: files).describe(desc)
}
```

Agency already supports function type syntax in block parameters (`block: (string, number) => any`). This syntax should also work in return type annotations. The typechecker needs to recognize function types in return position and validate that the returned value matches.

### Generic `Function` type

For cases where the full signature isn't important, a generic `Function` type that means "any AgencyFunction":

```
def readSkill(dir: string): Function {
  // ...
}
```

This is useful when the returned function's signature depends on the input (e.g., different partially applied functions with different remaining params). The typechecker treats `Function` as a top type for function values — any `AgencyFunction` is assignable to it.

### Update standard library docstrings to use `@param` format

All functions in the standard library that mention parameters in their docstrings should be updated to use the `@param` format. This ensures that if users partially apply any stdlib function, the bound parameters are correctly stripped from the tool description. This is a fast follow — it doesn't block the core implementation but should be done before the feature is documented as stable.

### Document `@param` convention in the guide

The guide documentation for writing functions/tools should recommend the `@param` format for docstrings and explain the auto-stripping behavior. Users should know that if they use `@param` in their docstrings, partially applying their functions will produce clean tool descriptions automatically.

### AgencyFunction as block parameter

Currently, blocks are compiled inline with special interrupt/serialization support. Passing an `AgencyFunction` (including a PFA) where a block is expected should also work:

```
const double = multiply.partial(a: 2)
const results = map([1, 2, 3], double)
```

This requires the runtime to detect when a block parameter receives an `AgencyFunction` and invoke it through `AgencyFunction.invoke()` rather than calling it as a raw function. This makes the system more composable — any `AgencyFunction` can be used where a block is expected, including partially applied functions.

## Changes to the Original Partial Application Spec

### Removed

- `placeholderExpression` / `?` placeholder syntax in function calls
- Positional binding (`add(5, ?, ?)`)
- Mixed positional/named rules
- Pipe `?` placeholder
- "All positions must be mentioned" rule
- Parser changes for detecting `?` in function calls
- Builder changes for detecting bind expressions

### Changed

- Bind syntax: `add(5, ?, ?)` → `add.partial(a: 5)`
- Pipe syntax: `divide(?, 3)` → `divide.partial(b: 3)`
- Named params only, unmentioned params are implicitly unbound
- `.partial()` is a runtime method on `AgencyFunction`, not a compiled language construct

### Added

- `.describe()` method on `AgencyFunction` for custom tool descriptions
- Auto-stripping of `@param` lines for bound params in tool descriptions
- Known TypeScript Functions/Methods Registry
- Capability-constraint framing

### Unchanged

- `BoundArgs` type and `boundArgs` field on `AgencyFunction`
- `invoke()` / `mergeWithBound()` logic for calling bound functions
- `buildReducedSchema()` for reducing the tool schema
- Serialization/deserialization of bound functions via `FunctionRefReviver`
- `translateIndices()` for chained binds
- Variadic params cannot be bound
- Method partial application not supported (`obj.method.partial(...)` is not valid)

### Note on `uses` keyword

The `uses` keyword is deprecated. Tools are passed via the `tools` option in `llm()` calls. All examples in this spec use the `tools` option. The `uses` keyword does not need special handling for `.partial()` or `.describe()`.

### Docs and tests to update

- Original spec examples: replace `?` syntax with `.partial()` throughout
- `docs-new/guide/` pages that reference pipe `?` syntax
- Any existing test fixtures that use the `?` placeholder in pipes or function calls
- Error handling doc pipe examples (`success(10) |> half |> divide(?, 3)` → `success(10) |> half |> divide.partial(b: 3)`)

## Testing Strategy

### Unit tests (`lib/runtime/agencyFunction.test.ts`)

- `.partial()` with single binding produces correct reduced params
- `.partial()` with multiple bindings at different positions
- `.partial()` on already-bound function (chained binding)
- `.partial()` with no bindings (produces identical signature)
- `.partial()` with invalid param name throws error
- `.partial()` with duplicate param names in a single call throws error
- Chained `.partial()` re-binding an already-bound param throws error
- `invoke()` on partially applied function merges args correctly
- `invoke()` on partially applied function with default params (UNSET handling)
- Serialization round-trip: partially applied function serializes and deserializes correctly
- Serialization round-trip: chained partial application serializes correctly

### `.describe()` tests

- `.describe()` returns new `AgencyFunction` with updated description, original unchanged
- `.describe()` on a partially applied function replaces the auto-stripped description
- `.describe()` on an unbound function works the same
- Described function serializes/deserializes through interrupts
- `.describe("")` clears the description (valid, not an error)

### `stripBoundParams()` tests

- Strips `@param boundName - description` lines
- Strips `@param boundName description` (no dash) variant
- Strips multi-line `@param` entries (continuation lines until next `@param` or blank line)
- Blank line after stripped `@param` is preserved (keeps surrounding sections separated)
- No `@param` lines — description passes through unchanged
- Multiple bound params — all corresponding `@param` lines stripped
- Chained `.partial()` — each call strips newly bound param's `@param` line

### Typechecker tests

- `.partial()` on non-AgencyFunction type — error
- `.partial()` with unknown param name — error
- `.partial()` with variadic param — error
- `.describe()` with non-string argument — error
- `.describe()` on non-AgencyFunction type — error
- Return type inference for partially applied function
- Pipe stage with more than one unbound param — error

### Integration tests (`tests/agency/`)

- Partially apply a function, call the bound function
- Partially apply a function, pass as tool to `llm()`
- Partially apply, interrupt fires, state serializes and deserializes, bound function still works
- Partially apply a function inside a fork block
- Chain two `.partial()` calls
- `.describe()` then use as tool
- `.partial()` then `.describe()` then use as tool
- Pipe with `.partial()` stages

### Fixture tests (`tests/typescriptGenerator/`)

- Verify generated code for `.partial()` call (compiles to direct method call with object arg)
- Verify generated code for `.describe()` call
- Verify generated code for `.partial()` in pipe expression

## Implementation Phases

### Phase 1: Runtime (`AgencyFunction` changes)

- Add `.partial()` method (delegates to existing `bind()` with name-to-index mapping)
- Add `.describe()` method
- Implement `stripBoundParams()` helper
- Unit tests for all of the above

### Phase 2: Known TypeScript Registry

- Define the registry data structure
- Register `AgencyFunction.partial` and `AgencyFunction.describe`
- Update builder to consult registry for method calls (compile as direct calls, named args as objects)
- Update typechecker to consult registry for method validation

### Phase 3: Typechecker

Note: typechecker work comes before pipe changes so that pipe stages with wrong number of unbound params are caught immediately when the `?` placeholder is removed.

- Validate `.partial()` param names against function params
- Validate variadic params cannot be bound
- Validate `.partial()` and `.describe()` only on AgencyFunction types
- Infer result type of `.partial()` expression
- Validate pipe stages have exactly one unbound param

### Phase 4: Pipe operator changes

- Remove `?` placeholder handling from pipe expressions
- Pipe stages are now function expressions; typechecker enforces single unbound param
- Update pipe-related tests and docs

### Phase 5: Update existing docs and tests

- Update original partial application spec examples
- Update `docs-new/guide/error-handling.md` pipe examples
- Update any test fixtures using `?` placeholder syntax
- Add guide documentation for `.partial()`, `.describe()`, and the capability-constraint framing

### Phase 6: Integration tests

- End-to-end agency execution tests
- Interrupt survival tests
- Tool usage tests
- Pipe expression tests
