---
name: Interrupts from TypeScript
description: How to run an Agency node from TypeScript, receive the interrupts it raises, and respond to them to resume execution — the building block for approval flows and human-in-the-loop apps.
---

# Responding to Interrupts from TypeScript

When you run an Agency node [from TypeScript](/guide/ts-interop), it might hit an [interrupt](/guide/interrupts) — a point where it pauses to ask for approval or input before doing something like writing a file or calling a tool. Inside Agency you'd catch these with a `handle` block. From the TypeScript side, the node instead **returns the pending interrupts to you**: your code decides how to respond, then resumes the run. This is the building block for approval flows, human-in-the-loop UIs, and API endpoints that pause for confirmation.

## The shape of a result

A compiled node returns a result object with a `data` field. Normally `data` is the node's return value — but if the run paused, `data` is an array of interrupts instead. The exported `hasInterrupts()` helper tells the two apart:

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

- **`message`** — the human-readable prompt, e.g. `"Approve deploy?"`.
- **`effect`** — which effect raised it, e.g. `"std::write"`.
- **`data`** — the effect's payload (whatever the interrupt carried).
- **`interruptId`** — a unique id for this specific interrupt.

You'll typically show `message` to a user (or apply a policy) to decide your response.

## Responding

Build one response per interrupt, **in the same order** as the array, using the exported `approve()` and `reject()` helpers. Then hand the interrupts and your responses to `respondToInterrupts()`:

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

`respondToInterrupts()` returns another result with a `data` field — just like `main()` did.

## Looping until it finishes

A node can pause more than once: resuming it may surface a fresh batch of interrupts. So the robust pattern is a loop that keeps responding until `data` is no longer interrupts:

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

The helpers mirror what happens inside a `handle` block:

- **`approve()`** — let the action proceed; the paused function or node keeps executing normally.
- **`reject()`** — deny it; that function or node halts and returns a failure.

Both accept an optional value:

- **`approve(value)`** supplies a value back to the paused call. For example, if the interrupt was a `write`, you can approve with a different filename.
- **`reject(reason)`** rejects with a specific message instead of the generic "interrupt rejected" error. If the interrupt came from an LLM tool call, that message is sent back to the model explaining why the call was refused.

```ts
const responses = result.data.map((intr) => {
  if (intr.message.includes("delete")) {
    return reject("Deletion is not allowed from this endpoint.");
  }
  return approve();
});
```

That's the whole loop: run the node, inspect `data`, respond to each interrupt, and resume until you get a real value back.
