---
name: "llm"
---

# llm

Choose which model and options your `llm()` calls use at runtime.

`setModel` and `setLlmOptions` set defaults for later `llm()` calls,
and `pickProvider` finds an available provider from your API-key
environment variables. Defaults are branch-scoped and survive
interrupt/resume. A per-call `llm(..., { ... })` option always wins.

```ts
import { setModel, setLlmOptions } from "std::llm"

node main() {
  setModel("claude-opus-4-8")
  setLlmOptions({ temperature: 0.2 })
  const answer: string = llm("Say hello")
  print(answer)
}
```

## Types

### LlmDefaults

Default options for `llm()` calls. Every field is optional; only the
 *  fields you pass are changed. `provider` is normally derived from the
 *  model name. Set it only when the name doesn't imply a provider (e.g.
 *  a custom or local model).

```ts
/** Default options for `llm()` calls. Every field is optional; only the
 *  fields you pass are changed. `provider` is normally derived from the
 *  model name. Set it only when the name doesn't imply a provider (e.g.
 *  a custom or local model). */
export type LlmDefaults = {
  model?: string;
  provider?: string;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  maxTokens?: number;
  maxToolResultChars?: number;
  maxToolCallRounds?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L35))

### HostedModelInfo

```ts
export type HostedModelInfo = {
  name: string;
  provider: string;
  openWeights: boolean;
  inputCost: number;
  outputCost: number;
  contextWindow: number;
  family: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L135))

## Functions

### setLlmOptions

```ts
setLlmOptions(opts: LlmDefaults)
```

Set default options for subsequent llm() calls. Only the fields you
  pass are changed. A per-call llm(..., { ... }) option overrides them.

  @param opts - The default LLM options to merge in

**Parameters:**

| Name | Type | Default |
|---|---|---|
| opts | [LlmDefaults](#llmdefaults) |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L45))

### setModel

```ts
setModel(name: string)
```

Set the default model for subsequent llm() calls.

  @param name - The model name, e.g. "gpt-4o-mini" or "claude-opus-4-8"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L55))

### envVarFor

```ts
envVarFor(provider: string): string
```

Return the environment variable that holds the API key for a recognized
  provider, or "" for an unrecognized name. Recognized: "anthropic"
  (ANTHROPIC_API_KEY), "google" (GEMINI_API_KEY), "openai" (OPENAI_API_KEY),
  "openrouter" (OPENROUTER_API_KEY), "litellm" (LITELLM_API_KEY). Note that
  "litellm" also requires a base URL (LITELLM_BASE_URL). This returns only
  the API-key var.

  @param provider - The provider name to map

**Parameters:**

| Name | Type | Default |
|---|---|---|
| provider | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L64))

### pickProvider

```ts
pickProvider(order: string[]): Result<string>
```

Return the first provider in `order` whose API-key environment variable
  is set, or a failure if none are. Checkable providers are anthropic,
  google, openai, openrouter, and litellm; unrecognized names in `order`
  are skipped.

  @param order - Providers to check, highest preference first

**Parameters:**

| Name | Type | Default |
|---|---|---|
| order | `string[]` | ["anthropic", "google", "openai"] |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L93))

### registerProviderModule

```ts
registerProviderModule(path: string)
```

Load a provider module by path at runtime and register its custom provider
  for llm() calls. The module must export register({ registerProvider }).

  @param path - Path to the provider module (.mjs/.js)

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L123))

### listHostedModels

```ts
listHostedModels(): HostedModelInfo[]
```

Return all known hosted text models (the built-in catalog plus any
  refreshed data) for model discovery and pickers.

**Returns:** `HostedModelInfo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L145))

### hostedModelInfo

```ts
hostedModelInfo(name: string): HostedModelInfo | null
```

Metadata for one hosted model by name, or null if the name is unknown or
  is not a text model.

  @param name - The hosted model name (e.g. "gpt-4o-mini")

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

**Returns:** `HostedModelInfo | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L153))

### modelSupportsInput

```ts
modelSupportsInput(model: string, modality: string): boolean | null
```

Whether a model accepts a given input modality ("image" or "pdf").
  Tri-state: true / false when the model catalog says so, null when the
  model or its modality data is unknown. Treat null as "do not gate",
  the same rule llm() applies at send time.

  @param model - The model name (e.g. "gpt-4o-mini")
  @param modality - "image" or "pdf"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| model | `string` |  |
| modality | `string` |  |

**Returns:** `boolean | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L163))

### loadModelData

```ts
loadModelData(path: string): Result<number>
```

Load model data from a JSON file (the shape `agency models refresh`
  prints) and register it so `llm()` and the model catalog recognize
  those models. Multiple loads accumulate. Returns the number of models
  loaded, or a failure if the file cannot be read.

  @param path - Path to a model-data JSON file

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |

**Returns:** `Result<number>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L183))
