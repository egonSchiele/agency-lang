---
name: Value-Parameterized Types
description: Describes how to use value-parameterized type aliases in Agency, allowing for compile-time substitution of values in type annotations and validation.
---

*This section builds on the [type validation](/guide/type-validation) section. You should also know how [PFAs](/guide/partial-application) work.*

# Value-Parameterized Types

In the last section we saw `Age`, which was a type with custom validation that was designed for reuse.

```ts
@validate(isPositive)
type Age = number;

type Person = {
  name: string;
  age: Age;
}
```

`Age` could not be < 0. Suppose you wanted to write a more reusable type called `GreaterThan` so you could write this:

```ts
type Person = {
  name: string;
  age: GreaterThan(0);
}
```

You can do that using value parameterized types.

## Defining a value-parameterized type

```ts
def greaterThan(minValue: number, value: number): Result<number> {
  if (value > minValue) {
    return success(value);
  }
  return failure("expected ${value} to be > ${minValue}");
}

@validate(greaterThan.partial(minValue: minValue))
type GreaterThan(minValue: number) = number
```

## Using a value-parameterized type

```ts
type User = {
  name: string;
  age: GreaterThan(0)
}
```

## Value-parameterized types vs generic types

Both kinds of types take arguments.

- Generic types take *types* as arguments.
- Value-parameterized types take *values* as arguments.

Both are used at different times.

- Generic types are used for type checking at *compile time*.
- Value-parameterized types are used for validation at *runtime*.

(Generic types are also used for validation + schema generation at runtime, but we're talking about custom validation here.)

Generic type example:

```ts
type Container<T> = {
  value: T
}
const c: Container<string> = { value: "hello" }
```

Value-parameterized type example:

```ts
def strLength(min: number, max: number, value: string): Result<string> {
  if (value.length >= min && value.length <= max) {
    return success(value);
  }
  return failure("expected ${value} to have length between ${min} and ${max}");
}

@validate(strLength.partial(min: min, max: max))
type StringOfLength(min: number, max: number) = string
const s: StringOfLength(3, 5) = "hello"
```

Both together:

```ts
def arrayLength(length: number, value: any[]): Result<any[]> {
  if (value.length === length) {
    return success(value);
  }
  return failure("expected ${value} to have length ${length}");
}

@validate(arrayLength.partial(length: length))
type ArrayWithLength<T>(length: number) = T[]
const arr: ArrayWithLength<string>(3) = ["a", "b", "c"]
```

Note that the value parameters are just used for validation, and validation doesn't run unless you use the `schema` function or the bang (`!`) syntax.

### Syntax

- Value parameters use `(...)`, type parameters use `<...>`. Value params must come *after* type params:

  ```ts
  type BoundedList<T>(n: number) = T[]
  const xs: BoundedList<string>(3) = ["a", "b", "c"]
  ```

- Defaults are allowed:

  ```ts
  type Age(low: number = 0) = number
  const x: Age()! = 5   // uses default 0
  ```

### What you can use as a value parameter

Arguments are evaluated at compile time, so they have to be *statically known*.

Allowed:

- String / number / boolean / `null` literals
- Multi-line `"""..."""` strings
- Unit literals: time (`30s`, `2h`), cost (`$5`), size (`100KB`).
- Regex literals (`re/pattern/flags`); useful when forwarding to a
  custom validator declared with `(pat: regex)`
- `static const` variable (see [global vs static variables](/guide/global-vs-static))
- Object literals and array literals built from any of the above

**Not allowed:**

- bare function calls (`Age(getDefault())`) – though if you assign the value of the function call to a static const, you can use that const as a value parameter
- ternaries, binary operators, pipes
- member access (`Age(config.min)`)

::: warning String interpolation is restricted to value-parameter identifiers
Inside `@validate(...)` and `@jsonSchema(...)` only value parameters can be referenced in `${...}` string interpolation:

```ts
// Ok
@jsonSchema({ description: "Must be divisible by ${divisor}" })
type DivisibleBy(divisor: number) = number

// Error
static const DIVISOR = 5
@jsonSchema({ description: "Must be divisible by ${DIVISOR}" })
type DivisibleBy() = number
```

You could work around this by passing in a static const as the entire argument:

```ts
static const description = "Must be divisible by 5"

@jsonSchema({ description: description })
type DivisibleBy() = number
```
:::

## Value-parameterized types can get erased

```ts

const a: GreaterThan(0)! = 5
const sum = a.value - 6 // sum is a number, not a GreaterThan(0)
```

You would need to annotate `sum` again if you wanted to keep the validation:

```ts
const sum: GreaterThan(0)! = a.value - 6
```

## References
- [`std::validation`](/stdlib/validation)