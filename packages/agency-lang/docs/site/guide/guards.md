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
- Running out of budget does not fail the block right away. The guard first asks whether the work should get more budget — see [When a guard trips](#when-a-guard-trips). The failure arm runs when that question is answered no.
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
const result = guard(label: "research", cost: $0.50) {
  return research(topic)
}
if (isFailure(result)) {
  print("Guard '" + result.error.label + "' tripped")
}
```

These use [unit literals](/guide/basic-syntax.html#unit-literals).

The cost check fires before every LLM call, so a run that is over budget never sends another request.

The time check fires at step boundaries, even inside a tight loop that never awaits. When the timer expires it also cancels any in-flight HTTP request.

Cost guards and time guards also apply to subprocesses created using `std::agency.run`.

## When a guard trips

A trip does not immediately fail the block. It pauses the work and raises an [interrupt](/guide/handlers) with effect `std::guard`, asking: this work ran out of budget — should it get more?

- If the answer is **approve**, the budget grows and the work continues where it paused.
- If the answer is **reject**, the guard stops the block and returns a failure. This is the failure shown above, and `saveDraft` / `finalize` salvage still applies.
- If nothing in your program answers, the question goes to the user, like any other unhandled interrupt. On the CLI that means a prompt, or whatever `--policy` / `--approve` / `--reject` say. In a subprocess it forwards to the parent.

This means a bare `guard(...)` with no handler no longer fails silently. If you want the old behavior — trip means fail, never ask — reject the question yourself:

```ts
node main() {
  handle {
    const result = guard(cost: $0.20) {
      return summarize(inbox)
    }
    return result
  } with (i) {
    return match(i.effect) {
      "std::guard" => reject()
      _ => pass()
    }
  }
}
```

Or run with `agency run --reject std::guard`.

### Handling trips in code

A handler sees the trip like any interrupt. `i.effect` is `"std::guard"`, and `i.data` describes the trip:

| Field | Meaning |
|---|---|
| `dimension` | `"cost"` or `"time"` — which budget tripped |
| `limit` | the tripped dimension's current limit (dollars or milliseconds) |
| `spent` | what the work has used so far, in the same unit |
| `label` | the guard's `label:`, or null |
| `maxCost`, `maxTime` | the guard's per-dimension limits, null for a dimension it does not meter |
| `draftValue` | a preview of the innermost saved draft, or null |

`approve` takes a payload naming what to grant. Grants are **additive**: each value is extra budget on top of the current limit, not a new total.

```ts
handle {
  const result = guard(label: "research", cost: $0.50, time: 2m) {
    return research(topic)
  }
  return result
} with (i) {
  if (i.effect == "std::guard") {
    if (i.data.spent < 2.0) {
      // Half a dollar more, and another minute.
      return approve({ maxCost: 0.50, maxTime: 60000 })
    }
    return reject()
  }
  return pass()
}
```

Things to note:

- Name one dimension or both. A dimension you leave out keeps metering with whatever allowance it has left.
- An approval must actually help. If the tripped dimension is still over its limit after your grant, that is a runtime error — the guard would just trip again immediately.
- To stop metering a dimension instead of extending it, disarm it explicitly: `approve({ disarm: ["cost"] })`.
- A negative grant clamps to zero, with a warning. Use `disarm` when you mean "stop metering"; a computed grant that goes negative must not silently remove a budget.
- `pass()` means "not my question": the rest of the handler chain, and finally the user, decide. Use it for effects your handler does not recognize.
- If several handlers approve, their grants merge additively.

### Sending feedback with the grant

An approval can carry a message for the model:

```ts
return approve({ maxCost: 0.50, message: "You are over budget because you keep re-reading files. Summarize what you have and finish." })
```

The message lands in the conversation as a user message, right before the work's next model request. If the trip happened outside an LLM call — say, mid-loop — the message waits and arrives with the next `llm()` call. This is what makes guards a review point, not just a meter: the handler grants more budget *and* steers how it gets spent.

Two details:

- Messages combine instead of piling up. Several handlers approving one trip join their messages into one, inner handler first. And everything delivered at the same point — say, two nested guards both approved before one request — arrives as a single user message, newline-joined in ask order. Providers that require strict user/assistant alternation never see a run of user messages.
- In thread dumps and statelog, injected feedback wears the label `guard:<label>` (the guard's `label:`, or its dimension when unlabeled), so you can tell reviewer feedback from real user messages. A combined message lists each contributing guard. The model just sees a user message.

Deliberation is free. While your handler decides, the tripped guard's clock is paused, and your handler's own `llm()` calls are not billed to the guard it is judging. The handler's work is metered by the guards that enclosed its **registration site** — so register the handler *outside* the guard. A handler registered inside the guarded block is part of the metered work and never sees that guard's trips.

### What approve does, by situation

Where the trip caught the work decides what "continue" means. All of it is automatic:

- **Between steps** (a loop, plain code): the work continues in place.
- **Inside a tool call**: the tool finishes on resume and its result reaches the model normally.
- **Mid LLM request**: the trip already cancelled the request, and the cancelled generation is gone. After approval the request is sent again from the same conversation state, and the retry is billed like any request.

### Trips in forks

Budgets and forks compose:

- A cost budget shared by several branches asks **once**. While one branch's question is open, sibling branches that hit the same limit wait for the answer instead of asking again.
- A granted time budget follows the work through the join. If a branch trips, gets five more minutes, and finishes, those five minutes widen the parent's budget too — the parent does not trip just because its branch was legitimately granted more time.
- Grants never cross budgets. Approving an inner guard's trip does not widen an outer guard; if the extra work pushes the outer guard over its own limit, it trips separately, with its own label.

### Root budgets

The operator's `--max-cost` and `--max-time` limits never ask. They are the ceiling: a root budget trip stops the run, and no handler can approve past it.

## Timeout

```ts
const result = guard(time: 30s) {
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

A rejected trip normally throws the block's work away. `saveDraft` lets you keep a best-so-far value instead. Call it as your result improves; if the guard trips and the trip is rejected, the guard returns the last saved draft as a **success** instead of a failure.

```ts
node main() {
  const result = guard(time: 5m) {
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

### Computing the partial with finalize

Sometimes the best partial result is not a value you saved along the way, but something you compute from what you have at the moment the guard trips. A `finalize` block does that: it runs only if the scope is stopped, sees the scope's variables, and its `return` becomes the salvaged value.

```ts
def research(topic: string): string {
  const outline = draftOutline(topic)
  const full = expand(outline)     // guard trips in here
  return full

  finalize {
    if (outline != null) {
      return "OUTLINE ONLY: " + outline
    }
    return "nothing yet"
  }
}
```

If `expand` was stopped mid-way, its own partial (whatever it saved or finalized) lands in `full`, and your finalize can use it.

Things to note:

- A finalize never runs on success, and never for a plain thrown error. It runs when the scope is aborted, but only a guard trip salvages its value; an abort for any other reason (like losing a `race`) discards it.
- Inside a finalize, every variable might not have been assigned yet, so each one reads as possibly-null. Check with `!= null` before using them.
- Keep finalize bodies computational. The guard that tripped is still aborting, so an `llm()` or `sleep()` inside the finalize gets cancelled; combine the values you already have.
- One finalize per function or block, at the top level of its body. Convention: put it last.
- If both a `saveDraft` and a finalize exist, the finalize wins; if the finalize itself fails, the saved draft is used instead.
- In a function with a finalize, a `return` expression that contains a call must be just the call (`return f(x)`). Anything more complex is a compile error — assign to a local first.

## Nested guards

Guards are scoped — an inner trip does **not** trip an outer guard:

```ts
const outer = guard(cost: $10.0) {
  const inner = guard(cost: $0.001) {
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
guard(cost: $5.0) {
  fork(jobs) as job {
    // per-branch sub-budget, isolated
    guard(cost: $0.50) {
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
