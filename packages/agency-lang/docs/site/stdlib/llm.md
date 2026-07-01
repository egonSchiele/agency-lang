---
name: "llm"
---

# llm

Pick which model and options `llm()` calls use at runtime.

`setModel` / `setLlmOptions` set defaults for subsequent `llm()` calls;
`pickProvider` detects an available provider from API-key env vars.

Defaults are branch-scoped — a `fork`/`race` branch inherits the
run-wide default, but a `setModel` inside the branch stays local — and
they survive interrupt/resume. A per-call `llm(..., { ... })` option
always overrides these defaults.

## Types

### LlmDefaults

Default options for `llm()` calls. Every field is optional; only the
 *  fields you pass are changed. `provider` is normally derived from the
 *  model name — set it only when the name doesn't imply a provider (e.g.
 *  a custom or local model).

```ts
/** Default options for `llm()` calls. Every field is optional; only the
 *  fields you pass are changed. `provider` is normally derived from the
 *  model name — set it only when the name doesn't imply a provider (e.g.
 *  a custom or local model). */
export type LlmDefaults = {
  model?: string;
  provider?: string;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  maxTokens?: number;
  maxToolResultChars?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L26))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L125))

## Functions

### setLlmOptions

```ts
setLlmOptions(opts: LlmDefaults)
```

Set default options for subsequent llm() calls. Only the fields you
  pass are changed; a per-call llm(..., { ... }) option overrides them.

  @param opts - The default LLM options to merge in

**Parameters:**

| Name | Type | Default |
|---|---|---|
| opts | [LlmDefaults](#llmdefaults) |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L35))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L45))

### envVarFor

```ts
envVarFor(provider: string): string
```

Return the environment variable that holds the API key for a recognized
  provider, or "" for an unrecognized name. Recognized: "anthropic"
  (ANTHROPIC_API_KEY), "google" (GEMINI_API_KEY), "openai" (OPENAI_API_KEY),
  "openrouter" (OPENROUTER_API_KEY), "litellm" (LITELLM_API_KEY). Note that
  "litellm" also requires a base URL (LITELLM_BASE_URL); this returns only
  the API-key var.

  @param provider - The provider name to map

**Parameters:**

| Name | Type | Default |
|---|---|---|
| provider | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L54))

### pickProvider

```ts
pickProvider(order: string[]): Result<string>
```

Return the first provider in `order` whose API-key environment variable
  is set, or a failure if none are. A provider is checkable when `envVarFor`
  knows its key var (anthropic, google, openai, openrouter, litellm);
  unrecognized names in `order` are skipped.

  @param order - Providers to check, highest preference first

**Parameters:**

| Name | Type | Default |
|---|---|---|
| order | `string[]` | ["anthropic", "google", "openai"] |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L83))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L113))

### listHostedModels

```ts
listHostedModels(): HostedModelInfo[]
```

All known hosted text models (baked catalog plus any refreshed data), for
  discovery and model pickers. Backed by smoltalk's getAllModels.

**Returns:** `HostedModelInfo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L135))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L143))

### loadModelData

```ts
loadModelData(path: string): Result<number>
```

Load model data from a JSON file (the shape `agency models refresh` prints)
  and register it for this program, so `llm()` and the model catalog
  (`listHostedModels` / `hostedModelInfo`) recognize those models. Multiple
  loads accumulate. Returns the number of models loaded, or a failure if the
  file cannot be read.

  @param path - Path to a model-data JSON file

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |

**Returns:** `Result<number>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L160))
