---
title: Agency's execution model
description: Explains how every Agency node call gets isolated state when invoked from TypeScript, and how `static` variables let you share expensive one-time initialization across runs.
---

# Agency's execution model

While Agency can be used anywhere, it's written to be especially useful for websites, thanks to its special execution model.

As you just saw, any node defined in Agency can be imported and run as a regular function in TypeScript:

```ts
// note you have to import from the compiled .js file, not the .agency file
import { main } from "./main.js";

async function run() {
  const result = await main("Adit");
  console.log(result);
}

run();
```

This makes it really easy to use your Agency agent from TypeScript code. Every call to an Agency agent gets state isolation. Suppose you define an agent like this.

```ts
const log = []
node main(name:string) {
  const result = llm(`What is a nice greeting for ${name}?`)
  log.push(result)
  return log
}
```

You can see it's got a global variable. Now suppose you have two different calls to this node running concurrently. Are they going to be stomping on each other's state because they're both modifying the global variable?

Nope. Both threads get isolated state, so that global variable is unique to each call.

This makes it much easier to write agents as you don't have to pass every bit of shared state into every single function call. You can just put it in the global state instead.

## Static variables

Global variables are unique to each run. That means that each time you call the main node, you will re-instantiate any global variables. This is great for cheap operations, but what if one of your global variables is a file that you read, maybe one containing a big prompt? Then that file will be re-read for every call to the main node.

If you have an expensive one-time operation like reading a file, you can mark the variable `static`. Static variables are initialized once at module load time, immutable after that, and shared across all runs:

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
- Are **immutable** — you cannot reassign them or modify their contents
- Are **shared across all runs** — every call to the agent sees the same value

If you need mutable state that is shared across runs, implement it in TypeScript and import the functions into your Agency code.

### Cross-module init order

You can read an imported `static const` (or top-level `let` / `const`) from another module's `static const` initializer — the value is guaranteed populated before your initializer evaluates, regardless of which module the entry point lives in:

```ts
// shared.agency
export static const BASE_DIR = "${env("HOME")}/.myapp"
```

```ts
// agent.agency
import { BASE_DIR } from "./shared.agency"

// BASE_DIR is populated before this evaluates — no need to defer the
// read into a `def`.
static const POLICY_PATH = "${BASE_DIR}/policy.json"
```

Each top-level static compiles to a memoized async getter; cross-module reads in initializer expressions become awaited calls to the source module's getter, so dependencies resolve on demand. Function-call-mediated reads work too: if a `def` reads a top-level static or global, the value is guaranteed populated before any `def` is invoked.

If two modules' top-level values depend on each other in a true cycle (`a` depends on `b`, `b` depends on `a`), the runtime detects the cycle the first time it's traversed and throws an `Init cycle on <module>:<var>` error. The JS stack trace's `__init_<var>_compute` frames spell out the dependency chain. To break the cycle, move one of the values into a `def` (which runs after init completes), or restructure so one side stops being a top-level read.

Imperative top-level statements in different modules still run in module-import order. If you need a specific imperative-side-effect ordering, restructure to a `static const` plus a `def` call.
