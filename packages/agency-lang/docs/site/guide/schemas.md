---
name: Schemas
description: Shows how Agency converts types into runtime Zod schemas via the `schema()` function and the bang (`!`) shorthand for validating values and function parameters.
---

# Schemas

Have you ever wished you could create Zod Schemas from your TypeScript types, or use your TypeScript types to parse and validate data at runtime? You can do this in Agency!

## `schema()` function
You can get the schema from a type using the `schema` function, and use it to validate an object:

```ts
type Person = {
  name: string;
  age: number;
}
const personSchema = schema(Person)

// validated will be a Result type
const validated = personSchema.parse(someObject)
```

If you have a string containing JSON data, use `parseJSON`.

```ts
const validated = personSchema.parseJSON(someJSONString)
```

## The bang(!) syntax

Agency also has a shorthand for validation: the bang syntax. Here’s what it looks like.

```ts
const foo: Person! = someObject
```

Now, `foo` will be a `Result` type. If the validation fails, it will be a `failure`, otherwise it will be a `success`.

You can use this with llm calls too:

```ts
const result: Person! = await llm("Describe a person.")
```

Remember to unwrap the `Result` type to get the value out of it.

You can also use the bang shorthand syntax to validate parameters passed into functions:

```ts
function greet(name: string!, age: number!) {
  // ...
}
```

If any of these parameters fails to validate, the function returns immediately with a `failure`.

You can use the bang syntax to validate the return value from a function as well.

```ts
function getPerson(): Person! {
  // ...
}
```

If the value fails to validate, the function will return a `failure`. 

## Schemas and Result Types

When you use schema validation with `Result` types, there are some nuances to be aware of:

1. `failure`s are never validated. For instance, suppose you have validation on the parameters of a function. If you pass in a `failure`, Agency won't validate it. Similarly, if a function returns a `failure`, Agency doesn't validate that `failure`.
2. We never rewrap a `Result` type. This only applies to successes, because as I said, Agency doesn't even try to validate a `failure`. But we don't double-wrap `success`es. If a function returns a `success` but fails validation, we will return a `failure`. If a function returns a `success` and passes validation, we don't wrap it in another `success`. We simply propagate the existing `success` value.

## Validating Result types

You can also add validation for the Result type itself. 

```ts
const foo: Result! = someObject
```

This will validate that `foo` is a `Result` type, which could be either `success` or `failure`.

Here's another example:

```ts
const foo: Result<Person>! = someObject
```

This will validate that `foo` is a `Result` type, and if it's a `success`, it will validate that the wrapped value is a `Person`.

With `Result` types, you can also define types for both the `success` and `failure`. However, `failures` aren't touched, so what happens if you try to validate it?

```ts
const foo: Result<Person, Error>! = someObject
```

Agency still only validates if `foo` is a `success`. If it's a `failure`, we do not validate that the `failure` has the given type. This is because if we did, and the validation failed, we would have to replace this `failure` with a new `failure`, and then we would lose the original `failure` information.