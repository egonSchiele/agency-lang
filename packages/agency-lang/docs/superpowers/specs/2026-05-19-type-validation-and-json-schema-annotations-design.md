# Type Validation & JSON Schema Annotations

## Problem

Agency compiles types to Zod schemas which become JSON schemas sent to LLMs for structured output and tool calling. Currently, users have no way to:

1. Add validation constraints to types (e.g., "this number must be positive", "this string must be an email")
2. Control what JSON Schema properties the LLM sees for a given field (e.g., `minimum`, `format`, `pattern`)

The existing `# description` syntax on type properties is limited to descriptions and has no path to richer metadata.

## Design

### Core Insight: Two Separate Concerns

Validation and LLM schema hints are distinct:

- **Validation** is runtime, imperative, and lives in value space. It checks that a value meets constraints after it's been produced.
- **JSON Schema hints** are declarative metadata in type space. They guide the LLM toward producing correct values in the first place.

These two concerns have different mechanisms, different enforcement models (hard runtime checks vs best-effort LLM guidance), and should have separate syntax.

### Two Annotations

#### `@validate(fn1, fn2, ...)`

Attaches one or more Agency functions as runtime validators.

- Each validator is a regular Agency `def` function that takes a value and returns a `Result`. Return `success(value)` if valid, `failure("reason")` if not.
- **Validators may transform values.** The value returned in `success(value)` becomes the input to the next validator in the chain, and the final value is what the caller observes. This enables coercion (e.g. trimming whitespace, normalizing case) in addition to pure validation. If a validator does not need to transform, it returns `success(x)` with the same value it received.
- Multiple validators can be passed as separate arguments. They run in order on the chained value; the first failure short-circuits.
- Validators only run when the `!` bang syntax is used, consistent with Agency's existing schemas feature (https://agency-lang.com/guide/schemas.html). Keeping all validation behind `!` means users only have to learn one rule for when validation runs.
- Allowed on **type aliases** and **type properties**.

Example validator:

```
def isEven(x: number): Result {
  if (x % 2 != 0) {
    return failure("must be even, got ${x}")
  }
  return success(x)
}
```

Usage:

```
@validate(isEven)
type EvenNumber = number
```

#### `@jsonSchema({ ... })`

Attaches arbitrary properties to the JSON Schema for this type or field.

- Takes an object literal. The properties are passed through to Zod's `.meta()`, which copies them directly into the generated JSON Schema.
- This is what the LLM sees in both structured output response formats and tool parameter schemas.
- Replaces the `# description` syntax entirely. Descriptions are now specified as `@jsonSchema({ description: "..." })`.
- Allowed on **type aliases** and **type properties**.

Usage:

```
@jsonSchema({ format: "email", description: "user's work email" })
type WorkEmail = string
```

### Standard Library

To avoid name collisions between validators and JSON-Schema helpers (e.g. `minLength` could plausibly be either), the stdlib is split into two namespaced modules. The annotations themselves work without the stdlib; these modules ship in the same change so users have a usable surface from day one.

#### `std::validators`

Regular Agency functions returning `Result`. They run only under `!`.

| Function | Description |
|---|---|
| `isEmail(x)` | Validates string is an email |
| `isUrl(x)` | Validates string is a URL |
| `isUuid(x)` | Validates string is a UUID |
| `isInt(x)` | Validates number is an integer |
| `isPositive(x)` | Validates number > 0 |
| `isNegative(x)` | Validates number < 0 |
| `min(n)` | Returns a validator that checks value >= n |
| `max(n)` | Returns a validator that checks value <= n |
| `minLength(n)` | Returns a validator that checks string length >= n |
| `maxLength(n)` | Returns a validator that checks string length <= n |
| `matches(regex)` | Returns a validator that checks string matches regex |

Factory functions like `min(n)` return validator functions.

#### `std::schemas`

Helpers returning objects suitable for use in `@jsonSchema(...)`. Only complex / non-obvious helpers are exported — trivial 1:1 mappings like `{ minimum: 0 }` are simpler to write inline than to import a helper for, so we leave them out and instead link to the relevant JSON Schema documentation from the Agency guide.

| Function | Returns |
|---|---|
| `emailFormat` | `{ format: "email" }` |
| `urlFormat` | `{ format: "uri" }` |
| `uuidFormat` | `{ format: "uuid" }` |
| `dateTimeFormat` | `{ format: "date-time" }` |
| `dateFormat` | `{ format: "date" }` |
| `ipv4Format` | `{ format: "ipv4" }` |
| `ipv6Format` | `{ format: "ipv6" }` |

These are worth shipping because users typically don't remember the exact string keys for `format` (is it `"email"`, `"e-mail"`, `"uri"`, `"url"`?). For numeric / length / array constraints, the Agency guide will include a section documenting which JSON Schema keywords are supported and link to the JSON Schema spec, rather than wrapping each one in a helper.

Users merge multiple helpers and inline properties with spread syntax (already supported in Agency object literals via `splatParser`): `{ ...emailFormat, description: "work email" }`.

#### Pre-baked Validated Types

To eliminate the repetitive `@validate(isEmail) @jsonSchema({ ...emailFormat })` pattern for the most common cases, the stdlib also ships ready-made validated type aliases. These bundle both annotations:

```
// Defined in std::types (sketch)
@validate(isEmail)
@jsonSchema({ ...emailFormat })
type Email = string

@validate(isUrl)
@jsonSchema({ ...urlFormat })
type Url = string

@validate(isUuid)
@jsonSchema({ ...uuidFormat })
type Uuid = string
```

Users can then write:

```
import { Email, Url, Uuid } from "std::types"

type User = {
  email: Email
  homepage: Url
  id: Uuid
}
```

The annotations on these aliases flow through to the property positions automatically (see "How Annotations Flow"). Parameterized validated types like `NumberInRange(0, 150)` require value-parameterized aliases and are deferred — see "Future Work".

### Full Example

```
import { isEmail, min, max } from "std::validators"
import { emailFormat } from "std::schemas"

def isEven(x: number): Result {
  if (x % 2 != 0) {
    return failure("must be even")
  }
  return success(x)
}

@validate(min(1), max(100))
@jsonSchema({ minimum: 1, maximum: 100, description: "a score from 1 to 100" })
type Score = number

type User = {
  @validate(isEmail)
  @jsonSchema({ ...emailFormat, description: "user's work email" })
  email: string

  @validate(min(0), max(150))
  @jsonSchema({ minimum: 0, maximum: 150 })
  age: number

  @validate(isEven)
  score: Score
}

def processUser(user: User!) {
  // user has been validated: email is valid, age is 0-150, score is 1-100 and even
  print(user)
}
```

### Where Annotations Are Allowed

- **Type aliases**: annotations go above the type declaration.
- **Type properties**: annotations go above the property within the type body.
- **NOT on function parameters**: if a user wants validated function parameters, they create a type alias with annotations and use it with `!`.

### How Annotations Flow

When a type alias has annotations and is used as a property type or function parameter type, the annotations flow through. In the example above, `score: Score` inherits the `@validate(min(1), max(100))` and `@jsonSchema(...)` from the `Score` type alias.

Annotations also propagate across **module boundaries and re-exports**. When `type Email` is exported from `std::types` (with its `@validate(isEmail)` and `@jsonSchema(...)` attached), any module that imports `Email` — including modules that re-export it — sees the same annotations. The `TypeAliasEntry` carried by `ScopedTypeAliases` (introduced in the generics work) is widened to carry the alias's `tags` alongside the type parameters, so annotation metadata travels with the alias wherever it is resolved.

#### Merge and Override Rules

When a property has its own annotations AND its type alias has annotations:

- **`@validate`**: validators from both levels are concatenated. Alias validators run first, then property validators.
- **`@jsonSchema`**: property-level properties override alias-level properties for the same keys (last-writer-wins). Properties not overridden are inherited.

Example:

```
@validate(isPositive)
@jsonSchema({ minimum: 0, description: "a positive number" })
type PositiveNumber = number

type Scores = {
  @validate(max(100))
  @jsonSchema({ maximum: 100, description: "capped at 100" })
  score: PositiveNumber
}
```

For the `score` field:
- Validators: `[isPositive, max(100)]` (alias first, then property)
- JSON Schema: `{ minimum: 0, maximum: 100, description: "capped at 100" }` (property's `description` overrides alias's `description`; alias's `minimum` is inherited)

### Validators on Nested and Composed Types

When a validated type is used inside a container (e.g., an array or object), validators recurse into the type structure. For example:

```
@validate(isEmail)
type Email = string

type UserList = {
  emails: Email[]
}

def process(users: UserList!) {
  // isEmail runs on EACH element of the emails array
}
```

When `!` triggers validation on `UserList`, the builder walks the type structure. For each property whose type (or type alias) has `@validate` annotations, it emits validator calls at the appropriate depth. For arrays, this means iterating over elements and running the element type's validators on each one. For nested objects, it means recursing into each property.

The `@jsonSchema` annotations also flow into nested positions. In the example above, if `Email` has `@jsonSchema({ format: "email" })`, the JSON Schema for the `emails` property would be `{ type: "array", items: { type: "string", format: "email" } }`.

#### Unions

For `type Contact = Email | Url`, the Zod schema validates structure first and determines which branch the value matches. Only the validators on the matching branch then run. If the value matched `Email`, `isEmail` runs; if it matched `Url`, `isUrl` runs. If no branch matches at the Zod level, validation fails before any validator is invoked.

#### Nullable / Optional

Nullable and optional types are a special case of unions (with `null` / `undefined`). If the value is `null` or `undefined`, the union resolves to that branch and the validators on the value branch are skipped. This means `@validate(isEmail) type Email = string` used as `Email?` will not run `isEmail` on `undefined`.

#### Recursive Types

Recursive types like `type Tree = { value: number, children: Tree[] }` are walked by following the actual value structure, not the type structure, so they terminate naturally. To guard against pathological input (e.g. an LLM returning a deeply nested structure designed to blow the stack), the generated validator walker enforces a hard recursion depth limit (proposed default: 64). Exceeding the limit produces a `failure("validation recursion depth exceeded")` rather than crashing.

### Duplicate Annotations

Multiple `@validate` annotations on the same target are allowed and their validator lists are concatenated:

```
@validate(isPositive)
@validate(isEven)
type PositiveEvenNumber = number
// equivalent to: @validate(isPositive, isEven)
```

Multiple `@jsonSchema` annotations on the same target are an **error**. Use a single `@jsonSchema` with all properties merged:

```
// ERROR: multiple @jsonSchema on same target
@jsonSchema({ format: "email" })
@jsonSchema({ description: "work email" })
type WorkEmail = string

// CORRECT: single @jsonSchema with all properties
@jsonSchema({ format: "email", description: "work email" })
type WorkEmail = string
```

This avoids ambiguity about merge order and makes the final JSON Schema properties visible in one place.

### Generics

Generics have landed (see [generics-design.md](../plans/2026-05-19-generics-design.md)) since this spec was first drafted. The interaction with annotations is:

- **Annotations on a generic alias apply at every instantiation.** `@validate(nonEmpty) type NonEmptyArray<T> = T[]` runs `nonEmpty` whenever any `NonEmptyArray<Foo>` is validated. The validator does not depend on `T` — it operates on the outer array — so this is straightforward.
- **Element-type annotations still flow through.** Validating `NonEmptyArray<Email>` runs the outer `nonEmpty` validator AND the per-element `isEmail` validator that comes from `Email`. This falls out of the same "walk the resolved type structure" logic used for non-generic containers.
- **Validators cannot reference type parameters.** Since type parameters are types and validators are value-level functions, there is no way to write `@validate(foo<T>)`. Value-level parameterization is the job of the future-work value parameter design (`type NumberInRange(low: number, high: number) = number`).
- **Self-referential generic aliases** (e.g. `type Tree<T> = { value: T, children: Tree<T>[] }`) inherit the recursion-depth guard described under "Recursive Types".
- **Tags never depend on `T`.** Generic type parameters are types, not values, and there is no way to interpolate one into an annotation argument. If a user needs annotations parameterized by a value (e.g. a different `description` per instantiation), that is the job of the future-work value-parameterized aliases.

#### When Propagation Happens

Annotation propagation for generic instantiations happens at **type-check time**, inside `resolveType`. When `NonEmptyArray<Email>` is resolved:

1. `resolveType` looks up the `NonEmptyArray` alias in `ScopedTypeAliases`.
2. It substitutes `T = Email` into the alias body via the existing `substituteTypeParams` walker.
3. It copies the alias's `tags` onto the resolved type node so downstream passes see them attached to the use-site type.
4. The element type `Email` itself carries `@validate(isEmail)` / `@jsonSchema({ ...emailFormat })` from its own alias entry, which is picked up by the same walk when emitting the per-element validator and schema.

Type-check time is the right layer because every other rule in this spec — the alias/property tag merge, the static-`const`-global restriction on `@jsonSchema` arguments, the union/nullable dispatch for validator selection — needs both the resolved structure and the tags visible together. `TypeAliasEntry` (introduced in the generics work) is widened to carry `tags?: Tag[]` so the metadata travels with the alias across module boundaries and re-exports.

## Compiler Implementation

### Tag AST Changes

The current `Tag` type has `arguments: string[]`, which cannot represent object literals or function calls. The `arguments` field changes to accept full `Expression` nodes:

```
type Tag = BaseNode & {
  type: "tag";
  name: string;
  arguments: Expression[];
};
```

This means tag arguments are parsed using the existing expression parser, which already supports object literals (including spread), function calls, identifiers, and string literals.

Additionally:
- The `TypeAlias` type in `lib/types/typeHints.ts` needs a `tags?: Tag[]` field.
- The `ObjectProperty` type in `lib/types/typeHints.ts` needs a `tags?: Tag[]` field (replacing the removed `description?: string` field).

### Tags on Type Properties

Tags inside type bodies require changes to the type parser (`objectTypeParser` in `lib/parsers/parsers.ts`). The parser must:

1. Before parsing each property, check for zero or more `@tag(...)` lines.
2. Accumulate any tags found.
3. Attach them to the next `ObjectProperty` via its new `tags` field.

This mirrors how the preprocessor's `attachTags` handles statement-level tags, but happens within the type expression parser itself, since type bodies are parsed at the type syntax level, not the statement level.

### Tag Attachment for Type Aliases

The `attachTags` function in `lib/preprocessors/typescriptPreprocessor.ts` currently attaches pending tags to `graphNode`, `function`, `assignment`, and `functionCall` nodes. It must be updated to also attach tags to `typeAlias` nodes.

### `@validate` Path

Validators run **outside Zod**, not via `.refine()`. This is because Agency functions compile to async TypeScript functions, and Zod's `.refine()` expects synchronous predicates (async requires `.parseAsync()` which complicates the existing validation path).

Instead, when the builder generates validation code for a type with `!`:

1. The Zod schema is used for structural type validation as it is today (via `safeParse()`).
2. If the type (or its alias) has `@validate` annotations, the builder emits **additional validation calls** after the Zod parse succeeds.
3. Each validator function is called in order with the parsed value. Because validators may transform values (see "Validators may transform values" earlier), the output of each validator is threaded into the next call. If any validator returns a `failure`, the chain short-circuits and the overall validation result is that `failure`.
4. The generated code looks roughly like:

```typescript
const __zodResult = __schema.safeParse(value);
let __validated: Result<T>;
if (__zodResult.success) {
  // Adapt Zod's success shape into Agency's Result shape.
  __validated = agencySuccess(__zodResult.data);
  if (__validated.kind === "success") {
    __validated = await isPositive(__ctx, __validated.value);
  }
  if (__validated.kind === "success") {
    __validated = await isEven(__ctx, __validated.value);
  }
} else {
  __validated = agencyFailure(__zodResult.error.message);
}
```

Notes:
- Two distinct shapes are in play: Zod's `SafeParseReturnType` (`{ success, data | error }`) and Agency's `Result` (the same shape returned by every Agency function). The generated code adapts the first into the second so the post-validation chain operates in `Result` shape uniformly.
- The value threaded between validators is the value most recently produced (i.e. the transform output), not the original Zod-parsed value.
- Validators are awaited because Agency functions compile to async TypeScript functions with the standard `__ctx` runtime context.

This keeps the existing sync Zod path unchanged and adds async validator calls as a post-validation step.

### `@jsonSchema` Path

`@jsonSchema` arguments are **runtime expressions**. The builder emits them as TypeScript code that is evaluated when the Zod schema is constructed (type aliases already compile to `const Foo = z.string()` style statements).

1. The builder sees `@jsonSchema({ format: "email", description: "work email" })` on a type or property.
2. It emits `.meta({ format: "email", description: "work email" })` on the Zod schema string.
3. For expressions involving imported helpers (like `{ ...emailFormat }`), the builder emits the spread expression verbatim — it evaluates at runtime when the module loads.
4. Zod's `toJSONSchema()` copies the `.meta()` properties into the JSON Schema output.

#### `.meta()` Chain Ordering

`.meta()` must be appended in a specific position to avoid being clobbered by subsequent modifiers. The canonical order the builder produces is:

```
z.<baseType>(...)        // z.string(), z.number(), z.object({...}), z.array(...), etc.
  .<typeRefinements>()   // z.string().email(), z.number().int(), etc. — none introduced by this spec
  .nullable()            // if applicable
  .optional()            // if applicable
  .default(...)          // if applicable
  .meta({ ... })         // ALWAYS LAST
```

Any future modifier added to the builder must be inserted **before** `.meta()`, never after. The builder has a single helper (`appendMeta(schemaExpr, metaObj)`) that all schema-construction paths route through, so this invariant is enforced in one place.

#### Type-Checker Restrictions on `@jsonSchema` Arguments

To prevent surprising runtime behavior (mutable globals, side-effecting calls, dependence on values that don't exist at module-load time), the type checker restricts the expressions allowed inside `@jsonSchema(...)`. Each leaf expression must be one of:

- A literal (string, number, boolean, `null`).
- An object literal containing only allowed expressions / spreads.
- An identifier that resolves to a **static `const` global** — i.e. a top-level `const` whose initializer is itself an allowed expression and which is not reassigned. (Module-level imports that are themselves `const`-bound count.)
- A **function call** to a top-level `def` function or an imported function. The arguments must themselves be allowed expressions. Function calls are permitted because some stdlib helpers (e.g. a future `matches(re)` that returns `{ pattern: re }`) are calls, and validator factories like `min(0)` inside `@validate(...)` rely on the same machinery. The type checker forbids the function body from referencing mutable state — this is enforced indirectly by the `static const global` rule above. (If a stricter "must be pure" check turns out to be needed in practice we can tighten this later.)

Note that stdlib `format` helpers like `emailFormat` are plain const-bound objects (`const emailFormat = { format: "email" }`), not function calls, so they fall under the "static `const` global" rule. Using them as `{ ...emailFormat }` is allowed.

Disallowed: member access (`foo.bar`), template strings, array literals, ternaries, binary operators, pipes, anything that reads a `let` binding or a function parameter.

Violations are reported at type-check time with a clear error message pointing at the offending expression.

### Parser Changes

The tag parser needs to be expanded to support:

1. **Object literal arguments**: `@jsonSchema({ format: "email" })` — tags can accept object literals, including spread syntax.
2. **Function call arguments**: `@validate(min(0), max(150))` — tags can accept expressions that are function calls.
3. **General expressions**: tag arguments become full `Expression` nodes, parsed by the existing expression parser.

These parser changes are general-purpose improvements to the tag system that will be useful for future features beyond validation.

#### Backward Compatibility

The current tag parser accepts string literals and bare identifiers, producing `string[]`. After the change, these parse as `Expression` nodes (string literal nodes and variable name nodes respectively). All existing consumers of `Tag.arguments` must be updated to work with `Expression[]` instead of `string[]`. Existing tags like `@goal("Suggest good gifts")` and `@optimize(prompt, temperature)` must continue to parse and behave identically.

#### Restricted Expression Subset

Tag arguments should be restricted to a subset of expressions to avoid nonsensical constructs like `@validate(x > 5 ? foo : bar)`. The allowed forms are:

- String literals: `"text"`
- Number literals: `42`
- Boolean literals: `true`, `false`
- Identifiers: `isEmail`
- Function calls: `min(0)`
- Object literals (including spread): `{ format: "email", ...emailFormat }`

The tag argument parser uses the expression parser but rejects ternaries, binary operators, pipes, and other complex expressions at parse time.

### `.meta()` and `.describe()` Migration

Zod 4's `.meta({ description: "text" })` produces the same `"description"` field in JSON Schema output as `.describe("text")`. This has been verified and is the basis for the `# description` migration.

The existing `.nullable().describe("Default: " + defaultStr)` pattern used for function parameters with default values (in `typescriptBuilder.ts`) is **separate** from this migration. That usage annotates function parameter schemas for tool calling and is not affected by the removal of `# description` on type properties. It can be migrated to `.meta()` in a follow-up if desired.

## Migration

### Removing `# description` Syntax — Fast Follow

The `# description` syntax on type properties will be removed, but **not in this change**. Removing it requires updating every fixture, example, doc, and test file in the repo that uses `#`, which would balloon the diff for this PR and make it hard to review. The annotation infrastructure ships first; the `#` removal is a separate, mechanical fast follow.

In the fast follow:

- Both syntaxes coexist temporarily. `# description` and `@jsonSchema({ description: "..." })` on the same property is an error to avoid ambiguity.
- All in-tree usages are migrated mechanically (a codemod over `lib/`, `stdlib/`, `examples/`, `tests/`, and `docs/`).
- Once the migration is verified by `make` + `pnpm test:run`, the `objectPropertyDescriptionParser` and `objectPropertyWithDescriptionParser` in `lib/parsers/parsers.ts` and the `description` field on `ObjectProperty` in `lib/types/typeHints.ts` are removed, along with the `.describe("...")` codegen path in `typeToZodSchema.ts`.

User-facing migration (after the fast follow lands) is from:

```
type User = {
  email: string # user's work email
}
```

To:

```
type User = {
  @jsonSchema({ description: "user's work email" })
  email: string
}
```

## Design Decisions

### Why not a single annotation for both validation and schema?

Validation (runtime, imperative) and schema hints (declarative, LLM-facing) are fundamentally different concerns. A custom validator function can't be represented in JSON Schema, and a JSON Schema keyword like `format: "date-time"` doesn't correspond to a runtime check. Keeping them separate means each is simple, explicit, and non-magical.

### Why not built-in validator keywords (like `@validate(email)` instead of `@validate(isEmail)`)?

This would create a two-tier system: magic built-in keywords that map to Zod methods, and user functions that map to `.refine()`. Since OpenAI does support some JSON Schema constraint keywords (like `format`, `pattern`, `minimum`) but they're best-effort rather than strictly enforced, the advantage of built-in keywords mapping to Zod methods is minimal. Keeping all validators as regular functions is simpler, more uniform, and more flexible.

### Why not allow annotations on function parameters?

With multiple validators and a description, annotations on function parameters become unreadable:

```
def sendEmail(@validate(isEmail) @jsonSchema({ format: "email", description: "recipient" }) to: string) { ... }
```

Instead, users create a type alias and use it with `!`:

```
@validate(isEmail)
@jsonSchema({ ...emailFormat, description: "recipient" })
type Email = string

def sendEmail(to: Email!) { ... }
```

This encourages reusable, well-named types.

### Why remove `# description` instead of keeping both?

Having two ways to add descriptions (`# text` and `@jsonSchema({ description: "text" })`) creates confusion about which to use and whether they interact. A single mechanism is simpler. The `@jsonSchema` syntax is also more consistent with how all other metadata is specified and more extensible. The removal lands as a fast follow after the annotation infrastructure (see Migration section); during the brief overlap window, mixing both on the same property is an error.

### Why run validators outside Zod instead of using `.refine()`?

Agency functions compile to async TypeScript functions with runtime infrastructure (step counters, interrupt support, etc.). Zod's `.refine()` expects synchronous predicates; using `.refine()` with async functions would require switching the entire validation path to `safeParseAsync()`, which complicates the existing runtime. Running validators as a post-validation step after Zod's structural check keeps both paths clean and means validator failure messages propagate naturally via the `Result` type.

## Future Work: Value-Parameterized Type Aliases

### Motivation

The annotation system encourages creating reusable validated types. The v1 stdlib ships pre-baked aliases for the common no-parameter cases (`Email`, `Url`, `Uuid` — see the "Pre-baked Validated Types" section above).

However, some validated types need **parameters**. A "number in range" type needs to know the range, and shipping a fixed `Age = NumberInRange(0, 150)` is no good for the user who wants `NumberInRange(1, 100)`. With the current design users must repeat the annotations every time:

```
@validate(min(0), max(150))
@jsonSchema({ minimum: 0, maximum: 150 })
type Age = number

@validate(min(1), max(100))
@jsonSchema({ minimum: 1, maximum: 100 })
type Score = number
```

This is verbose and error-prone. Ideally, users could write `NumberInRange(0, 150)` and `NumberInRange(1, 100)`.

### The Problem

Agency's generic type parameters (`<T>`) are types, not values. Writing `type NumberInRange<start, finish> = number` doesn't work because `start` and `finish` are type-level entities that can't be passed to value-level functions like `min(start)`.

This is the fundamental tension between type space and value space. Most languages keep these strictly separated. A few languages have a concept called **dependent types** — types that are parameterized by values. Full dependent types are a complex feature found in academic languages like Idris and Agda. But Agency doesn't need the full generality — just enough to make parameterized validated types work.

### Proposed Solution: Value Parameters with `()`

Type aliases can take **value parameters** using `()`, distinct from type parameters using `<>`:

```
@validate(min(low), max(high))
@jsonSchema({ minimum: low, maximum: high })
type NumberInRange(low: number, high: number) = number
```

Usage looks like a function call on a type:

```
type User = {
  age: NumberInRange(0, 150)
  score: NumberInRange(1, 100)
}
```

The `()` vs `<>` distinction is visually clear: `<>` is for types, `()` is for values. They can be combined:

```
@validate(minItems(n))
@jsonSchema({ minItems: n })
type BoundedList<T>(n: number) = T[]

items: BoundedList<string>(3)
```

### How It Works

When the compiler sees `NumberInRange(0, 150)`:

1. It looks up the `NumberInRange` type alias and finds value parameters `(low: number, high: number)`.
2. It substitutes `low=0, high=150` into the annotations.
3. `@validate(min(low), max(high))` becomes `@validate(min(0), max(150))`.
4. `@jsonSchema({ minimum: low, maximum: high })` becomes `@jsonSchema({ minimum: 0, maximum: 150 })`.
5. The Zod schema and validators are generated with the substituted values.

In the generated TypeScript, each distinct instantiation produces its own Zod schema. `NumberInRange(0, 150)` and `NumberInRange(1, 100)` are different schemas with different `.meta()` properties and different validator calls.

### Standard Library Types

With value parameters, `std::types` (which already exports the no-parameter aliases `Email`, `Url`, `Uuid` shipped in v1) can grow a set of reusable parameterized types:

```
// v1 — ships now in std::types
type Email = string
type Url = string
type Uuid = string

// Future — added once value parameters land
type NumberInRange(low: number, high: number) = number
type StringWithLength(min: number, max: number) = string
type MatchesPattern(pat: string) = string
type BoundedArray<T>(min: number, max: number) = T[]
```

Users can then write concise type definitions:

```
import { Email, NumberInRange, BoundedArray } from "std::types"

type User = {
  email: Email
  age: NumberInRange(0, 150)
  tags: BoundedArray<string>(1, 10)
}
```

### Scope

Value-parameterized type aliases are a follow-up feature. The core annotation infrastructure (`@validate`, `@jsonSchema`, tag parser changes, `# description` removal) ships first. Value parameters build on top of that foundation once it is stable.
