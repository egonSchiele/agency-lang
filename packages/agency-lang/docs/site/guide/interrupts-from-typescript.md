---
name: Interrupts from TypeScript
description: How to run an Agency node from TypeScript, receive the interrupts it raises, and respond to them to resume execution — the building block for approval flows and human-in-the-loop apps.
---

# Responding to Interrupts from TypeScript

When you run an Agency node [from TypeScript](/guide/ts-interop), it might hit an [interrupt](/guide/interrupts). Inside Agency, you'd handle interrupts with a `handle` block. From the TypeScript side, here's what happens:
1. The node instead **returns the pending interrupts to you**
2. You respond to the interrupts
3. You resume the run, passing your responses.

## The shape of a result

A compiled node returns a result object with a `data` field. Normally `data` is the node's return value, but if the run paused, `data` is an array of interrupts instead. You can use `hasInterrupts()` to see if the `data` contains interrupts:

```ts
import { main, hasInterrupts } from "./agent.js";

const result = await main("deploy the app");

if (hasInterrupts(result.data)) {
  // Paused: result.data is an array of interrupts to respond to.
} else {
  // Finished: result.data is the node's return value.
}
```

## What's in an interrupt

Each interrupt in the array describes what the node is waiting on:

- **`message`** — What you can show to the user.
- **`effect`** — The interrupt's [effect](/guide/effects).
- **`data`** — the effect's [payload](/guide/effects#payload-types).
- **`interruptId`** — a unique id

[All interrupts have the first three values](/guide/effects). The fourth one is so Agency can match your responses back to the right interrupt when you resume the run.

## Responding

You'll always get an array of interrupts, even if there's just one interrupt. Create one response per interrupt, in the same order as the array, using `approve()` and `reject()`, then call `respondToInterrupts()`:

```ts
import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";

const result = await main("deploy the app");

if (hasInterrupts(result.data)) {
  const responses = result.data.map((intr) => {
    console.log(intr.message); // "Approve deploy?"
    return approve();          // decide per interrupt
  });

  const resumed = await respondToInterrupts(result.data, responses);
  console.log(resumed.data);
}
```

Notice that you need to pass `result.data` to `respondToInterrupts()`. This is what lets Agency resume execution from the right place. See [checkpointing](/guide/checkpointing) and [interrupts part 2](/guide/interrupts-part-2) for more info.

## Looping until it finishes

`respondToInterrupts()` returns another result with a `data` field, just like `main()` did. Again, `data` could be the final value, or it could be another array of interrupts. You should call your `respondToInterrupts()` in a loop until `data` no longer has interrupts:

```ts
import { main, hasInterrupts, approve, respondToInterrupts } from "./agent.js";

let result = await main("deploy the app");

while (hasInterrupts(result.data)) {
  const responses = result.data.map((intr) => approve());
  result = await respondToInterrupts(result.data, responses);
}

console.log(result.data); // the final return value
```

## Approving and rejecting

- `approve()` - approve
- `reject()` - reject
- `approve(value)` - approve with a value
- `reject(reason)` - reject with a reason
