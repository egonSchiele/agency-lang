---
name: Global vs Static Variables
description: Per-run isolation of global variables vs static variables that initialize once and persist across runs.
---

# Global vs Static Variables

As you just learned, each run gets its own copy of any global variables. One consequence of that fact is that each run also has to initialize all of its global variables each time. This is okay when initialization is cheap, like for an empty array.

```
const log = []
```

But what about if you're reading a system prompt from a file? Or making a fetch request?

```
const prompt = read("./prompts/system.md") with approve
```

Initializing these every time can get expensive. That's why we have static variables.

## Static variables

If a variable should get initialized exactly once at the start of each agent, and get shared across all the different runs, mark it `static`.

```ts
// initialized once, shared across all runs, immutable
static const prompt = read("prompt.txt")
node main(name: string) {
  const result = llm(`${prompt}. Greet ${name}.`)
  return result
}
```

Static variables:
- Are initialized when when the module loads
- Are **immutable** — you cannot reassign them or modify their contents. The static var is actually **deeply immutable**. For example, if your static variable is an array, you cannot add or remove values from that array.
- Are **shared across all runs** — every call to the agent sees the same value.

There are many types of values that you just want to initialize once, and never modify again: prompts, constants like `PI` or `VERSION`, config settings, etc. `static` variables are perfect for these use cases.

Unlike global variables, static variables *can* be imported from other files, because they don't lead to spaghetti code, as they can't be modified.

## `static` on a bare top-level statement

The `static` prefix also works on a bare top-level statement (a function or method call with no declaration). Use it for once-per-process side effects that don't bind a value:

```ts
static logger.flush()       // runs once, the first time this module is touched
static initTelemetry()      // ditto

node main() {
  // ...
}
```

Plain (unprefixed) top-level calls run on every agent execution, the same way per-run global initializers do. The `static` form runs once per process instead — same Phase A semantics as `static const`, just without binding the result to a name.

`static let` is not supported. Use `static const <name> = ...` for a once-per-process binding, or `static <expr>` for a once-per-process side effect.

## Concurrency

The two variable kinds also differ in how they behave under concurrency:

| | Across runs | Across `parallel` / `fork` / `race` branches |
| --- | --- | --- |
| `global` (`let`/`const`) | isolated | isolated (snapshot at fork time, discarded on join) |
| `static` (`const`) | shared | shared |

So `global` is your "safe everywhere" default — no concurrency reasoning required. `static` is the explicit cross-everything escape hatch when you genuinely want all runs and all branches to see the same value.

If you need *cross-branch but not cross-run* sharing within a single fork, pass `shared: true` to the fork:

```ts
parallel(shared: true) {
  workerA()   // these branches all see the parent run's globals
  workerB()   // and writes accumulate across the branch
}
```

See the [concurrency guide](./concurrency#state-isolation-across-branches) for details.