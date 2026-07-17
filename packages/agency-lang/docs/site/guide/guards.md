---
name: Guards
description: Documents the `guard` function for capping the cost and/or compute time of a block of work, returning a `Result` that lets you handle budget overruns.
---

# Guards

Guards let you limit the **cost** and/or **compute time** of a block of work.

```ts
node main() {
  const result = guard(cost: $0.2) {
    const category = llm("classify this email: I love you")
    const reply = llm("draft a reply")
    return category
  }

  match(result) {
    success(value) => print("Category: ${value}")
    failure(error) => printJSON(error)
  }
}
```

Things to note:
- You don't have access to all the variables inside the guard, only to the return value.
- `result` is a `Result` type. On success, it has the return value. On failure, it has this data:

```ts
// "guardFailure" = cost, "timeoutFailure" = time.
// Every field is always present; the ones that don't apply are null.
type GuardFailureData = {
  type: "guardFailure" | "timeoutFailure"
  label: string | null
  maxCost: number | null
  actualCost: number | null
  maxTime: number | null
  actualTime: number | null
}
```

`guard` takes one or both of:

- `cost:` — a `number` of dollars, eg `$2.0`.
- `time:` — a `number` of milliseconds (or use the [unit literals](/guide/basic-syntax.html#unit-literals): `30s`, `5m`, `100ms`, `1h`).

You can also name a guard with `label:`. The label shows up on the failure (`error.label`) and in error messages, so code with several guards can tell which one fired:

```ts
const result = guard(label: "research", cost: $0.50) {
  return research(topic)
}
if (isFailure(result)) {
  print("Guard '" + result.error.label + "' tripped")
}
```

The cost check fires before every LLM call, so a run that is over budget never sends another request.

The time check fires at step boundaries. When the timer expires, it cancels any in-flight HTTP requests or LLM calls.

Cost guards and time guards also apply to subprocesses created using `std::agency.run`.

## When a guard trips

When a guard trips, it raises a `std::guard` interrupt. There you can choose to approve or reject the interrupt.

- If you approve, you need to give the guard more budget, so the code keeps running.
- If you reject, then the guard will return a [partial result](/guide/partial-results) if you have one saved, or it will return a failure.

### The interrupt payload

| Field | Meaning |
|---|---|
| `dimension` | `"cost"` or `"time"` — which budget tripped |
| `limit` | the tripped dimension's current limit (dollars or milliseconds) |
| `spent` | what the work has used so far, in the same unit |
| `label` | the guard's `label:`, or null |
| `maxCost` | the guard's `cost:` limit, or null |
| `maxTime` | the guard's `time:` limit, or null |
| `draftValue` | a preview of the innermost [saved draft](/guide/partial-results), or null |

### Approving the interrupt

If you approve the interrupt, you need to specify how much more budget you're giving the guard.

```ts
handle {
  // spend 50 cents researching a topic
  const result = guard(label: "research", cost: $0.50) {
    return research(topic)
  }
  return result
} with (i) {
  if (i.effect == "std::guard") {
    if (i.data.spent < 2.0) {
      // Give it another 50 cents
      return approve({ maxCost: 0.50 })
    }
    return reject()
  }
  return pass()
}
```

Things to note:

- You can give additional budget for one or more dimensions. If you leave out a dimension, it will keep going with whatever budget it has left.
- If several handlers approve, their grants merge additively.

### Disarm

To stop metering a dimension, you can disarm it explicitly:

```ts
approve({ disarm: ["cost"] })
```

Now the guard will never trip on that dimension again.

### Sending feedback with the grant

An approval can carry a message for the model:

```ts
return approve({ maxCost: 0.50, message: "You are over budget because you keep re-reading files. Summarize what you have and finish." })
```

The message will land in the conversation as a user message. Of course, if the code never makes another `llm()` call, the agent will never see the message.

- If several handlers approve with a message, their messages are concatenated into one, inner handler first.
- If the same handler approves multiple times before the next request, only the last message is kept.

### Partial results
If a guard trips and you don't give it more budget, it will throw away all the work done so far and return a failure. You can instead have it return a partial result. See the [partial results](/guide/partial-results) section for more information.

## What `approve` does, by situation

What "continue" means is situation dependent, depending on what code was running when the guard tripped.

- **Between steps** (a loop, plain code): the work continues in place.
- **Inside a tool call**: the tool finishes on resume and its result reaches the model normally.
- **Mid LLM request**: the trip already cancelled the request. After approval the request is sent again from the same conversation state.

## Trips in forks

You can set a guard around a `fork`, and then all branches share the same budget:

```ts
guard(cost: $5.0) {
  fork(jobs) as job {
    return processOneJob(job)
  }
}
```

Or you can give each branch its own budget:

```ts
fork(jobs) as job {
  guard(cost: $0.50) {
    return processOneJob(job)
  }
}
```

If the fork budget trips, all branches pause till you respond. If a branch budget trips, only that branch pauses, the others keep going.

For forks, the time budget is wall-clock time. i.e. if you set a 5 minute guard around a fork, and each branch takes 4 minutes each, that is still fine because they are running in parallel.

## Widening parents' budgets

Suppose you have nested guards:

```ts
guard(cost: $5.0, label: "outer") {
  guard(cost: $0.50, label: "inner") {
    return processOneJob(job)
  }
}
```

If you give the inner guard more budget, it does not give the outer guard more budget. The outer guard is still limited to $5.0, and if it trips, it will raise its own interrupt.

## Root budgets

You can also set a hard limit when you run an Agency agent on the command line:

```bash
agency run my-agent.agency --max-cost 10.0 --max-time 30s
```

These limits are hard limits, you cannot give them more budget. Note that the time *has* to be specified in unit literals.

## When the clock ticks for timeouts
- regular code execution = yes.
- `sleep` = yes.
- interrupts = no.
- waiting for user input through `input` = no (waiting on a human is free).

When the time guard fires, any in-flight HTTP and LLM requests are cancelled and an abort signal is sent to other code as well.

## Aborting TypeScript code

When an abort is fired, TypeScript code does not stop automatically. You need to thread in the abort signal.

```ts
import { getRuntimeContext } from "agency-lang/runtime"

export async function fetchAll(urls: string[]): Promise<string[]> {
  const { ctx, stack } = getRuntimeContext()
  const signal = ctx.getAbortSignal(stack)
  // Hand it to anything AbortSignal-aware:
  return Promise.all(urls.map((u) => fetch(u, { signal })))
}
```

See the [TypeScript helpers](/guide/ts-helpers) section for more info.

For a compute loop with no natural `AbortSignal` sink, you can poll `signal.aborted`:

```ts
for (const item of items) {
  if (signal.aborted) throw new Error("guard tripped")
  heavyWork(item)
}
```

`ctx.getAbortSignal(stack)` folds together every cancellation source — the time-guard timer, a lost `race`, and top-level `cancel()` / Esc. Two things to know:

- **Cost guards do not fire this signal.** They enforce at LLM-call boundaries, not via an abort controller.