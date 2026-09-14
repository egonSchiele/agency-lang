---
name: "embedding"
description: "Turn text into embedding vectors with a hosted or local model, for similarity search and clustering."
---

# embedding

Turn text into embedding vectors. An embedding is a list of numbers
that places a piece of text in a space where texts with similar meaning
sit close together. Compare two vectors to find related documents, group
similar notes, or pick the best matches for a query.

`embed` takes one string and returns one vector. `embedMany` takes a
list and returns one vector per entry, in the same order, in a single
provider call. Both charge the branch's cost and token totals the same
way `llm()` does, so cost guards apply. `cosineSimilarity` compares two
vectors and returns a number from -1 to 1, where 1 means the texts are
closest in meaning.

  ```ts
  import { embed, embedMany, cosineSimilarity } from "std::embedding"

  node main() {
    const r = embed("a red bicycle in the rain")
    if (isFailure(r)) { print("failed: ${r.error}"); return }
    print(r.value.vector.length)

    const many = embedMany(["apples", "oranges", "a bicycle"])
    if (isSuccess(many)) {
      const score = cosineSimilarity(r.value.vector, many.value.vectors[2])
      print(score)
    }
  }
  ```

The default model is OpenAI's `text-embedding-3-small`. Pass `model` to
pick another; the provider is derived from the model name the same way
`llm()` derives it, or set `provider` explicitly. Local models work
through Ollama today (`provider: "ollama"`). Every vector in one result
comes from the same model, and vectors from different models cannot be
compared with each other.

## Types

### Embedding

One vector and the model that produced it.

```ts
/** One vector and the model that produced it. */
export type Embedding = {
  vector: number[];
  model: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/embedding.agency#L42))

### Embeddings

One vector per input, in input order, and the model that produced them.

```ts
/** One vector per input, in input order, and the model that produced them. */
export type Embeddings = {
  vectors: number[][];
  model: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/embedding.agency#L48))

## Functions

### embed

```ts
embed(
  text: string,
  model: string = "",
  provider: string = "",
  dimensions: number = 0,
  apiKey: string = "",
  baseUrl: string = "",
): Result<Embedding>
```

Turn one piece of text into an embedding vector.

  @param text - The text to embed
  @param model - Embedding model (default: text-embedding-3-small)
  @param provider - Override the provider (normally derived from the model name)
  @param dimensions - Shorten the vector to this length, for models that support it (0 means the model's full length)
  @param apiKey - Override the API key
  @param baseUrl - Base URL for ollama / openai-compat / litellm providers

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| model | `string` | "" |
| provider | `string` | "" |
| dimensions | `number` | 0 |
| apiKey | `string` | "" |
| baseUrl | `string` | "" |

**Returns:** `Result<Embedding>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/embedding.agency#L53))

### embedMany

```ts
embedMany(
  texts: string[],
  model: string = "",
  provider: string = "",
  dimensions: number = 0,
  apiKey: string = "",
  baseUrl: string = "",
): Result<Embeddings>
```

Turn a list of texts into embedding vectors in one call, one vector per text in the same order.

  @param texts - The texts to embed
  @param model - Embedding model (default: text-embedding-3-small)
  @param provider - Override the provider (normally derived from the model name)
  @param dimensions - Shorten each vector to this length, for models that support it (0 means the model's full length)
  @param apiKey - Override the API key
  @param baseUrl - Base URL for ollama / openai-compat / litellm providers

**Parameters:**

| Name | Type | Default |
|---|---|---|
| texts | `string[]` |  |
| model | `string` | "" |
| provider | `string` | "" |
| dimensions | `number` | 0 |
| apiKey | `string` | "" |
| baseUrl | `string` | "" |

**Returns:** `Result<Embeddings>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/embedding.agency#L78))

### cosineSimilarity

```ts
cosineSimilarity(a: number[], b: number[]): Result<number>
```

Compare two embedding vectors. Returns a number from -1 to 1; 1 means the texts are closest in meaning. Fails if the vectors differ in length.

  @param a - The first vector
  @param b - The second vector

**Parameters:**

| Name | Type | Default |
|---|---|---|
| a | `number[]` |  |
| b | `number[]` |  |

**Returns:** `Result<number>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/embedding.agency#L99))
