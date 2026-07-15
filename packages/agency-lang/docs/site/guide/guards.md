---
name: Guards
description: Documents the `guard` function for capping the cost and/or compute time of a block of work, returning a `Result` that lets you handle budget overruns.
---

# Guards

Guards let you limit the **cost** and/or **compute time** of a block of work.

```ts
import { guard } from "std::thread"

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
// "guardFailure" = cost, "timeoutFailure" = time
type GuardFailureData = {
  type: "guardFailure" | "timeoutFailure"
  maxCost?: number
  actualCost?: number
  maxTime?: number
  actualTime?: number
}
```

`guard` takes one or both of:

- `cost:` — a `number` of dollars, eg `$2.0`.
- `time:` — a `number` of milliseconds (or use the unit literals: `30s`, `5m`, `100ms`, `1h`).

These use [unit literals](/guide/basic-syntax.html#unit-literals).

The cost check fires before and after every LLM call.

 The time check fires at the next runner step boundary after the timer expires.

Cost guards and time guards also apply to subprocesses created using `std::agency.run`.

## Timeout

```ts
const result = guard(time: 30s) as {
  return planAndExecute()
}
if (isFailure(result)) {
  // result.error.type === "timeoutFailure"
  print("Took too long: " + result.error.actualTime + "ms (limit " + result.error.maxTime + ")")
}
```

When the clock ticks:
- regular code execution = yes.
- interrupts = no.
- waiting for user input through `input` = no (waiting on a human is free).
- `sleep` = yes.

One current limitation: the `input` exemption applies to time guards on the
same execution branch. If `input()` runs inside a `fork` or `race` branch,
an *outer* time guard's clock keeps running during the wait, because fork
branches do not yet carry their own copy of the parent's timer. Per-branch
time budgets (the next change in this series) remove this limitation.

When the time guard fires, any in-flight HTTP requests are cancelled and an abort signal is sent to other code as well.

## Nested guards

Guards are scoped — an inner trip does **not** trip an outer guard:

```ts
const outer = guard(cost: $10.0) as {
  const inner = guard(cost: $0.001) as {
    return llm("expensive job")
  }
  if (isFailure(inner)) {
    print("inner blew its $0.001 budget; outer still has plenty")
  }
  return "carry on"
}
```

They work with `fork` and other [concurrency primitives](/guide/concurrency) too:


```ts
// shared across every branch below
guard(cost: $5.0) as {
  fork(jobs) as job {
    // per-branch sub-budget, isolated
    guard(cost: $0.50) as {
      return processOneJob(job)
    }
  }
}
```

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

For a compute loop with no natural `AbortSignal` sink, poll `signal.aborted`:

```ts
for (const item of items) {
  if (signal.aborted) throw new Error("guard tripped")
  heavyWork(item)
}
```

`ctx.getAbortSignal(stack)` folds together every cancellation source — the time-guard timer, a lost `race`, and top-level `cancel()` / Esc. Two things to know:

- **Cost guards do not fire this signal.** They enforce at LLM-call boundaries, not via an abort controller.

See [TypeScript helpers](/guide/ts-helpers#respecting-cancellation-the-abort-signal) for more on the `agency-lang/runtime` helpers.
