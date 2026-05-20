# Type Validation: `@validate` and `@jsonSchema`

Agency lets you attach two kinds of metadata to a type alias:

- `@validate(fn1, fn2, …)` — register one or more validator functions to run when a value of this type is checked with `!`.
- `@jsonSchema({ … })` — attach JSON Schema metadata that flows into structured-output LLM calls and into the JSON Schema you can extract via `schema(T).toJSONSchema()`.

Both are pure type-level metadata. They don't change the runtime representation of the value (an `Email` is still a `string` from TypeScript's perspective), and they only do work at `!` validation sites — see the [Schemas guide](./schemas.md) for the validation model and what the `!` operator actually does.

## `@validate(...)`

A validator is a function that takes the value and returns a `Result`:

```ts
def isEven(value: number): Result {
  if (value % 2 == 0) {
    return success(value)
  }
  return failure("not even")
}

@validate(isEven)
type Even = number

node main() {
  const x: Even! = 4   // success(4)
  const y: Even! = 3   // failure("not even")
}
```

`@validate` can take multiple validators. They run in order and short-circuit on the first failure:

```ts
@validate(isInt, isPositive)
type Count = number
```

You can also transform the value — whatever the validator returns on success is passed to the next validator and (if all succeed) becomes the final value:

```ts
def trim(value: string): Result {
  return success(value.trim())
}

@validate(trim)
type Tag = string
```

### Plain JavaScript validators

Validators don't have to be Agency `def` functions. Any plain JS function that returns a `Result` works — just import `success` and `failure` from the agency runtime:

```ts
// my-validators.js
import { success, failure } from "agency-lang/runtime";

export function isPalindrome(value) {
  const reversed = value.split("").reverse().join("");
  return value === reversed
    ? success(value)
    : failure("not a palindrome");
}
```

```ts
// my-code.agency
import { isPalindrome } from "./my-validators.js"

@validate(isPalindrome)
type Palindrome = string
```

See [`tests/agency/validation/validatePlainJsFunction.agency`](https://github.com/egonSchiele/agency-lang/blob/main/packages/agency-lang/tests/agency/validation/validatePlainJsFunction.agency) for a complete example.

### Parameterized validators

Some validators need a configuration parameter (a length cap, a regex, a minimum). The standard library models these as plain two-argument functions and asks users to bind the configuration parameter via [partial application](./partial-application.md) before passing them to `@validate(...)`:

```ts
import { min, max, minLength, maxLength, matches } from "std::validators"

@validate(min.partial(n: 0), max.partial(n: 150))
type Age = number

@validate(minLength.partial(n: 3), maxLength.partial(n: 80))
type Username = string

@validate(matches.partial(pattern: "^[A-Z][a-z]+$"))
type Capitalized = string
```

`.partial(...)` returns a new single-argument function with the configuration parameter baked in; the validation chain then calls it with each value to check. Because `min`, `max`, … are ordinary Agency functions, you can also call them directly (`min(0, age)`) anywhere else in your code.

You can write your own parameterized validators the same way: an Agency `def` that takes the configuration parameters first and the value last, then bind the configuration via `.partial(...)`:

```ts
def divisibleBy(n: number, value: number): Result {
  if (value % n == 0) { return success(value) }
  return failure("not divisible by " + n)
}

@validate(divisibleBy.partial(n: 7))
type MultipleOfSeven = number
```

## `@jsonSchema(...)`

`@jsonSchema` attaches JSON Schema metadata to a type. The argument is an object literal whose keys become JSON Schema fields:

```ts
@jsonSchema({ format: "email" })
type Email = string

@jsonSchema({ minimum: 0, maximum: 150 })
type Age = number
```

Common JSON Schema keywords you can use this way (non-exhaustive — see the [JSON Schema validation vocabulary](https://json-schema.org/draft/2020-12/json-schema-validation.html) for the full list):

- Strings: `format`, `pattern`, `minLength`, `maxLength`
- Numbers: `minimum`, `maximum`, `multipleOf`
- Arrays: `minItems`, `maxItems`, `uniqueItems`
- Any: `description`, `default`, `examples`

The metadata flows into two places:

1. **JSON Schema output.** `schema(T).toJSONSchema()` returns the JSON Schema with your metadata merged in, ready to send to any consumer that speaks JSON Schema.
2. **Structured-output LLM calls.** When you use a type as the return shape for an LLM call, the metadata is forwarded to the model as part of the schema, so the model sees your `format: "email"` hint.

### Composing metadata with reusable fragments

For common shapes, define a `static const` object and spread it:

```ts
export static const emailFormat = { format: "email" }
export static const urlFormat = { format: "uri" }

@jsonSchema({ ...emailFormat })
type Email = string

@jsonSchema({ ...emailFormat, description: "work email" })
type WorkEmail = string
```

The standard library ships several of these in [`std::schemas`](../stdlib/schemas.md).

### Restrictions on `@jsonSchema` arguments

`@jsonSchema` arguments must be **statically known** at module-load time. Allowed:

- String / number / boolean / null literals
- Object literals (including `...` spread of allowed values)
- Identifiers that resolve to a top-level `static const` or imported constant
- Calls to top-level `def` functions (where every argument is also allowed)

Not allowed: ternaries, binary operators (other than spread), member access, variables from inside functions, interpolated strings.

This restriction exists so the metadata can be lifted to module-load time and serialized into the JSON Schema. Trying to use `@jsonSchema({ format: someLocalVar })` will fail at codegen time with a clear error.

## How annotations propagate

Tags on a type alias automatically apply wherever the alias is used:

```ts
@validate(isEmail)
@jsonSchema({ format: "email" })
type Email = string

type User = {
  primary: Email      // gets isEmail + format: email
  alternates: Email[] // each item gets isEmail; items.format: email in JSON Schema
}

type LookupResult = Result<Email>   // success branch gets the metadata too
```

The same applies through imports and re-exports — `import { Email } from "std::types"` carries the annotations with it.

### Merging alias-level and use-site annotations

You can add extra metadata at the use site. For `@jsonSchema`, the use-site keys override the alias keys; for `@validate`, both lists run (alias validators first, then use-site):

```ts
@validate(isEmail)
@jsonSchema({ format: "email" })
type Email = string

type User = {
  // `format: "email"` from the alias, plus a per-property description
  @jsonSchema({ description: "primary contact" })
  primary: Email
}
```

Multiple `@jsonSchema(...)` on the same target (alias or property) is an error. Use `...` spread to compose.

`description` is treated specially: if both the alias and the use-site supply a plain-string `description`, the two are concatenated with a newline separator rather than overridden. This lets a reusable alias attach a base description that consumers can extend without losing the original:

```ts
@jsonSchema({ description: "An ISO-8601 timestamp." })
type Timestamp = string

type Event = {
  // Final description: "An ISO-8601 timestamp.\nWhen the event was recorded."
  @jsonSchema({ description: "When the event was recorded." })
  occurredAt: Timestamp
}
```

If either description is not a plain literal (e.g. comes via a variable reference or `...` spread), the merge falls back to last-write-wins because we cannot inspect a non-literal value at type-check time.

### Union types

For a union `Email | Url`, the Zod schema picks the matching branch by structure first; only the validators on the matched branch then run:

```ts
@validate(isEmail)
type Email = string

@validate(isPositive)
type Age = number

type EmailOrAge = Email | Age

const e: EmailOrAge! = "user@example.com"  // matches Email → isEmail runs
const a: EmailOrAge! = 42                  // matches Age → isPositive runs
```

If the value matches no branch at the structural step, validation fails before any validator runs.

### Nullable / optional

Nullable is a union with `null` / `undefined`. If the value is null/undefined, the inner branch's validators are skipped:

```ts
@validate(isEmail)
type Email = string

const e: Email?! = undefined   // success(undefined); isEmail is NOT called
```

## The standard library

Three modules ship with `@validate` / `@jsonSchema` infrastructure:

- [`std::validators`](../stdlib/validators.md) — validator functions (`isEmail`, `isUrl`, `isUuid`, `isInt`, `isPositive`, `isNegative`) and parameterized validators (`min`, `max`, `minLength`, `maxLength`, `matches`) used via `.partial(...)`.
- [`std::schemas`](../stdlib/schemas.md) — reusable JSON Schema fragments (`emailFormat`, `urlFormat`, `uuidFormat`, `dateTimeFormat`, `dateFormat`, `ipv4Format`, `ipv6Format`).
- [`std::types`](../stdlib/types.md) — pre-baked aliases that combine the two: `Email`, `URLString`, `UUIDString`.

```ts
import { Email, URLString } from "std::types"

type Contact = {
  email: Email
  homepage: URLString
}
```

The pre-baked types are named with a `String` suffix where they would otherwise shadow a JavaScript global (`URL`, `UUID`). They are still plain strings at runtime; the suffix is only there to keep the global available in user code.
