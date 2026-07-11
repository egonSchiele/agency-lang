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

## The `safe` keyword

LLMs are often flaky. It's possible that your LLM will call a tool incorrectly for some reason. If this happens, it's possible to get the LLM to retry the tool call.

Some functions are okay to retry and some aren't. If you have a function that has a side effect, like writing to a database, you probably don't want the LLM to retry it automatically. However, if you have a function that doesn't have any side effects, you can mark it `safe` to retry:

```ts
safe def add(a: number, b: number): number {
  return a + b
}
```

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

### Validation retries

Transport retries handle a provider that failed to answer. Validation
retries handle a provider that answered with the wrong shape. When an
`llm()` call declares a result type and the response fails validation,
Agency sends the validation error back to the model and asks again:

```ts
const person: Person = llm("Describe a scientist", { validationRetries: 2 })
```

After the retries run out, the call returns a failure. Use the bang
syntax (`Person!`) to handle it locally, or `catch` for a default value.
Validation retries cost tokens, unlike transport retries, so they are
off by default. `setLlmOptions({ validationRetries: 2 })` sets a
branch-wide default.

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