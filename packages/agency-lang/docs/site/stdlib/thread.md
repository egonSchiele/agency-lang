# thread

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
