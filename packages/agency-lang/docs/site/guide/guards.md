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
- `time:` — a `number` of milliseconds (or use the unit literals: `30s`, `5m`, `100ms`, `1h`).

You can also name a guard with `label:`. The label comes back on the failure (`error.label`) and in error messages, so code with several guards can tell which one fired:

```ts
const result = guard(label: "research", cost: $0.50) as {
  return research(topic)
}
if (isFailure(result)) {
  print("Guard '" + result.error.label + "' tripped")
}
```

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

When the time guard fires, any in-flight HTTP requests are cancelled and an abort signal is sent to other code as well.

## Partial results with saveDraft

A tripped guard normally throws the block's work away. `saveDraft` lets you keep a best-so-far value instead. Call it as your result improves; if the guard trips, the guard returns the last saved draft as a **success** instead of a failure.

```ts
node main() {
  const result = guard(time: 5m) as {
    let report = ""
    for (topic in topics) {
      report = report + research(topic)
      saveDraft(report)
    }
    return report
  }
  // Finished in time: the full report.
  // Tripped: the report so far.
  print(result.value)
}
```

`saveDraft` is always available — no import needed.

Things to note:

- The last saved value wins. Save early, save often.
- The draft must match the type your function or block returns. The type checker enforces this, the same way it checks your `return` statements.
- Each function keeps its own draft. If a function you *call* saved a draft but your code did not, your level returns nothing — a draft only crosses a call boundary when you return the callee's result directly (`return verify()`), because then its value *is* your value. This keeps every salvaged value correctly typed for the guard that receives it.
- Drafts survive interrupts. If your block pauses for user input and trips after resuming, the draft saved before the pause still counts.
- With no enclosing guard, `saveDraft` is a harmless no-op. At module top level it is a compile error — there is nothing a draft could ever be returned from.
- A plain thrown error never returns a draft. Drafts are for budget trips, where the work so far is still trustworthy; unexpected failures stay failures.

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
