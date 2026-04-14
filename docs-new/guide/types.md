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



*Note that the agency typechecker is still a work in progress.*