---
name: Debugging
description: A walkthrough of Agency's interactive terminal debugger — stepping forward, rewinding through checkpoints, overriding variables, and inspecting panels.
---

# Debugging

Agency has a built-in interactive debugger that runs right in your terminal. What makes it unusual is that it doesn't just step *forward* — because Agency checkpoints execution as it goes, you can also step *backward*, rewinding to any earlier point in the run.

## Getting started

Put this in a file called `test.agency`:

```ts
node main() {
  const name = "world"
  const greeting = llm("Say hello to ${name}!")
  print(greeting)
}
```

Then launch the debugger:

```bash
agency debug test.agency
```

By default it runs the `main` node — pass `--node <name>` to debug a different one.

## Stepping and rewinding

Once you're in, here are the moves you'll reach for most:

- **Step forward** — press `s` or the down arrow.
- **Continue** — press `c` or space to run until the next `debugger` statement (or the end).
- **Step backward** — press the up arrow to rewind one step, or press `r` to pull up a list of checkpoints, scroll with up/down, and jump to the line you want.

Rewinding works over a rolling window of recent checkpoints (30 by default). If you need to reach further back, bump it up with `--rewind-size <n>` — at the cost of a little more memory.

## Overriding variables

You can rewrite a variable's value mid-run and watch how execution changes. Type:

```
:set name=newValue
```

The next time you step (`s`), the statement runs with the overridden value. Handy for exploring "what if this had been different?" without editing and recompiling your code.

## Moving around the panels

The debugger shows several panels at once (source, variables, threads, and more):

- **Cycle panels** — `tab` and `shift+tab`.
- **Scroll a focused panel** — up/down arrows.
- **Zoom** — press `z` to blow the focused panel up to full screen (press again to restore).
- **Switch threads** — in the threads panel, press `[` or `]` to move between threads.

## Debugging without running live

You don't always have to execute the program from scratch. The debugger can also load state you captured earlier:

- `--trace <file>` — open and inspect an existing `.trace` file instead of running live.
- `--checkpoint <file>` — start from a saved checkpoint.
- `--dist-dir <dir>` — import pre-compiled JS from a build directory instead of recompiling on the fly.

For the full list of options, see the [debug CLI reference](/cli/debug).
