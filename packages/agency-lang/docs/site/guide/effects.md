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

## References
- [handlers](./handlers)
- [policies](./policies)