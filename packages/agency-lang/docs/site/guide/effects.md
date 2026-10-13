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

## What an effect needs from the host

An effect declaration can also say what the machine running the program must be able to do for the effect's function to work. That is the `@capabilities` tag:

```
@capabilities(fileRead)
effect std::read {
  dir: string,
  filename: string
}
```

The names come from a fixed list of seven: `fileRead`, `fileWrite`, `network`, `subprocess`, `env`, `terminal`, and `llm`. Each one is a part of the host, the layer between a program and the platform it runs on, and a platform may lack some of them. A browser, for example, has no files to read, so it has no `fileRead`. An effect that needs two things names both, `@capabilities(fileRead, subprocess)`; an effect that needs nothing writes `@capabilities` with no names; and an effect with no tag at all needs nothing, which is right for an effect you declare and raise in your own code. Every effect in the standard library carries the tag.

The tag does two things:

- **Compiling for a platform.** `agency compile --platform browser app.agency` (or `"platform": "browser"` in `agency.json`) fails if any node or exported function can raise an effect that needs a capability the browser lacks, and tells you how the node gets there:

  ```
  error AG3029: Node 'main' raises 'std::read', which needs the fileRead capability. The browser platform does not have it.
    main calls loadNotes (notes.agency:12)
    loadNotes calls read from std::index (notes.agency:4), which raises std::read
  ```

  Importing a module that only works on Node, such as `std::ui`, is an error too. The default platform is `node`, which has every capability, so nothing changes until you ask for another.

- **Refusing before anyone is asked.** When a program runs on a host that lacks a capability, a raise of an effect that needs it is rejected on the spot, before any handler runs and before a person is asked to approve it. The function sees the same failure a rejected interrupt gives, with a message like `std::read needs the fileRead capability, which the browser host does not have.`

Capabilities add to handlers and policies and replace neither:

| | Effects, policies, handlers | Capabilities |
| --- | --- | --- |
| Question | May this action happen? | Can this host do it at all? |
| Detail | This file, this command | Seven names |
| Who answers | A handler, a policy, or a person | Nobody. It is fixed when the host is built. |
| Can the program approve it | Yes, with `with approve` | No |

A file read wrapped in `with approve` is still refused on a browser, because approving it would not make the browser able to read the file.

## References
- [handlers](./handlers)
- [policies](./policies)