---
name: Effects
description: Explains how to use effects in interrupts, allowing handlers to respond differently based on the effect.
---

# Effects

Suppose you have the following code and you want to *approve reads* and *reject writes*. How would you do it?

```ts
handle {
  readFile("myfile.txt")
  writeFile("myfile.txt", "Hello, world!")
} with (data) {
  // How do you approve reads and reject writes?
}
```

Each interrupt has an *effect*. You can think of the effect as the name for the interrupt. You can use the effect to decide what to do.

```ts
handle {
  readFile("myfile.txt")
  writeFile("myfile.txt", "Hello, world!")
} with (data) {
  if (data.effect == "std::read") {
    return approve()
  } else if (data.effect == "std::write") {
    return reject()
  }
}
```

Or more idiomatically, you can use a `match` statement:

```ts
handle {
  readFile("myfile.txt")
  writeFile("myfile.txt", "Hello, world!")
} with (data) {
  return match (data.effect) {
    "std::read" => approve()
    "std::write" => reject()
  }
}
```

The stdlib docs tell you the effects a function raises ([example](/stdlib/#read)).

## How to set the effect

All interrupts contain three fields:
- message
- data
- effect.

Message and data are the first and second parameters to the `interrupt()` function:

```ts
raise interrupt("Are you sure you want to write to this file?", { filename: filename })
```

This will have `effect = "unknown"`. You can set the effect by using the structured interrupt format:

```ts
raise foo::write(
  "Are you sure you want to write to this file?",
  { filename: filename }
)
```

- `interrupt` = generic interrupt with effect = "unknown"
- `foo::write` = interrupt with effect = "foo::write"

## Payload types

You can also define the type for the `data` parameter for an effect. This is called the *payload type*, and you use `effect` to define it.

```
effect std::read {
  dir: string,
  filename: string
}
```

This does two things:
- It enforces that any place that raises a `std::read` effect *must* specify a directory and filename.
- Gives you better typing for the `data` object in the handler function (including auto-completion if you're using the Agency plugin!)

The payload type just defines the fields you *must* have... you can have other fields as well. For example, there are two different functions in the agency standard library that  defined a `std::read` interrupt:
- The read function
- The [typecheckFile](/stdlib/agency) function from `std::agency`.

Both interrupt payloads have `dir` and `filename`, but the `read` function's payload additionally contains `offset` and `limit` as well.

You don't export or interrupt effect types – just import a function from that file and the effect will get imported automatically.

## References
- [handlers](./handlers)
- [policies](./policies)