---
name: "embedding"
description: "Turn text into embedding vectors, and compare them, for similarity search and clustering."
---

# embedding

Turn text into embedding vectors. An embedding is a list of numbers
that stands for the meaning of a piece of text. Two texts with similar
meaning get vectors that are close together. You can use embeddings to
find related documents, group similar notes, or rank matches for a
query.

  ```ts
  import { embed, embedMany, cosineSimilarity } from "std::embedding"

  node main() {
    const query = embed("a red bicycle in the rain")
    const docs = embedMany(["apples", "oranges", "a bicycle"])
    if (isFailure(query) || isFailure(docs)) { return }
    const score = cosineSimilarity(query.value.vector, docs.value.vectors[2])
    print(score)
  }
  ```

`embed` turns one string into one vector. `embedMany` turns a list of
strings into one vector each, in the same order, with one provider call.
`cosineSimilarity` compares two vectors and returns a number from -1 to
1. A score of 1 means the two texts are closest in meaning.

Each call to `embed` or `embedMany` costs money and counts toward the
branch's cost and token totals, the same way `llm()` does. Cost guards
apply.

The default model is OpenAI's `text-embedding-3-small`. Pass `model` to
pick another one. The provider is derived from the model name, or you
can set `provider` yourself. Ollama works as a local provider. Only
compare vectors that came from the same model.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/embedding.agency#L39))

### Embeddings

One vector per input, in input order, and the model that produced them.

```ts
/** One vector per input, in input order, and the model that produced them. */
export type Embeddings = {
  vectors: number[][];
  model: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/embedding.agency#L45))

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
  @param model - Embedding model (default: text-embedding-3-small). For a local provider (mlx, llama-cpp) this may be a catalog name, alias, or path
  @param provider - Override the provider (normally derived from the model name)
  @param dimensions - Shorten the vector to this length, for models that support it (0 means the model's full length)
  @param apiKey - Override the API key
  @param baseUrl - Base URL for the ollama, deepinfra, litellm, openai-compat, or mlx provider

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/embedding.agency#L50))

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
  @param model - Embedding model (default: text-embedding-3-small). For a local provider (mlx, llama-cpp) this may be a catalog name, alias, or path
  @param provider - Override the provider (normally derived from the model name)
  @param dimensions - Shorten each vector to this length, for models that support it (0 means the model's full length)
  @param apiKey - Override the API key
  @param baseUrl - Base URL for the ollama, deepinfra, litellm, openai-compat, or mlx provider

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/embedding.agency#L75))

### cosineSimilarity

```ts
cosineSimilarity(a: number[], b: number[]): Result<number>
```

Compare two embedding vectors. Returns a number from -1 to 1, where 1 means the texts are closest in meaning. Fails if the vectors differ in length, are empty, or are all zeros.

  @param a - The first vector
  @param b - The second vector

**Parameters:**

| Name | Type | Default |
|---|---|---|
| a | `number[]` |  |
| b | `number[]` |  |

**Returns:** `Result<number>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/embedding.agency#L96))
