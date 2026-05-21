# Type Validation

Agency allows users to add an arbitrary validation logic on types. Remember that with [schemas](/guide/schemas), you could validate a type with the bang operator: `Person!`. You can also write custom validation that runs for any type. This validation also gets triggered when you validate using the bang operator.

## `@validate`

Simple example:

```ts
type Person = {
  name: string;

  @validate(isPositive)
  age: number;
}
```

The isPositive function then returns a success or failure.

```ts
def isPositive(value: number): Result<number> {
  if (value > 0) {
    return success(value);
  }
  return failure("expected ${value} to be > 0")
}
```

If successful, the function returns `success` with the value. You can also send a new value to modify the value. So for example, instead of having isPositive fail, we could just have it clamp the value to be above zero.

```ts
def isPositive(value: number): Result<number> {
  if (value > 0) {
    return success(value);
  }
  // always succeeds, modifies value
  return success(1);
}
```

In our example, we set the validator right on the key in the `Person` type. We could also create a new type instead.

```ts
@validate(isPositive)
type Age = number;

type Person = {
  name: string;
  age: Age;
}
```

This is nice because it lets you create a type that has the validation built in that you can now use everywhere. This becomes especially useful combined with the jsonSchema tag. Let's look at that next.

## `@jsonSchema`
Types are also used as JSON schemas to specify a structured output format to an LLM. When adding validation to a type, you may additionally want to tell the LLM about it. For example, if you've just added validation saying that age must be positive, you might want to give the LLM a hint that the number should be greater than zero. You can do this using the jsonSchema tag:

```ts
@validate(isPositive)
@jsonSchema({ minimum: 1 })
type Age = number;
```

`jsonSchema` takes an object, and all of the fields here are simply passed as additional fields to the [JSON schema object that is constructed](https://json-schema.org/understanding-json-schema/reference/object).

Obviously, to do this correctly, you'll need to know the correct fields to pass to the JSON schema. I have some references at the end of this writeup for this.

If you're not sure what JSON schema field to use, you can always just put some information in the description field:

```ts
@validate(isPositive)
@jsonSchema({ description: "should be > 0" })
type Age = number;
```

Used together, these two tags let you create new types that have custom validation and also have the right JSON schema hints. The agency standard library already comes with some of these types built in.

### Sidebar: Inspecting the JSON schema
If you're not sure what the result in JSON schema is going to look like, you can always print it out in Agency:

```ts
const personSchema = schema(Person)
print(personSchema.zodSchema.toJSONSchema())
```

## Multiple validators and schemas

You can set multiple validators, and they will all run in order. If you transform the value, the transformed value will get handed to the next validator:

```ts
@validate(isPositive, isAdult)
type AdultAge = number;
```

If any of the validators fails, the chain stops and returns a failure.

You can also stack `@validate` tags:

```ts
@validate(isPositive)
@validate(isAdult)
type AdultAge = number;
```

The same behavior also works for the `jsonSchema` tag, but obviously, while you can have multiple validators, in the end, you're only going to produce a single JSON schema tag. So if you specify multiple objects, later objects may override the keys in earlier objects:

```ts
@jsonSchema({ foo: 1, minimum: 1 })
@jsonSchema({ bar: 1, minimum: 18 })
type Age = number; // schema includes { foo: 1, bar: 1, minimum: 18 }
```

The one exception to this is the `description` field. Descriptions all get concatenated together, separated by new lines. This lets you create reusable types, and set a description in the description field, and know that that description will get passed down.

## Container types, recursive types
Here is an array of ages.

```ts
type Ages = Age[]
```

The validator will run once for every element in the array. You could also add a second validator that runs for the entire array.

```ts
@validate(nonEmpty)
type Ages = Age[]
```

Similar situation for objects:

```ts
@validate(noNullFields)
type Person = {
  name: string;
  age: Age;
}
```

Similar situations were for recursive types, although currently we hard code the recursion depth to prevent infinite recursion during validation.

## JS Validators

You don't need to write your validation function in agency. You can write it in TypeScript if you want.

```ts
import { success, failure } from "agency-lang/runtime";

export function isPalindrome(value) {
  const reversed = value.split("").reverse().join("");
  return value === reversed
    ? success(value)
    : failure("not a palindrome");
}
```


## Value-Parameterized Aliases

When you find yourself repeating the same `@validate(...)` / `@jsonSchema(...)`
shape with just one or two numbers (or strings) changing, you can lift those
numbers out as **value parameters** on the alias itself:

```ts
import { min, max } from "std::validators"

@validate(min.partial(n: low), max.partial(n: high))
@jsonSchema({ minimum: low, maximum: high })
type NumberInRange(low: number, high: number) = number
```

At every use site you supply concrete arguments and the alias's tags are
substituted at compile time as if you had written them out by hand:

```ts
type User = {
  age: NumberInRange(0, 150)
  score: NumberInRange(1, 100)
}
```

The `age` property gets `@validate(min.partial(n: 0), max.partial(n: 150))`
plus `@jsonSchema({ minimum: 0, maximum: 150 })`; the `score` property gets
the equivalent with `1` / `100`. The two instantiations are nominally
distinct but are mutually assignment-compatible (both bottom out at
`number`); validation runs only at `!` sites.

### Syntax

- **Value parameters use `(...)`**, distinct from type parameters'
  `<...>`. Value params must come *after* type params:

  ```ts
  type BoundedList<T>(n: number) = T[]
  // use site
  const xs: BoundedList<string>(3) = ["a", "b", "c"]
  ```
- Defaults are allowed and follow the same restriction set:

  ```ts
  type Age(low: number = 0) = number
  const x: Age()! = 5   // uses default 0
  ```

### What can appear as a use-site argument

Arguments are evaluated at compile time, not at runtime — they have to be
*statically known*. The underlying rule: an argument is allowed only if
its value can be folded to a TypeScript literal during compilation.

**Allowed:**

- String / number / boolean / `null` literals
- Multi-line `"""..."""` strings
- Unit literals: time (`30s`, `2h`), cost (`$5`), size (`100KB`).
  These canonicalise to a plain number (ms / dollars / bytes) and the
  canonical value is what gets substituted
- Regex literals (`re/pattern/flags`); useful when forwarding to a
  custom validator declared with `(pat: regex)`
- Identifiers that resolve to a top-level `static const` (including
  const-bound imports)
- Other value-param identifiers in scope (so a wrapper alias can forward
  its own value params)
- Object literals and array literals built from any of the above
  (with `...` spread)

**Not allowed:**

- bare function calls (`Age(getDefault())`)
- ternaries, binary operators, pipes
- member access (`Age(config.min)`)
- identifiers that resolve to a `let` binding, function parameter, or
  local declaration

::: warning String interpolation is restricted to value-parameter identifiers
Agency string literals normally support interpolation everywhere — `"hello ${name}"` is a real expression that combines the literal text with whatever `name` evaluates to at runtime. Inside `@validate(...)`, `@jsonSchema(...)`, value-param defaults, and use-site value-args, the only `${...}` form that is accepted is **a bare identifier that names a value parameter of the enclosing alias**:

```ts
// ✅ `${divisor}` references a value parameter — substituted at compile time
@jsonSchema({ description: "Must be divisible by ${divisor}" })
type DivisibleBy(divisor: number) = number

// At use sites, `divisor` is folded into the description:
//   schema(DivisibleBy(3)).toJSONSchema().description  // "Must be divisible by 3"
//   schema(DivisibleBy(7)).toJSONSchema().description  // "Must be divisible by 7"

// ❌ Arbitrary expressions are still rejected (no ternaries, no calls, no member access)
@jsonSchema({ pattern: "^${PREFIX}[0-9]+${foo()}$" })
type UserId = string

// ❌ Top-level static const references in `${...}` are also rejected:
// tag-arg strings are emitted into node-body schema chains where
// module-level Agency consts are not bound to JS identifiers.
static const PREFIX = "user-"
@jsonSchema({ pattern: "^${PREFIX}[0-9]+$" })  // ❌ not supported today
type UserId = string
```

If you need to embed a static const, compose the literal yourself and pass the const in as the whole argument (which *is* statically known):

```ts
static const PATTERN = "^user-[0-9]+-foo$"  // hand-written literal

@jsonSchema({ pattern: PATTERN })  // ✅ static const reference (no interpolation)
type UserId = string
```
:::

### Bare function calls in tag arguments

The same restriction applies inside `@validate(...)` and `@jsonSchema(...)`
arguments themselves:

```ts
// ❌ Rejected — bare function call in a tag argument
@validate(min(0))
type Age = number

// ✅ Use a partial-application chain instead
@validate(min.partial(n: 0))
type Age = number
```

The partial-application (PFA) form is what makes value-parameter
substitution well-defined: a value-param identifier (`low`) can flow into
the named-argument slot of a method call, which we can manipulate as an
expression tree at compile time.

### Arithmetic erases bounds

Value-parameterized aliases attach validators and JSON schema constraints
to a specific *type name*, not to the underlying `number`/`string` value
itself. As a result, arithmetic and other expressions return the plain
unwrapped type — the bounds do not propagate through operators:

```agency
@validate(min.partial(n: low), max.partial(n: high))
type NumberInRange(low: number, high: number) = number

const a: NumberInRange(0, 10)! = 7
const sum = a.value + 5   // sum is a plain `number`, NOT NumberInRange(0, 10)
```

If you want to re-validate the result of an arithmetic expression,
annotate it again with a value-parameterized alias and use the bang:

```agency
const checked: NumberInRange(0, 100)! = a.value + 5
```

### Pre-baked stdlib types

`std::types` already exports the most common parameterized shapes:

- `NumberInRange(low, high)`
- `StringWithLength(min, max)`
- `MatchesPattern(pat)`
- `BoundedArray<T>(min, max)`

See the [`std::types` reference](../stdlib/types.md) for the full list.

## References
- [minimum](https://json-schema.org/draft/2020-12/draft-bhutton-json-schema-validation-00#rfc.section.6.2.4)
- [JSON Schema object](https://json-schema.org/understanding-json-schema/reference/object)
- [OpenAI docs](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas)