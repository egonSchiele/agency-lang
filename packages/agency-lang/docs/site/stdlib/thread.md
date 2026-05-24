# thread

## Types

### GuardFailureData

```ts
export type GuardFailureData = {
  type: string;
  maxCost: number;
  actualCost: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/thread.agency#L68))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/thread.agency#L8))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/thread.agency#L19))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/thread.agency#L30))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/thread.agency#L41))

### getTokens

```ts
getTokens(): number
```

Get the cumulative token count for the current execution branch.
  Same per-branch semantics as getCost().

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/thread.agency#L60))

### guard

```ts
guard(cost: number, block: () => any): any
```

Run a block with a cost limit. If LLM calls inside the block cause
  the cumulative cost to exceed the limit, the block halts and `guard`
  returns a failure carrying the limit and the actual spend.

  On success, returns `success(blockReturnValue)`. The block's local
  variables are scoped to the block — only the block's return value
  is observable from the caller. Use isFailure(result) to branch and
  read result.error.maxCost and result.error.actualCost.

  Nested guards are independent: an inner trip does not trip an outer
  guard. Fork/race branches inherit the outer guards at branch-creation
  time, but a branch's cost only rolls up to the outer guard at
  branch-completion — outer guards cannot pre-empt mid-fork.

  Memory layer LLM calls (memory.text / memory.embed) currently bypass
  the guard.

  @param cost - Maximum cost in dollars (e.g. $2.00 or 2.00)
  @param block - The work to run under the guard

  Example:
    const result = guard(cost: $2.0) as {
      const a = llm("step 1")
      const b = llm("step 2")
      return a + b
    }
    if (isFailure(result)) {
      print("Budget exceeded: spent " + result.error.actualCost)
    } else {
      print(result.value)
    }

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cost | `number` |  |
| block | `() => any` |  |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/stdlib/thread.agency#L74))
