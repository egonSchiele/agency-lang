# Type Checker

The type checker (`lib/typeChecker.ts`) uses **bidirectional type checking** to catch type errors in Agency programs before they are compiled to TypeScript. It can be run standalone via `agency typecheck` or integrated into the compile/run pipeline via config flags.

This document explains what bidirectional type checking is, how it's implemented for Agency, the special cases required by the language, and how it gets triggered.

## What is bidirectional type checking?

Traditional type checkers work in one direction: they look at an expression and try to figure out what type it is (bottom-up). Bidirectional type checking adds a second direction: sometimes we already _know_ what type an expression should be, and we push that expectation _down_ into the expression (top-down).

These two directions are called **synth mode** and **check mode**:

- **Synth mode** (bottom-up, also called "synthesis"): Given an expression with no context, figure out what type it produces. For example, `1 + 2` synthesizes to `number`, and `greet("Alice")` synthesizes to whatever `greet`'s return type is.

- **Check mode** (top-down): Given an expression _and_ an expected type, verify they're compatible. For example, in `x: number = greet("Alice")`, we check that the return type of `greet` is compatible with `number`.

The key insight is that some expressions are easier to handle in one mode than the other. Prompts (`>>> "..."`) are the best example in Agency: in synth mode, a prompt can only be inferred as `string`. But in check mode, we know the prompt will produce structured output matching the expected type, so we skip the check entirely. This is what makes bidirectional checking more powerful than pure bottom-up inference.

## Architecture overview

The type checker is implemented as the `TypeChecker` class. When `check()` is called, it runs four phases in order:

```
1. collectTypeAliases()   — gather all `type Foo = ...` definitions
2. collectFunctionDefs()  — gather all function and graph node definitions
3. inferReturnTypes()     — infer return types for functions/nodes without explicit annotations
4. checkScopes()          — build scopes, collect variable types, then check
```

### Scopes

The checker builds a `ScopeInfo` for each independent scope in the program:

- **Top-level scope**: all nodes at the program root
- **Function scopes**: one per `def` block, seeded with parameter types
- **Graph node scopes**: one per `node` block, seeded with parameter types

Each scope tracks a `variableTypes` map (`Record<string, VariableType | "any">`) that maps variable names to their known types. The string `"any"` is used as a sentinel meaning "we don't know this variable's type."

### Variable type collection

Within each scope, `collectVariableTypes` makes two passes over the AST nodes:

**Pass 1 — Type hints**: Collects standalone `TypeHint` nodes (e.g., `x: number` on its own line) into a lookup table. These are used to type variables whose assignment doesn't have an inline annotation.

**Pass 2 — Assignments and other bindings**: For each assignment, the checker follows one of three paths:

| Situation | What happens |
|-----------|-------------|
| Assignment has a type annotation (inline or from a standalone hint) | Validate the annotation references exist, check reassignment consistency if the variable was already typed, **check the value against the annotation** (check mode), then bind the variable to the annotated type. |
| Variable was previously typed but this assignment has no annotation | Synth the value's type and verify it's compatible with the existing type. |
| No annotation anywhere | Synth the value's type and bind the variable to the inferred type. In `strictTypes` mode, this is an error. |

This pass also handles:
- **`importStatement`**: all imported names are registered as `"any"`
- **`forLoop`**: the item variable gets the array's element type (or `"any"` if the iterable isn't a known array type), the index variable gets `number`, and the loop body is recursively collected

After the assignment pass, the checker walks into nested blocks (`ifElse`, `whileLoop`, `messageThread`) to collect any variable types declared inside them.

### Checking phase

After variable types are collected, two checks run over each scope:

1. **Function call checking** (`checkFunctionCallsInScope`): walks every function call in the scope and validates arity and argument types.
2. **Return type checking** (`checkReturnTypesInScope`): for scopes with a declared return type, checks every `return` statement's value against the expected return type using **check mode**.

## Synth mode: `synthType`

`synthType(expr, scopeVars)` takes an AST node and the current scope's variable map, and returns a `VariableType | "any"`. Here's how each expression type is handled:

| Expression type | Synthesized type |
|----------------|-----------------|
| `variableName` | Look up in scope; return the stored type or `"any"` if unknown |
| `number` | `number` |
| `string`, `multiLineString` | `string` |
| `boolean` | `boolean` |
| `prompt` | `string` (in synth mode; see check mode for the special case) |
| `binOpExpression` | See [Binary operators](#binary-operators) below |
| `functionCall` | The function's declared return type, then inferred return type (see [Return type inference](#return-type-inference)), or `"any"` if unknown |
| `agencyArray` | See [Arrays](#arrays) below |
| `agencyObject` | See [Objects](#objects) below |
| `valueAccess` | See [Value access chains](#value-access-chains) below |
| anything else | `"any"` |

### Binary operators

The operator determines the result type:

- **Comparison and logical operators** (`==`, `!=`, `<`, `>`, `<=`, `>=`, `&&`, `||`): always `boolean`
- **`+` operator**: `string` if either operand synthesizes to `string` (string concatenation), otherwise `number`
- **All other arithmetic** (`-`, `*`, `/`, `+=`, `-=`, `*=`, `/=`): always `number`

### Arrays

Array type inference works as follows:

1. Empty array `[]` returns `any[]` (an array type with `any` element type)
2. If any item is a splat expression (`...x`), bail out and return `"any"` (can't easily infer splat types)
3. Synth each item's type. Filter out `"any"` results.
4. If all concrete types are mutually assignable (checked both directions with `isAssignable`), return an array of that element type. For example, `[1, 2, 3]` returns `number[]`.
5. If types are mixed (e.g., `[1, "hello"]`), return `"any"`.

### Objects

Object type inference synthesizes each entry's value type:

1. If any entry is a splat expression, bail out and return `"any"`
2. If any entry's value synthesizes to `"any"`, bail out and return `"any"`
3. Otherwise, return an `objectType` with the inferred property types. For example, `{name: "Alice", age: 30}` returns `{name: string, age: number}`.

### Value access chains

`synthValueAccess` walks the access chain step by step, starting from the base expression's synthesized type:

| Chain element | Resolution |
|--------------|-----------|
| `.property` on an `objectType` | Look up the property name; return its type, or `"any"` if not found |
| `.length` on an `arrayType` | Return `number` |
| `[index]` on an `arrayType` | Return the element type |
| `.methodCall(...)` | Return `"any"` (method return types aren't tracked) |
| Any step on an unresolvable type | Return `"any"` |

Type aliases are resolved at each step via `resolveType`, so a variable typed as `User` (where `type User = {name: string}`) will correctly resolve `user.name` to `string`.

## Check mode: `checkType`

`checkType(expr, expectedType, scopeVars, context)` verifies that an expression is compatible with an expected type. It works by:

1. If the expression is a `prompt`, **skip entirely** (see [Prompts](#prompts) below)
2. Synth the expression's type
3. If the synth result is `"any"`, skip (we can't say anything useful)
4. Otherwise, check assignability and push an error if incompatible

Check mode is used in two places:
- **Annotated assignments**: `x: number = someExpr()` checks `someExpr()` against `number`
- **Return statements**: `return someExpr()` checks `someExpr()` against the function's declared return type

## Builtin function signatures

Builtin functions have type signatures defined in the `BUILTIN_FUNCTION_TYPES` constant. These are checked just like user-defined functions (arity + argument types), but their signatures come from the constant rather than from AST parameter nodes.

| Function | Parameters | Return type |
|----------|-----------|-------------|
| `print`, `printJSON` | `(any)` | `void` |
| `input` | `(string)` | `string` |
| `read`, `readImage` | `(string)` | `string` |
| `write` | `(string, string)` | `void` |
| `fetch` | `(string)` | `string` |
| `fetchJSON`, `fetchJson` | `(string)` | `any` |
| `sleep` | `(number)` | `void` |
| `round` | `(number)` | `number` |

Note that `print` accepts `any`, so passing any type to it is always valid. `fetchJSON` returns `any` because JSON responses have unknown structure.

## Type assignability: `isAssignable`

`isAssignable(source, target)` determines whether a value of type `source` can be used where `target` is expected. The rules, checked in order:

1. If either side is `"any"`, return `true` (any is compatible with everything)
2. Resolve type aliases on both sides
3. **Union as target**: source must be assignable to _at least one_ member
4. **Union as source**: _every_ member must be assignable to target
5. **Literal to primitive**: `"hello"` (string literal type) is assignable to `string`, `42` (number literal type) to `number`, etc.
6. **Same-kind matching**: two primitive types match if their values are equal; two literal types match if their values are equal; two array types match if their element types are assignable; two object types use structural matching (source must have all target properties with compatible types)
7. Otherwise, return `false`

## Special cases for Agency

### Prompts

Prompts (`>>> "..."`) are the most important special case. In Agency, a prompt's output type depends on context: if assigned to a variable with a type annotation, the LLM is instructed to produce structured output matching that type. This means:

- In **synth mode**, a prompt synthesizes to `string` (we don't know what type to ask the LLM for)
- In **check mode**, a prompt is **skipped entirely** — it's always considered compatible with the expected type, because the code generator will use that type to request structured output from the LLM

This means `result: {name: string} = >>> "What is your name?"` passes type checking (check mode skips the prompt), while `greet(>>> "pick a name")` would synth the prompt as `string` and check it against `greet`'s parameter type.

### Splat expressions

Splat expressions (`...x`) in arrays and objects cause the type checker to bail out and return `"any"`. Tracking what types a splat contributes would require knowing the full type of the splatted expression and decomposing it, which isn't implemented.

### Imported names

Imported variables are registered as `"any"` since the type checker operates on a single file and doesn't resolve imports across files.

### For loops

For loop variables are inferred from the iterable:

```
names: string[] = ["Alice", "Bob"]
for name, i in names {
  // name is inferred as string (element type of string[])
  // i is inferred as number (always)
}
```

If the iterable isn't a known array type, both the item and index variables are `"any"`.

## Return type inference

Functions and graph nodes without an explicit return type annotation have their return types inferred from `return` statements. This happens in the `inferReturnTypes()` phase, before scopes are checked, so that call sites get proper type checking.

For each function/node without a `returnType`, the inference works as follows:

1. Build the scope's variable types (parameters + body assignments)
2. Collect all `return` statements from the body, skipping returns inside nested function/node definitions
3. Synth the type of each return value
4. Apply these rules:

| Situation | Inferred type |
|-----------|--------------|
| No return statements | `void` |
| Any return value synths to `"any"` | `"any"` (conservative — avoids cascading false errors) |
| All return values have the same type | That type |
| Return values have different types | `"any"` (could be union in the future) |

**Recursion guard**: If function A calls function B which calls function A, the inference detects the cycle via an `inferringReturnType` set and returns `"any"` for the recursive call, preventing infinite loops.

**Explicit annotations take precedence**: If a function has a declared `returnType`, inference is skipped entirely and the declared type is used.

## When the type checker runs

There are three ways the type checker gets triggered:

### 1. Standalone command: `agency typecheck`

Run directly via the CLI:

```bash
pnpm run agency typecheck myfile.agency
pnpm run agency typecheck --strict myfile.agency
```

The `--strict` flag enables `strictTypes` mode, where variables without type annotations are errors. If any errors are found, the process exits with code 1.

### 2. Compile/run pipeline via config

Add to your `agency.json`:

```json
{
  "typeCheck": true
}
```

With `typeCheck: true`, type errors are printed as **warnings** during compilation (and by extension during `run`, since `run` calls `compile`). Compilation continues and the output file is still generated. This is useful during development when you want to see type issues without blocking your workflow.

```json
{
  "typeCheckStrict": true
}
```

With `typeCheckStrict: true`, type errors are **fatal**. They are printed to stderr and the process exits with code 1 before any code is generated. This is useful for CI or for catching errors before deployment.

Both flags are checked in the `compile()` function in `lib/cli/commands.ts`, after parsing and before code generation.

### 3. Programmatic API

You can call the type checker directly from TypeScript:

```typescript
import { typeCheck, formatErrors } from "./lib/typeChecker.js";

const result = typeCheck(parsedProgram, config);
if (result.errors.length > 0) {
  console.error(formatErrors(result.errors));
}
```

## Error messages

Each error is a `TypeCheckError` object with these fields:

```typescript
type TypeCheckError = {
  message: string;        // Human-readable error description
  variableName?: string;  // The variable involved, if applicable
  expectedType?: string;  // Formatted expected type string
  actualType?: string;    // Formatted actual type string
};
```

The `formatErrors` function renders errors for terminal output, prefixing each with a red "error" label:

```
error: Argument type 'number' is not assignable to parameter type 'string' in call to 'greet'.
error: Type 'string' is not assignable to type 'number' (assignment to 'response').
error: Expected 2 argument(s) for 'write', but got 1.
```

The different error contexts produce different message shapes:

| Context | Message format |
|---------|---------------|
| Function call argument mismatch | `Argument type 'X' is not assignable to parameter type 'Y' in call to 'funcName'.` |
| Function call arity mismatch | `Expected N argument(s) for 'funcName', but got M.` |
| Assignment value vs annotation | `Type 'X' is not assignable to type 'Y' (assignment to 'varName').` |
| Variable reassignment | `Type 'X' is not assignable to type 'Y'.` |
| Return type mismatch | `Type 'X' is not assignable to type 'Y' (return in 'funcName').` |
| Undefined type alias | `Type alias 'X' is not defined (referenced in 'context').` |
| Strict mode untyped variable | `Variable 'x' has no type annotation (strict mode).` |

Type names in error messages are formatted by `formatTypeHint` from `lib/cli/util.ts`, which renders types in their Agency syntax form (e.g., `number`, `string[]`, `{name: string}`).
