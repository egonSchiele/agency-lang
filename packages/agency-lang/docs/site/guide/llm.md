---
name: LLM Calls
description: How to make LLM calls in Agency, including structured outputs via type annotations, model and provider configuration, streaming, tool use, and memory.
---

# LLM Calls

To make a basic LLM call, use the built-in `llm` function.

```ts
const response = llm("What is the capital of France?")
print(response)
```

## Structured output

To specify structured output, simply add a type annotation.

```ts
type Response = {
  capital: string
}
const response: Response = llm("What is the capital of France?")
print(response.capital)
```

You can also annotate properties on the type using `#` to give the LLM more guidance on what to return.

```ts
type Response = {
  capital: string # the capital city of the country
  population: number # the population of the capital city
}
const response: Response = llm("What is the capital of France?")
```

## Tool calls

Any function defined in Agency can automatically be used as a tool for the LLM. Pass the function in the `tools` option:

```ts
def add(a: number, b: number): number {
  return a + b
}

const result = llm("What is 4 + 5?", tools: [add])
print(result)
```

Functions are covered in more detail in the [chapter on functions](/guide/functions).

## Validation

You can also use the `T!` shorthand to validate the LLM's output at runtime:

```ts
type Response = {
  capital: string
  population: number
}

const response: Response! = llm("What is the capital of France?")
```

`response` is now a `Result` object. We'll cover these concepts in more detail later.

### References
- [the `Result` type](/guide/error-handling)
- [Schemas and validated types](/guide/schemas)

## Message threads

If you make multiple LLM calls in a row, they will all share the same message history (called a message thread):

```ts
const response1 = llm("What is the capital of France?")
const response2 = llm("What is the population of that city?")
```

Message threads are covered in more detail in the [chapter on message threads](/guide/message-threads).

## Where you can call the `llm` function

- Inside nodes and functions = yes
- Inside callbacks or in the global scope = no

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
| `apiKey` | `string` |
| `maxTokens` | `number` |
| `temperature` | `number` |
| `reasoningEffort` | `"low" \| "medium" \| "high"` |
| `thinking` | `{ enabled: boolean, budgetTokens?: number }` |
| `stream` | `boolean` |

`apiKey` is the OpenAI API key for this call. To configure keys for other providers, set them in `agency.json` under `client.apiKey` (a per-provider object) or via the `OPENAI_API_KEY` / provider-specific environment variables.

### Tools & context

| Option | Type | Description |
|---|---|---|
| `tools` | `any[]` | Tools the model may call. |
| `hostedTools` | `string[]` | Provider tools to enable (e.g. `["web_search"]`). |
| `memory` | `boolean` | Enable [memory](/guide/memory). |
| `maxToolResultChars` | `number` | Limit the number of characters from a tool call that are sent back to the model (`0` to disable). |

### Resilience

| Option | Type |
|---|---|
| `retries` | `number` |
| `timeout` | `duration` |
| `backoff` | `{ initial?: duration, factor?: number, max?: duration }` |

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