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

## Model and provider configuration

```ts
const response = llm("What is the capital of France?", {
  model: "claude-opus-4-8",
  provider: "anthropic",
})
```

Based on the provider you selected, the LLM function will look for one of these API keys:

| Provider   | Environment Variable       |
|------------|---------------------------|
| Anthropic  | ANTHROPIC_API_KEY         |
| Google     | GOOGLE_API_KEY            |
| OpenAI     | OPENAI_API_KEY            |
| LiteLLM    | LITELLM_API_KEY           |
| OpenRouter | OPENROUTER_API_KEY        |

You can also pass the API key directly. Check out [llms part 2](/guide/llm-part-2) for a full list of options to the LLM function.

## Structured output

To specify structured output, simply add a type annotation.

```ts
type Response = {
  capital: string
}
const response: Response = llm("What is the capital of France?")
print(response.capital)
```

You can also add a description to a property with `@jsonSchema` to give the LLM more guidance on what to return.

```ts
type Response = {
  @jsonSchema({ description: "the capital city of the country" })
  capital: string,
  @jsonSchema({ description: "the population of the capital city" })
  population: number
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

Functions are covered in more detail in the [section on functions](/guide/functions).

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

Message threads are covered in more detail in the [section on message threads](/guide/message-threads).

## Where you can call the `llm` function

- Inside nodes and functions = yes
- Inside callbacks or in the global scope = no

## References
- [LLM calls, part 2](/guide/llm-part-2)