---
name: "thread"
---

# thread

## Types

### ModelCost

```ts
export type ModelCost = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L78))

### GuardFailureData

```ts
export type GuardFailureData = {
  type: string;
  maxCost: number | null;
  actualCost: number | null;
  maxTime: number | null;
  actualTime: number | null
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L101))

## Functions

### systemMessage

```ts
systemMessage(msg: string)
```

Add a system message to the current thread's message history.
  The message becomes part of the conversation context for subsequent
  llm() calls.

  @param msg - The system message content

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L18))

### userMessage

```ts
userMessage(msg: string)
```

Add a user message to the current thread's message history.
  Use this when you want to seed the conversation with prior user
  context that wasn't actually typed by the user this turn.

  @param msg - The user message content

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L29))

### assistantMessage

```ts
assistantMessage(msg: string)
```

Add an assistant message to the current thread's message history.
  Use this to inject prior assistant turns when reconstructing a
  conversation programmatically.

  @param msg - The assistant message content

**Parameters:**

| Name | Type | Default |
|---|---|---|
| msg | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L40))

### getCost

```ts
getCost(): number
```

Get the cumulative cost (USD, floating point) of all LLM calls
  contributing to the current execution branch.

  Inside a fork/race branch, this returns the parent's accumulated
  cost plus the cost incurred so far inside this branch. After all
  branches join, the parent sees the sum of its own cost plus every
  branch's cost (race losers included — their LLM calls really
  happened and cost real money).

  To measure a specific section, capture getCost() before and after:
  const before = getCost()
  // ... do work ...
  const sectionCost = getCost() - before

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L51))

### getTokens

```ts
getTokens(): number
```

Get the cumulative token count for the current execution branch.
  Same per-branch semantics as getCost().

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L70))

### getModelCosts

```ts
getModelCosts(): ModelCost[]
```

Get a per-model breakdown of cumulative LLM usage, one entry per
  model that has been called, sorted by cost descending.

  Unlike getCost()/getTokens() (which read the per-branch accumulator),
  this reads the process-wide totals across every branch — including
  subagents and tool calls that run on a different model. Useful for a
  cost summary that attributes spend per model.

  Each entry has `model` (the model name), `inputTokens`,
  `outputTokens`, and `cost` (USD).

**Returns:** `ModelCost[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L85))

### guard

```ts
guard(cost: number | null, time: number | null, block: () => any): Result
```

Run a block under a cost limit, a time limit, or both. The block
  aborts as soon as either limit is exceeded; whichever fires first
  wins. At least one of `cost` or `time` must be supplied.

  On success, returns `success(blockReturnValue)`. The block's local
  variables are scoped to the block — only the block's return value
  is observable from the caller. Use isFailure(result) to branch on
  the trip; inspect `result.error.type` to distinguish:
  - "guardFailure" — cumulative LLM cost exceeded `cost`. Read
  `result.error.maxCost` and `result.error.actualCost`.
  - "timeoutFailure" — compute time inside the block exceeded
  `time`. Read `result.error.maxTime` and `result.error.actualTime`
  (milliseconds).

  Time semantics are compute-time: wall clock only ticks while a
  Runner is actively executing inside the guarded scope. Time spent
  paused on an interrupt (e.g. waiting for user input) does NOT count
  against the budget; on resume the timer is re-armed with the
  remaining budget.

  Nested guards are independent: an inner trip does not trip an outer
  guard. Fork/race branches: cost guards are cloned per branch (each
  branch independently tracks cost-since-push); time guards are NOT
  cloned — the parent's timer is the single source of truth and the
  abort cascade propagates to every branch.

  `thread { ... }` and `subthread { ... }` isolate message history
  but NOT cost or abort plumbing. A guard wrapping a thread block
  sees every LLM call inside it.

  Limitations: tool calls whose body is a JS function (rather than
  Agency code) cannot be aborted mid-execution — the JS function runs
  to completion in the background and its result is discarded. Memory
  layer LLM calls (memory.text / memory.embed) currently bypass cost
  guards. Cost deltas from inside a fork only propagate to an outer
  cost guard at fork completion, not mid-flight.

  @param cost - Maximum cost in dollars (e.g. $2.00 or 2.00). null = no cost limit.
  @param time - Maximum compute time in milliseconds (e.g. 30s, 5m, or a raw number). null = no time limit.
  @param block - The work to run under the guard.

  Example:

  ```ts
  const result = guard(cost: $2.0, time: 30s) as {
    const a = llm("step 1")
    const b = llm("step 2")
    return a + b
  }
  if (isFailure(result)) {
    print("Guard tripped: " + result.error.type)
  } else {
    print(result.value)
  }
  ```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cost | `number \| null` | null |
| time | `number \| null` | null |
| block | `() => any` | null |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/thread.agency#L113))
