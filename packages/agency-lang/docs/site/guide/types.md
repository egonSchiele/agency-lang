---
name: Types
description: Reference for Agency's TypeScript-like type system — including primitives, unions, arrays, objects, and built-in generics — and how types automatically generate Zod schemas for structured LLM outputs.
---

# Types

Agency's type system is similar to TypeScript's.

## Primitives

```ts
const name: string = "Alice"
const age: number = 30
const isActive: boolean = true
const nothing: null = null
const simpleRegex: regex = re/\d+/
```

While JavaScript has two keywords that mean "empty", `null` and `undefined`, Agency just has one: `null`.

## Arrays and objects

```ts
const names: string[] = ["Alice", "Bob", "Charlie"]

type Person = {
  name: string
  age: number
}

const person: Person = { name: "Alice", age: 30 }
```

## Union types

```ts
const status: "success" | "error" = "error"
```

## Type aliases

```ts
type User = {
  name: string;
  age: number;
}
```

## Optional properties

Add `?` after a property name to make it optional:

```ts
type Options = {
  // required
  model: string

  // optional
  temperature?: number
}
```

## Records

```ts
// all keys are strings, all values are either "approve" or "reject"
const votes: Record<string, "approve" | "reject"> = {}
votes["alice"] = "approve"
```

The keys can only be numbers, strings, or unions of numbers or strings. This is because in Agency, every type needs to be compilable to a schema. More on this later.

Another example:
```ts
type Status = "active" | "inactive"

let counts: Record<Status, number> = {
  active: 5,
  inactive: 2
}
```

If you use a union type for the keys, all of the keys need to be defined. For example, this will cause a type error:

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

const c: Container<number> = { value: 42 }
const p: Pair<string, number> = { first: "age", second: 30 }
```

Recursive generic aliases work:

```ts
type Tree<T> = { value: T, children: Tree<T>[] }
```

### Default type parameters

A type parameter can have a default. When all parameters have defaults, the alias can be used bare:

```ts
type StringMap<V = any> = Record<string, V>

// V defaults to `any`
const untyped: StringMap = {}

// V is explicitly set to `number`
const typed: StringMap<number> = { count: 1 }
```

Default parameters must come **after** all required ones, mirroring TypeScript:

```ts
// ok
type Pair<A, B = string> = { first: A, second: B }

// error
type Pair<A = string, B> = { first: A, second: B }
```

### Built-in generics

- `Record<K, V>` (see above)
- `Array<T>` (same as `T[]`)
- `Schema<T>` (equivalent to the type of `schema(T)`)
- `Result<S, E>` (used for error handling, see [the `Result` type](/guide/error-handling))

Schemas come later in the guide, but [click here](/guide/schemas) if you want to learn more.

## Suppressing typecheck errors

**`// @tc-nocheck`** — Put it at the top of a file. Silences every typecheck error in the file.

```ts
// @tc-nocheck

// the rest of this file is not typechecked
def foo(x: number) {
  print(x + "oops")
}
```

**`// @tc-ignore`** — Silences typecheck errors on the *next* line only. Must be on its own line.

```ts
def double(x: number) {
  return x * 2
}

node main() {
  // @tc-ignore
  double("not a number")
}
```

## Excess property checks

When you write an object *literal*, every key in the literal must be in its declared type. This helps catch typos like `modle:` instead of `model:`:

```ts
const cfg: Options = { modle: "gpt-4" }  // error: Unknown property 'modle'
```

## Utility types

Agency ships five built-in utility types modeled on TypeScript, adapted to
Agency optionality (optional means `| null`; there is no `undefined`):

| Type | What it does |
|---|---|
| `Partial<T>` | Every property becomes nullable: `p: V` → `p: V \| null` |
| `Required<T>` | The inverse: strips `null` from every property |
| `Pick<T, K>` | Keeps only the listed keys: `Pick<User, "name" \| "email">` |
| `Omit<T, K>` | Removes the listed keys |
| `NonNullable<T>` | Strips `null` from a single type: `NonNullable<string \| null>` is `string` |

```ts
type User = {
  name: string,
  age?: number,
}

def updateUser(id: string, changes: Partial<User>): string {
  // changes.name is string | null — guard before use:
  if (changes.name != null) {
    return changes.name  // narrowed to string here
  }
  return "no name change"
}
```

## Recursive types

Type aliases can reference themselves, each other, or aliases declared
later in the file:

```ts
type Tree = {
  value: number,
  children: Tree[],
}
```

`schema(Tree)` validates nested payloads at every level, and `@validate`
annotations on nested fields fire at every depth through the `!`
validated-assignment form.

One provider limitation: recursive types work as LLM structured-output
contracts (`const t: Tree = llm(...)`) on OpenAI and Gemini, but
Anthropic's structured-output API rejects self-referencing schemas. On
Anthropic, ask for a string and parse it yourself with
`schema(Tree).parseJSON(...)` — parsing and validation are unaffected.

## References

- [Schemas](/guide/schemas)
- [Type validation](/guide/type-validation)