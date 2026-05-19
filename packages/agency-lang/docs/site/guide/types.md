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

`Record<K, V>` describes an object whose keys all share one type and whose values all share another. Use it when the set of keys isn't fixed up front — typical examples are caches, lookup tables, or "string → enum" maps.

```ts
let votes: Record<string, "approve" | "reject"> = {}
votes["alice"] = "approve"
let v = votes["alice"]   // type: "approve" | "reject"
for (k in votes) {
  print("{k}: {votes[k]}")
}
```

`Record<K, V>` is a built-in generic with two type arguments: the key type and the value type. The key type must be `string`, `number`, a string/number literal, or a union of those.

You can also use a literal-key union for `K` to require a closed set of keys:

```ts
let status: Record<"active" | "inactive", number> = {
  active: 5,
  inactive: 2
}
```

Or pull the union out into a named alias and use it as the key type:

```ts
type Status = "active" | "inactive"

let counts: Record<Status, number> = {
  active: 5,
  inactive: 2
}
```

Open-ended unions like `string | number` are also legal as keys, because each member is a primitive that maps to a property key.

### Variance gotcha

Agency treats `Record<K, V>` as **covariant** in both type parameters. Covariance means narrow values can flow into wider Records — e.g. `Record<string, "approve">` is assignable to `Record<string, string>`. This is the intuitive ergonomic choice, but it's technically unsound for mutable Records:

```ts
let narrow: Record<string, "approve"> = { alice: "approve" }
let wide: Record<string, string> = narrow
wide["bob"] = "anything"        // mutates narrow too — now narrow has a non-"approve" value
```

We accept the unsoundness for ergonomics. If you need strict invariance, keep the wider Record type at the source of the value.

## Generic type aliases

Type aliases can take type parameters:

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

Recursive generic aliases work — the self-reference keeps the same type arguments:

```ts
type Tree<T> = { value: T, children: Tree<T>[] }
```

`Array<T>` and `Schema<T>` are also built-in generics, equivalent to `T[]` and the type of `schema(T)` respectively. They are interchangeable with their shorthand forms.

## Optional properties

Suffix a property's name with `?` to make it optional:

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

When you write an object *literal*, every key in the literal must correspond to its declared type. This helps catch typos like `modle:` instead of `model:`:

```ts
const cfg: Options = { modle: "gpt-4" }  // error: Unknown property 'modle'
```

This check fires only on object literals at the argument site. Assigning the same object to a variable first skips the excess property check, matching the behavior of TypeScript.

```ts
const badCfg = { modle: "gpt-4" }
const cfg: Options = badCfg  // ok — excess property check doesn't apply here
```

## Suppressing typecheck errors

Two directives let you opt out of typechecking:

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