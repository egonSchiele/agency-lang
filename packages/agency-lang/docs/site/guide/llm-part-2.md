---
name: LLM Calls, Part 2
description: More about LLM calls in Agency, including retries, timeouts, backoff, and other options.
---

# LLM calls, Part 2

Remember that LLM calls look like this.

```ts
const response = llm("What is the capital of France?")
print(response)
```

Read the section on [LLM calls](/guide/llm) if you need a refresher.

## When a tool call fails

LLMs are often flaky. A tool the model calls can fail: it might get the arguments wrong, or the tool itself might hit an error partway through. When that happens, the model sees the failure and can try again on its next turn.

The question is: should it be *allowed* to try again? For most tools, yes — retrying a failed read or a failed calculation is harmless. But some tools are dangerous to re-run. If a tool charged a credit card and then failed, blindly calling it again might charge the card twice. Agency lets you say which tools are which.

By default, a tool that fails stays callable. The model can call it again. This is the right default for the common case, but note what it does *not* say: it does not promise the tool is safe to re-run automatically. A human or an automated system should not assume an unmarked tool can be blindly repeated.

### `destructive`

Mark a tool `destructive` when re-running it could cause real damage — charging a card, sending an email, deleting a file:

```agency
destructive def chargeCard(amount: number): string {
  // ... talk to the payment provider ...
  return "charged"
}
```

If a `destructive` tool starts running and then fails, Agency removes it from the conversation. The model cannot call it again, and the tool result tells it so: the operation may have partially completed, so the state must be verified by hand rather than by retrying.

There is one exception. If the call fails *before the tool body starts* — the model passed the wrong arguments, or too few — then nothing happened yet, so the tool stays callable. Only a failure *after* the destructive work began locks the tool out.

### `idempotent`

Mark a tool `idempotent` when re-running it is always safe, no matter how many times it happens — reading a record, looking something up, a pure calculation:

```agency
idempotent def add(a: number, b: number): number {
  return a + b
}
```

An `idempotent` tool stays callable after a failure (like the default), but the marker also records a promise you can rely on elsewhere: automated systems may re-run it freely.

### Choosing a marker

| Marker | Re-callable after a failure? | Meaning |
|---|---|---|
| *(unmarked)* | Yes | Re-callable, but not promised safe to repeat blindly. |
| `idempotent` | Yes | Always safe to re-run. |
| `destructive` | Only if it never started | Dangerous to repeat; locked out once it begins. |

These markers are about *retry safety* only. They are independent of [interrupts](/guide/interrupts), which gate whether a tool runs at all.

## Retries and timeouts

You can set timeouts for LLM calls, you can retry them multiple times, and you can set a backoff for how long to wait before retrying.

```ts
llm("Write a haiku about summer", {
  // max retry attempts (default 2; 0 disables)
  retries: 2,

  // per-attempt deadline (default 10min; 0 disables)
  timeout: 30s,

  backoff: {
    initial: 500ms,
    factor: 2,
    max: 10s
  },
})
```

### What's retried

Connection drops (ECONNRESET, fetch failed, …), `5xx`, `429`. A `429` is for rate limiting, and usually comes with a `Retry-After` header, saying how long to wait before retrying. If the LLM returns a `Retry-After` header, we ignore the backoff and use the header's value instead.

### What's not retried

`400`/auth errors, if a [guard](/guide/guards) fires


### When you run out of retries

The call returns a `Failure`, which is covered in the chapter on [error handling](/guide/error-handling). 

## Other options to llm()

You can pass an options object as the second parameter, or use named arguments. All options are optional, and are grouped below by purpose.

### Model & sampling

| Option | Type |
|---|---|
| `model` | `string` |
| `provider` | `string` |
| `apiKey` | `{ openAi?, google?, anthropic?, ollama?, openRouter?, deepInfra?, liteLlm?, openAiCompat? }` |
| `maxTokens` | `number` |
| `temperature` | `number` |
| `reasoningEffort` | `"low" \| "medium" \| "high"` |
| `thinking` | `{ enabled: boolean, budgetTokens?: number }` |
| `stream` | `boolean` |

### Tools & context

| Option | Type | Description |
|---|---|---|
| `tools` | `any[]` | Tools the model may call. |
| `hostedTools` | `string[]` | Provider tools to enable (e.g. `["web_search"]`). |
| `memory` | `boolean` | Enable [memory](/guide/memory). |
| `maxToolResultChars` | `number` | Limit the number of characters from a tool call that are sent back to the model (`0` to disable). |

### Resilience

| Option | Type | Description |
|---|---|---|
| `retries` | `number` | Transport retries: the provider failed to answer. |
| `timeout` | `duration` | Per-attempt deadline. |
| `backoff` | `{ initial?: duration, factor?: number, max?: duration }` | Wait between transport retries. |
| `validationRetries` | `number` | Retries when a structured-output response fails schema validation. Each retry sends the validation error back to the model. Disabled by default (0). Independent of `retries`. |

See [retries and timeouts](#retries-and-timeouts) for more info.

### Escape hatch

| Option | Type | Description |
|---|---|---|
| `metadata` | `any` | Any arbitrary data to pass through to the API directly. |

Agency uses [Smoltalk](https://github.com/egonSchiele/smoltalk) behind the scenes for making LLM calls. Check out the [Smoltalk docs](https://egonschiele.github.io/smoltalk/).

## References
- There are several LLM-related [callbacks](/guide/callbacks).
- [std::llm](/stdlib/llm)
- [std::thread](/stdlib/thread)

TO add: streaming, custom LLM clients.