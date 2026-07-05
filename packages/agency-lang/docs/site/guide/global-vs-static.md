---
name: Global vs Static Variables
description: Per-run isolation of global variables vs static variables that initialize once and persist across runs.
---

# Global vs Static Variables

As you just learned, each run gets its own copy of any global variables. This also means that *each global variable is reinitialized for every run*. This is okay when initialization is cheap, like for an empty array.

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
static const prompt = read("prompt.txt") with approve
```

Static variables:
- Are initialized when when the module loads
- Are **immutable** — you cannot reassign them or modify their contents. The static var is actually **deeply immutable**. For example, if your static variable is an array, you cannot add or remove values from that array.
- Are **shared across all runs** — every call to the agent sees the same value.
- Are always `const`, never `let`.

## Exporting variables

You cannot export a global variable. This is because global variables can lead to spaghetti code. If you want to access your global variables in other files, you can export functions that get and set those variables.

You *can* export static variables.

## Global statements

Statements in the global scope also get run once per run (same as global variables):

```ts
// runs every time the agent is called
initTelemetry()
```

If you only want the statement to run once when the agent starts, mark it as `static`.

## `static` on statements

The `static` prefix also works on a bare top-level statement. Use it for function calls that should run once per process, rather than once per run:

```ts
// runs once, the first time this module is touched
static logger.flush()
static initTelemetry()

node main() {
  // ...
}
```

## Comparison table

If you want variables that are shared across all runs but mutable, put them in TypeScript code.

| Var type | Isolation | Mutability |
| --- | --- | --- |
| `global` | **isolated state** | can be mutable |
| `static` | shared state | **immutable** |
| TS code | shared state | can be mutable |

