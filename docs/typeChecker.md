# Type Checker

Agency includes an optional type checker that validates type consistency across your program. It runs after parsing and before code generation, catching type errors early without executing your code.

## Usage

### CLI

```bash
# Type check a file
pnpm run agency typecheck myfile.agency

# Short alias
pnpm run agency tc myfile.agency

# Read from stdin
cat myfile.agency | pnpm run agency tc

# Enable strict mode (untyped variables are errors)
pnpm run agency tc myfile.agency --strict
```

### Programmatic

```ts
import { typeCheck, formatErrors } from "@/typeChecker.js";
import { parse } from "@/cli/commands.js";

const program = parse(source, config);
const { errors } = typeCheck(program, config);

if (errors.length > 0) {
  console.error(formatErrors(errors));
}
```

## What It Checks

### 1. Function call argument types

When a function or graph node declares typed parameters, the checker validates that call-site arguments have compatible types.

```
def greet(name :: string) {
  print(name)
}

count :: number
count = 5
greet(count)  // error: Type 'number' is not assignable to parameter type 'string'
```

### 2. Arity checking

The checker errors if a function is called with the wrong number of arguments.

```
def add(a :: number, b :: number) {
  return a + b
}

add(1)  // error: Expected 2 argument(s) for 'add', but got 1
```

### 3. Return type validation

If a function or graph node declares a return type, all `return` statements in its body are checked for compatibility.

```
def getName(): string {
  return 42  // error: Return type 'number' is not assignable to declared return type 'string'
}
```

### 4. Variable reassignment consistency

If a variable has a declared type (via `::` or inline type hint), reassigning it to an incompatible type is an error.

```
x :: string
x = "hello"
x = getNumber()  // error if getNumber() returns number
```

### 5. Undefined type alias references

Using a type alias that hasn't been defined is an error.

```
type Foo = { name: Bar }  // error: Type alias 'Bar' is not defined
```

### 6. Strict mode

With `--strict` (or `strictTypes: true` in `agency.json`), every variable must have a type annotation. Without strict mode, untyped variables are implicitly `any` and skip type checking.

```
// strict mode
x = 42  // error: Variable 'x' has no type annotation (strict mode)

// non-strict mode
x = 42  // ok, x is 'any'
```

## Type Compatibility Rules

The checker uses the following rules to determine if a source type is assignable to a target type:

| Source | Target | Assignable? |
|--------|--------|-------------|
| `any` | anything | yes |
| anything | `any` | yes |
| `"hello"` (string literal) | `string` | yes |
| `42` (number literal) | `number` | yes |
| `true` (boolean literal) | `boolean` | yes |
| `string` | `number` | no |
| `T` | `T \| U` (union target) | yes, if assignable to any member |
| `T \| U` (union source) | `V` | yes, if every member assignable to V |
| `string[]` | `number[]` | no (element types must match) |
| `{ a: string, b: number }` | `{ a: string }` | yes (structural, source has all target props) |
| `{ a: string }` | `{ a: string, b: number }` | no (source missing `b`) |
| `TypeAlias` | resolved type | resolved before comparison |

## Configuration

Add `strictTypes` to your `agency.json`:

```json
{
  "strictTypes": true
}
```

Or use the `--strict` CLI flag, which overrides the config value.

## Skipped Checks

- **Builtin functions** (`print`, `input`, `read`, `fetch`, etc.) are skipped since they don't have Agency-level type signatures.
- **External/imported functions** that aren't defined in the current file are skipped.
- **LLM prompt expressions** return `any` since their output type depends on the type hint on the assignment, not the prompt itself.

## Error Output

Errors are printed to stderr in a format inspired by TypeScript's compiler output:

```
error: Type 'number' is not assignable to parameter type 'string' in call to 'greet'.
error: Expected 2 argument(s) for 'add', but got 1.
```

The process exits with code 1 if any errors are found, and prints "No type errors found." on success.

## Architecture

The `TypeChecker` class in `lib/typeChecker.ts` operates in multiple passes:

1. **`collectTypeAliases()`** — Walks top-level nodes for `typeAlias` definitions, validates that referenced aliases exist.
2. **`collectFunctionDefs()`** — Collects `function` and `graphNode` definitions into lookup maps.
3. **`checkScopes()`** — For each scope (top-level, function bodies, graph node bodies):
   - Builds a variable type map from parameters, `TypeHint` nodes, and `Assignment` type hints
   - Checks variable reassignment consistency
   - Enforces strict mode if enabled
   - Validates function call argument types and arity
   - Validates return statement types against declared return types

The checker uses `walkNodes()` from `lib/utils/node.ts` to traverse nested AST structures (if/else, while loops, time blocks, etc.) and `formatTypeHint()` from `lib/cli/util.ts` to render types in error messages.
