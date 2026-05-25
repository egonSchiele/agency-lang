# Generic Functions

## Summary

Add support for generic type parameters on function definitions (`def foo<T>(x: T): T { ... }`). This extends Agency's existing generic type alias support to functions, enabling type-safe generic programming and — critically — allowing `llm()` to be rewritten as a regular Agency function with a generic return type.

## Dependencies

- **Generic type aliases**: Already implemented (commit 3d1af6d4). The infrastructure for parsing generic types, substituting type parameters, and generating Zod schemas from resolved types is in place.

## Motivation

Agency has generic type aliases (`type Container<T> = { value: T }`) but not generic functions. This limits two things:

1. **The `llm()` rewrite.** Making `llm()` a regular Agency function requires `def llm<T>(prompt: string, ...): T` so that `schema(T)` can generate the structured output schema. Without generic functions, there's no way for the caller to specify the return type. (See `2026-05-20-llm-as-agency-function-design.md`.)

2. **User-defined generic functions.** Users can't write functions like `def first<T>(arr: T[]): T` or `def map<A, B>(arr: A[], block: (A) => B): B[]`. These are common patterns that currently require `any`.

## Design

### Syntax

```agency
def first<T>(arr: T[]): T {
  return arr[0]
}

def map<A, B>(arr: A[], block: (A) => B): B[] {
  // ...
}

def identity<T>(x: T): T {
  return x
}
```

Type parameters appear after the function name, inside angle brackets. This is the same syntax as generic type aliases and matches TypeScript/Java/Rust conventions.

### Calling generic functions

#### Explicit type arguments

```agency
const x = first<number>([1, 2, 3])
const y = map<string, number>(names, \name -> name.length)
```

#### Implicit inference from arguments

When the type arguments can be inferred from the argument types, they can be omitted:

```agency
const x = first([1, 2, 3])        // T inferred as number
const y = map(names, \name -> name.length)  // A inferred as string, B as number
```

The compiler infers type arguments by unifying the declared parameter types (with type variables) against the actual argument types.

#### Implicit inference from LHS annotation (return type)

When a function has a single generic parameter that appears only in the return type, the compiler can infer it from the LHS type annotation:

```agency
const numbers: number[] = llm("Return the first 5 Fibonacci numbers")
// T inferred as number[] from the LHS annotation
```

This is the mechanism that makes `llm<T>()` work with the existing type annotation syntax. It is limited to:
- Functions with exactly one type parameter
- Where that type parameter appears in the return type
- And is not constrained by any argument type

If the type parameter appears in both argument types and the return type, argument inference takes priority.

### Default type parameters

Like type aliases, function type parameters can have defaults:

```agency
def fetch<T = string>(url: string): T {
  // ...
}

const data = fetch("https://api.com")          // T = string (default)
const user: User = fetch("https://api.com/me") // T = User (from LHS)
```

Default parameters must come after all required ones, matching the existing rule for type aliases.

### `schema(T)` inside generic functions

Inside a generic function body, `schema(T)` converts the type parameter to a Zod schema at runtime. The mechanism:

1. At the **call site**, the compiler knows the concrete type (e.g., `number[]`). It generates the Zod schema there: `zodSchemaFor(number[])`.
2. The schema is passed as a **hidden parameter** to the function, appended to the argument list by the compiler. One hidden parameter per type parameter that is used with `schema()`.
3. Inside the function body, `schema(T)` compiles to a reference to the hidden parameter.

Example — source:
```agency
def llm<T>(prompt: string): T {
  const s = schema(T)
  return __internal_callLLM(prompt, s)
}

const numbers: number[] = llm("Return Fibonacci numbers")
```

Compiles roughly to:
```typescript
function llm(prompt, __schema_T) {
  const s = __schema_T;
  return __internal_callLLM(prompt, s);
}

const numbers = llm("Return Fibonacci numbers", z.array(z.number()));
```

If `schema(T)` is never called inside the function body, no hidden parameter is generated — the type parameter is compile-time-only (erased).

#### Multiple type parameters

Each type parameter used with `schema()` gets its own hidden parameter:

```agency
def convert<A, B>(input: A): B {
  const fromSchema = schema(A)
  const toSchema = schema(B)
  // ...
}
```

Compiles to:
```typescript
function convert(input, __schema_A, __schema_B) {
  const fromSchema = __schema_A;
  const toSchema = __schema_B;
  // ...
}
```

#### Complex types

`schema(T)` works with any concrete type at the call site, including unions, objects, arrays, and nested generics:

```agency
type Pet = Cat | Dog | Turtle
const result: Pet[] = llm("List some pets")
// Hidden param: z.array(z.union([CatSchema, DogSchema, TurtleSchema]))
```

The complexity is handled at the call site where the type is concrete — the existing `zodSchemaFor()` / `mapTypeToValidationSchema()` pipeline already handles all of these cases.

### Type checking

#### Instantiation

When the type checker encounters a call to a generic function, it **instantiates** the function's type by substituting concrete types for the type parameters. This uses the existing `substituteTypeParams()` function from `lib/typeChecker/substitute.ts`.

Example:
```agency
def first<T>(arr: T[]): T { ... }

first([1, 2, 3])
// Instantiate: T = number
// Parameter type: number[] ✓ (matches [1, 2, 3])
// Return type: number
```

#### Inference algorithm

Type argument inference works by **unification** — matching the declared parameter types against the actual argument types and solving for the type variables:

1. For each argument, walk the declared type and the actual type in parallel.
2. When a type variable is encountered in the declared type, record the mapping: `T → actualType`.
3. If a type variable maps to multiple types (from different arguments), unify them. If they conflict, report an error.
4. After processing all arguments, check if any type variables are still unresolved. If LHS return type inference applies (single unresolved return-type-only param), use the LHS annotation. Otherwise, default to `any` or report an error.

This is a standard Hindley-Milner-style inference, simplified by Agency's type system (no higher-kinded types, no type-level computation).

#### Scope

Type parameters are in scope within the function body only. They cannot escape:

```agency
def first<T>(arr: T[]): T {
  // T is in scope here
  const x: T = arr[0]  // OK
  return x
}
// T is not in scope here
```

### Interaction with existing features

#### Partial application

Partial application works with generic functions. When you partially apply a generic function, the type parameters remain unresolved until the partially-applied function is called:

```agency
def llm<T>(prompt: string, model: string = "gpt-4o"): T { ... }

const gpt4 = llm.partial(model: "gpt-4o")
const numbers: number[] = gpt4("Return Fibonacci numbers")
// T is inferred at the gpt4() call site, not at the .partial() site
```

#### Blocks

Generic functions can accept block parameters. The block's type can reference the function's type parameters:

```agency
def map<A, B>(arr: A[], block: (A) => B): B[] {
  // ...
}

const lengths = map(["hello", "world"]) as item {
  return item.length
}
// A = string, B = number (inferred from block return type)
```

#### Docstrings and tools

Generic functions can have docstrings and be used as tools. When used as a tool, the type parameters must be fully resolved (the LLM can't specify generic types). In practice, this means generic functions used as tools should either have defaults or be partially applied to fix the type:

```agency
const typedLLM = llm.partial(/* ... */)
// When used as a tool, T is resolved at the outer llm() call site
```

#### Validation (bang syntax)

The `!` validation syntax on return types works with generic functions:

```agency
def parse<T>(json: string): T! {
  // Returns Result<T, string> — validated against schema(T)
}
```

The `!` applies to the resolved type, not to `T` as an abstract parameter.

### What generic functions are NOT

- **Not runtime type inspection.** You cannot compare type parameters (`T == number`), branch on them, or use them as values except via `schema(T)`. Type parameters are compile-time-only unless explicitly converted to a schema.
- **Not type constraints.** There are no `T extends Animal` bounds. Any type can be passed for any type parameter. If the function body does something type-specific (like accessing a property), the type checker will catch errors at the call site when the concrete type doesn't have that property.
- **Not higher-kinded.** You can't write `def foo<F<_>>(x: F<number>)` where `F` is itself a generic type constructor. Type parameters are always concrete types.

## Implementation

### Parser changes

**Function definitions:** Extend the function definition parser to accept optional type parameters after the function name:

```
def functionName<TypeParam1, TypeParam2 = DefaultType>(params...): ReturnType { body }
```

The `<TypeParams>` parsing can reuse the existing type parameter parser from type alias declarations. Add `typeParams?: TypeParam[]` to the `FunctionDefinition` AST node. Note: the current `_baseFunctionParser` uses `many1Till(char("("))` to capture the function name, consuming everything up to `(`. This must be modified to also stop at `<`, so the function name is captured before the type parameters.

**Function calls:** Add `typeArgs?: VariableType[]` to the `FunctionCall` AST node. The call-site parser must handle `first<number>([1, 2, 3])` by parsing optional `<TypeArgs>` after the function name.

**Parser ambiguity with `<`:** The syntax `foo<T>(x)` (generic call) is ambiguous with `foo < T > (x)` (two comparisons). The disambiguation strategy: when parsing a function call and encountering `<` after the function name, attempt to parse type arguments first. If that succeeds and is followed by `(`, treat it as a generic call. If parsing type arguments fails, backtrack and parse `<` as a comparison operator. This is the same approach TypeScript uses.

### Type checker changes

1. **Function type representation**: Add `typeParams` to the internal function type. When checking a call to a generic function, instantiate the type by substituting concrete types for parameters using the existing `substituteTypeParams()`.

2. **Inference**: Implement unification-based type argument inference. Walk declared param types vs actual argument types in parallel, collect type variable bindings, resolve. If a type variable maps to conflicting types from different arguments, report a type error.

3. **LHS return type inference**: When a generic function has a single unresolved return-type-only parameter, check for a type annotation on the LHS of the assignment and use it. This requires extending check mode to propagate the expected type into generic call resolution — currently, check mode synthesizes the expression type and then checks assignability, but it does not feed the expected type back into the synthesis. For generic functions, the expected return type must flow into type argument resolution. This is a meaningful extension to the type checker's bidirectional flow.

4. **`schema(T)` detection**: When the compiler sees `schema(T)` where `T` is a type parameter, mark that parameter as "needs runtime schema." This triggers hidden parameter generation in codegen.

### Code generation changes

1. **Hidden schema parameters**: For each type parameter marked "needs runtime schema," append a hidden parameter to the function's compiled parameter list. At each call site, generate the Zod schema for the concrete type and pass it as the hidden argument.

2. **`schema(T)` compilation**: Inside a generic function body, `schema(T)` compiles to a reference to the hidden parameter (e.g., `__schema_T`).

3. **Type erasure**: Type parameters that are NOT used with `schema()` are erased completely — they exist only for type checking and don't appear in generated code.

### Interaction with `processLlmCall`

During the transition period (before `llm()` is fully rewritten as an Agency function), the existing `processLlmCall()` continues to work. Once `llm()` is an Agency function with `def llm<T>(...)`, the compiler treats it like any other generic function call — no special case needed. The LHS type annotation inference resolves `T`, `schema(T)` generates the Zod schema via the hidden parameter mechanism, and the function runs normally.

## Limitations and deferred work

### Nested generic `schema(T)` calls

Calling a `schema(T)`-using generic function from another generic function where `T` is still abstract requires threading the hidden schema parameter through:

```agency
def wrapper<T>(x: string): T {
  return inner<T>(x)  // inner uses schema(T) — needs the schema passed through
}
```

At the call site of `inner<T>(x)` inside `wrapper`, `T` is still a type parameter. The compiler would need to pass `wrapper`'s own `__schema_T` hidden parameter through to `inner`. This is **deferred for the initial implementation**. In the first version, `schema(T)` can only be called with concrete types at the call site. A generic function that calls another generic function using `schema(T)` with an abstract type parameter will produce a compile error. This can be relaxed in a future iteration.

### Async generic functions

`async def foo<T>(...)` is supported — the `async` keyword and type parameters are orthogonal features. No special handling needed.

## Files to modify

### Modified files
- `lib/parsers/parsers.ts` — extend function definition parser to accept `<TypeParams>`, extend function call parser for `<TypeArgs>` at call sites, handle `<` disambiguation
- `lib/types/function.ts` — add `typeParams?: TypeParam[]` to `FunctionDefinition`, add `typeArgs?: VariableType[]` to `FunctionCall`
- `lib/typeChecker/checker.ts` — generic function instantiation, type argument inference, LHS return type inference (check-mode extension)
- `lib/typeChecker/synthesizer.ts` — synthesize return types for generic function calls
- `lib/typeChecker/substitute.ts` — may need extensions for function-level substitution (existing `substituteTypeParams` should work)
- `lib/backends/typescriptBuilder.ts` — hidden schema parameter generation, `schema(T)` compilation inside generic bodies, call site schema argument insertion
- `lib/backends/agencyGenerator.ts` — format generic function signatures (for `agency fmt`)
- `docs/site/guide/types.md` — document generic functions
- `docs/site/guide/functions.md` — document generic functions
