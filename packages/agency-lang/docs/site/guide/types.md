---
name: Types
description: Reference for Agency's TypeScript-like type system — including primitives, unions, arrays, objects, and built-in generics — and how types automatically generate Zod schemas for structured LLM outputs.
---

# Types

Agency's type system is similar to TypeScript's. It includes user-defined generic type aliases and the built-in `Record<K, V>` / `Array<T>` / `Schema<T>` generics, but not all of TypeScript's more advanced features (conditional types, mapped types, etc.).

Agency types are cool because Agency generates Zod Schemas from the types automatically. This means you can use types to specify the structured output format for LLM calls.

```ts
let greet: number = llm("add 4 + 5")
```

This will tell the LLM to respond with a number.

Here are some supported types:

Primitive types:
- `string`
- `number`
- `boolean`
- `null`
- `undefined` (treated as null)
- `regex` (matches a `RegExp` literal — note that LLMs can't return regex values through structured output, so `regex` cannot appear in an `llm()` return type)

Union types. Example:

```ts
let status: "success" | "error" = llm("Respond with either 'success' or 'error'")
```

Array types. Example:

```ts
let items: string[] = llm("List 5 fruits")
```

Object types. Example:

```ts
let user: {name: string, age: number} = llm("Provide a user object with name and age")
```

You can define a new type:

```ts
type User = {
  name: string;
  age: number;
}
```

You can describe a property on an object for the LLM:

```ts
type User = {
  name: string # The name of the user
  age: number # The age of the user
}
```

## Records

Use `Record` types when the set of keys isn't known up front, but you know generally what type all the keys and values need to be. Here is what a record type looks like.

```ts
// all keys are strings, all values are either "approve" or "reject"
let votes: Record<string, "approve" | "reject"> = {}
votes["alice"] = "approve"
```

Note that in agency, because every type needs to be compilable to a schema, the keys can only be numbers, strings, or unions of numbers or strings (or type aliases that are numbers, strings, etc).

Another example:
```ts
type Status = "active" | "inactive"

let counts: Record<Status, number> = {
  active: 5,
  inactive: 2
}
```

Note that if you use a union type for the keys, then all of the keys need to be defined in the object. For the example above, this will cause a type error:

```ts
// missing the 'inactive' key
let counts: Record<Status, number> = {
  active: 5
}
```

## Generics

Types can take type parameters:

```ts
type Container<T> = { value: T }
type Pair<A, B> = { first: A, second: B }

let c: Container<number> = { value: 42 }
let p: Pair<string, number> = { first: "age", second: 30 }
```

A type parameter can have a default. When all parameters have defaults, the alias can be used bare:

```ts
type StringMap<V = any> = Record<string, V>

let untyped: StringMap = {}                       // V defaults to any
let typed:   StringMap<number> = { count: 1 }     // V explicit
```

Default parameters must come **after** all required ones, mirroring TypeScript:

```ts
type Pair<A, B = string> = { first: A, second: B }  // ok
type Pair<A = string, B> = { first: A, second: B }  // error
```

Recursive generic aliases work:

```ts
type Tree<T> = { value: T, children: Tree<T>[] }
```

`Array<T>` and `Schema<T>` are built-in generics.

`Array<T>` is equivalent to `T[]`, and `Schema<T>` is equivalent to the type of `schema(T)`. Schemas come later in the guide, but [click here](/guide/schemas) if you want to learn more.

## Optional properties

Add `?` after a property name to make it optional:

```ts
type Options = {
  model?: string
  temperature?: number
}
```

This is shorthand for `key: T | undefined` — when the property is missing from a value, that's still type-correct. For example:

```ts
def configure(opts: Options): void { ... }
configure({ model: "gpt-4" })  // ok — temperature omitted
configure({})                  // ok — both omitted
```

## Excess properties

When you write an object *literal*, every key in the literal must be in its declared type. This helps catch typos like `modle:` instead of `model:`:

```ts
const cfg: Options = { modle: "gpt-4" }  // error: Unknown property 'modle'
```

This check fires only on object literals at the argument site. Assigning the same object to a variable first skips the excess property check, matching the behavior of TypeScript.

```ts
const badCfg = { modle: "gpt-4" }
const cfg: Options = badCfg  // ok — excess property check doesn't apply here
```

## Suppressing typecheck errors

How to opt out of typechecking:

**`// @tc-nocheck`** — silences every typecheck error in the file. Must appear at the top of the file:

```ts
// @tc-nocheck

// the rest of this file is not typechecked
def foo(x: number) {
  print(x + "oops")
}
```

**`// @tc-ignore`** — silences typecheck errors on the *next* line only. Must be on its own line, Agency does not allow trailing comments.

```ts
def take(x: number): void { print(x) }

node main() {
  // @tc-ignore
  take("not a number")
  take(42)
}
```

## See also

- **[Schemas and validated types](./schemas)** — the `T!` shorthand for `Result<T, string>`, used for validation at runtime.