---
title: Schema parameter injection
description: Explains how the compiler auto-synthesizes a `schema(T)` argument for functions that take a `Schema<...>` parameter, the mechanism behind structured-output calls like `llm()`.
---

# Schema parameter injection

Agency lets you write functions that take a `Schema<...>` parameter and then automatically passes a Zod schema in for that argument, generated from the call's expected type. This is the mechanism that makes calls like

```agency
const numbers: number[] = llm("Return the first 5 Fibonacci numbers")
```

work without the caller having to write `schema(number[])` themselves.

You will probably not need this feature day-to-day — it's mostly useful when you're writing a structured-output wrapper of your own (a custom `llm`-style function, a typed JSON parser, etc.). When you do need it, here's how it works.

## The rule

When the compiler sees a call to a function that has a `Schema<...>` parameter, and:

1. The caller did not supply a value for that parameter, and
2. The call appears in a position where the compiler knows the expected type,

then the compiler synthesizes a `schema(T)` expression — where `T` is the expected type — and inserts it as the missing argument.

The two positions that count as "the compiler knows the expected type" are:

- **The right-hand side of a typed `const` or `let` declaration.**
  ```agency
  const xs: number[] = parseValue("[1,2,3]")
  // → parseValue("[1,2,3]", s: schema(number[]))
  ```
- **A `return` statement inside a function with a declared return type.**
  ```agency
  def wrapper(): number[] {
    return parseValue("[1,2,3]")
    // → return parseValue("[1,2,3]", s: schema(number[]))
  }
  ```

If neither position applies — for example, a bare expression statement like `parseValue("[1,2,3]")` with no assignment and no `return` — no injection happens. The function receives `undefined` for the schema parameter, which will usually fail at runtime when the body tries to use it. The compiler does not currently produce a special error for this case; the assumption is that anyone defining a Schema-using function knows what the parameter is for.

## Defining a Schema-using function

```agency
def parseValue(input: string, s: Schema<any>): any {
  return s.parseJSON(input)
}
```

A few constraints worth knowing:

- **At most one `Schema<...>` parameter per function.** The injection mechanism only has one expected-type slot to draw from, so a function with two Schema parameters has no sensible meaning. Declaring two will produce a compile-time error.
- **Schema parameters are optional from the type checker's point of view.** Even if you don't write `= <default>`, the type checker will not flag a call that omits the schema argument — the injection pass is expected to fill it in. (If neither injection nor a default supplies a value, the runtime sees `undefined`.)
- **The return type of the function is independent of the LHS type.** A Schema-using function commonly returns `any` so that any LHS annotation is accepted. If your function returns something more specific (e.g. `Result<any, any>`), the LHS annotation still must be assignable from that return type.

## Overriding the injection

Pass the schema explicitly — by position or by name — to suppress injection:

```agency
// Positional
const x = parseValue("[1,2,3]", schema(any))

// Named
const x = parseValue("[1,2,3]", s: schema(string))
```

## Defaults

A Schema parameter can have a default value:

```agency
def parseString(input: string, s: Schema<any> = schema(string)): any {
  return s.parseJSON(input)
}
```

The precedence at the call site is:

1. **Explicit argument wins** — if the caller passes the schema, it's used.
2. **LHS hint wins over the default** — if the caller omits the schema and an LHS / return-position hint is available, the hint is injected.
3. **Default wins** — if there's no explicit argument and no hint, the default runs at function entry.

## Interaction with `!` validation

`const x: number[]! = parseValue("[1,2,3]")` is fine. The injected schema is built from `number[]`; the `!` triggers a separate runtime validation pass at the assignment site, also built from `number[]`. The two schemas agree, so validation passes whenever the value matches the schema.

## Known limitations

These are intentional v1 limitations and may be relaxed in future versions:

- **No argument-position injection.** Only LHS annotations and enclosing return types drive injection. A call like `foo(parseValue("hi"))` will not pick up a hint from `foo`'s parameter type.
- **No injection through partial application.** `parseValue.partial(input: "fixed")` followed by `const x: number[] = partial()` does not inject. Pass the schema at the `partial(...)` call instead.
- **No injection through pipe chains.** `"[1,2,3]" |> parseValue` does not inject. Write the assignment directly when you want injection.
- **No injection through type aliases that name `Schema<T>`.** A parameter declared as `s: MySchemaAlias` (where `MySchemaAlias = Schema<any>`) is not currently recognized as a Schema parameter. Declare it with the `Schema<...>` form directly.

## When NOT to use this

Most Agency code should not declare `Schema<...>` parameters at all. The feature exists for a small population of structured-output wrappers — primarily `llm()` and similar — and is documented here mostly so you know what's happening when you read those functions' source.
