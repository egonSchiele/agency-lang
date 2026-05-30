---
title: TypeScript interoperability
description: Covers two-way interop between Agency and TypeScript — importing TS functions and modules into Agency code, and importing compiled Agency nodes into TypeScript, along with the limitations of each direction.
---

# TypeScript interoperability

## Using TypeScript code in Agency

Because Agency simply compiles to TypeScript code, interoperability is really easy: just import stuff from TypeScript and use it. You can import any function from a TypeScript file and use it, and most library imports will work as well.

`greet.js`:

```js
export function greet(name) {
  return `Hello, ${name}!`;
}
```

`main.agency`:

```ts
import { greet } from "./greet.js";

node main() {
  const name = input("What is your name? ")
  const greeting = greet(name)
  print(greeting)
}
```

As you can see, the import syntax is just the typical syntax for importing ESM modules.

Most interoperability works from TypeScript to Agency. However, some features do not work.

1. Agency doesn't support lambdas or first-class functions right now.
2. Builtins like `array.map` and `array.forEach` don't work, for two reasons: Agency doesn't support lambdas or first-class functions, and because Agency's interrupt feature, which allows you to pause at any step of execution, can't work with these built-in JavaScript functions, as they don't know anything about Agency or its execution model. Agency provides its own higher-order constructs for map, filter, etc., that you can use.
3. Classes. While you can import and use plain ol' objects just fine, you can't use instances, and you can't instantiate a new instance of a class (eg `new Set`). This is because serializability is a core feature of Agency, and if you have an instance, it's not clear how it would get serialized and then deserialized. Agency also does not have support for classes right now either, but this may get added in the future.
4. on that note, anything else that can't be serialized. For example if you import a plain old JavaScript object and some of its values are functions, there's no way for Agency to serialize and deserialize that.

## Using Agency code in TypeScript/JavaScript

Every node that you define in Agency can be imported and run as a function from TypeScript:

```ts
node main(name:string) {
  const result = llm(`What is a nice greeting for ${name}?`)
  return result
}
```

```ts
// note you have to import from the compiled .js file, not the .agency file
import { main } from "./main.js";

async function run() {
  const result = await main("Adit");
  console.log(result);
}

run();
```

Other things like functions can't be imported and run, because Agency functions have a lot of extra functionality to make things like interrupts work.

## Writing TS helpers that participate in the run

TypeScript helpers called from Agency code can do more than return plain values: they can read the active runtime context, push thread messages, install interrupt handlers, take checkpoints, issue LLM calls, and wrap their bodies in resumable scopes. The full surface is exposed through one namespace:

```ts
import { agency } from "agency-lang/runtime";

export function summarize(text: string): Promise<string> {
  return agency.llm("Summarize in one sentence: " + text);
}
```

Every method on `agency.*` reads its dependencies from an AsyncLocalStorage frame the runtime installs around each step. When you call a TS helper from Agency code, the frame is already in place — your helper sees the same context the surrounding Agency function saw. (Most methods throw with a clear error if called outside an Agency frame; the `*Maybe` variants return `undefined` instead.)

Common patterns:

```ts
// Read context
const cost = agency.ctx().stateStack.localCost;
const apiKey = agency.global<string>("API_KEY", "config");

// Push thread messages
agency.thread.system("You are a careful editor.");
agency.thread.user("Please proofread the following.");

// Install a scoped handler
await agency.withHandler(
  (intr) => intr.kind === "std::read" ? approve("auto-y") : undefined,
  () => doWork(),
);

// Take a checkpoint
const cpId = await agency.checkpoint();

// Issue an LLM call with structured output
const { name, age } = await agency.llm("Extract", { schema: PersonSchema });
```

### Resumability boundary

```diagram
╭──────────────╮   call    ╭───────────────────╮   call   ╭──────────────╮
│  Agent run   │──────────▶│  Agency function  │─────────▶│  TS helper   │
│   (Node)     │           │     body          │          │              │
╰──────────────╯           ╰───────────────────╯          ╰──────────────╯
                            resumable                      NOT automatically
                            automatically                  resumable

                                                          ╭──────────────────────╮
                            wrap with                     │ withResumableScope   │
                            ─────────────────────────────▶│ inside the helper to │
                                                          │  get resumability    │
                                                          ╰──────────────────────╯
```

Agency function bodies are resumable automatically: an interrupt in the middle of one re-enters at the same statement on resume. A plain TS helper called from Agency code is **not** resumable — on resume after an interrupt, the entire helper re-runs from the top. To get per-step resumability inside a TS helper, wrap the body in `agency.withResumableScope`:

```ts
return agency.withResumableScope({ name: "processOrder" }, async (s) => {
  const order     = await s.step(() => loadOrder(orderId));
  const validated = await s.step(() => validate(order));
  const stored    = await s.step(() => persist(validated));
  return stored;
});
```

Each `s.step(...)` is journaled against a serialized frame; on resume completed steps are skipped, the in-flight step re-runs from scratch. **Read the [determinism contract](/appendix/ts-helpers#determinism-contract) before using this** — step bodies must be pure, and step ordering must be stable across resumes.

For the full reference of every `agency.*` method, the `LlmOpts` shape, the `ResumableScope` API, testing patterns, and anti-patterns, see [TypeScript helpers — the `agency.*` namespace](/appendix/ts-helpers).

## Cancelling an in-progress agent

When you run an Agency agent from TypeScript, you can cancel it mid-execution. This tears down any in-flight LLM requests and throws an `AgencyCancelledError`. Here's how to abort an agent run.

The `onAgentStart` callback receives a `cancel` function you can call at any time:

```ts
import { main } from "./main.js";

let cancelAgent: (reason?: string) => void;

const result = await main({
  callbacks: {
    onAgentStart: ({ cancel }) => {
      cancelAgent = cancel;
    },
  },
});

// later, from a button handler, timeout, etc:
cancelAgent("user clicked stop");
```


### What happens when you cancel

When `cancel()` is called

1. Any in-flight LLM request is aborted immediately.
2. Any remaining tool calls in the current round are skipped.
3. Any remaining interrupt handlers are skipped.
4. An `AgencyCancelledError` is thrown, which propagates up to the caller.

Cancellation is permanent for that execution. Once cancelled, no further LLM calls can be made on that particular agent run. However, you can start a new agent run. You can read more about Agency's [execution model](/guide/execution-model).

To catch the abort in TypeScript, you can catch `AgencyCancelledError` (exported from `agency-lang/runtime`) or use the `isAbortError` helper:

```ts
import { AgencyCancelledError, isAbortError } from "agency-lang/runtime";

try {
  await main();
} catch (error) {
  if (isAbortError(error)) {
    // handle cancellation
  }
}
```

Now let's talk about Agency's execution model.