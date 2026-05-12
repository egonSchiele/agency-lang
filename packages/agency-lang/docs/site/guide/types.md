# Types

Agency's type system is similar to TypeScript's, without all the advanced features like generics.

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
- `object` (equivalent to `Record<string, any>`)
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