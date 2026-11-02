---
name: "llm"
description: "Choose which model and options your `llm()` calls use at runtime."
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

### OpenRouterProviderPreferences

How OpenRouter picks the company that runs the model. Provider names
   are OpenRouter's slugs, such as `"z-ai"` or `"fireworks"`. Mirrors
   smoltalk's `OpenRouterProviderPreferences`.

```ts
/** How OpenRouter picks the company that runs the model. Provider names
   are OpenRouter's slugs, such as `"z-ai"` or `"fireworks"`. Mirrors
   smoltalk's `OpenRouterProviderPreferences`. */
export type OpenRouterProviderPreferences = {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allowFallbacks?: boolean;
  requireParameters?: boolean;
  dataCollection?: "allow" | "deny";
  sort?: "price" | "throughput" | "latency";
  quantizations?: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L36))

### OpenRouterOptions

OpenRouter-only `llm()` options. Other providers ignore them.

```ts
/** OpenRouter-only `llm()` options. Other providers ignore them. */
export type OpenRouterOptions = {
  provider?: OpenRouterProviderPreferences
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L48))

### WarnAtRoundsLeft

When the tool loop warns the model that its tool rounds are running
   out. See `warnAtRoundsLeft` on `LlmDefaults`.

```ts
/** When the tool loop warns the model that its tool rounds are running
   out. See `warnAtRoundsLeft` on `LlmDefaults`. */
export type WarnAtRoundsLeft = {
  remaining?: number;
  text?: string;
  finalWarning?: boolean;
  finalWarningText?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L54))

### LlmBaseUrls

The base URL for each provider that takes one. Each field is
   optional. A provider left out uses the URL from `agency.json`, or its
   default.

```ts
/** The base URL for each provider that takes one. Each field is
   optional. A provider left out uses the URL from `agency.json`, or its
   default. */
export type LlmBaseUrls = {
  openAiCompat?: string;
  openRouter?: string;
  deepInfra?: string;
  liteLlm?: string;
  mlx?: string;
  ollama?: string;
  typesafe?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L64))

### LlmDefaults

Default options for `llm()` calls. Every field is optional; only the
   fields you pass are changed. `provider` is normally derived from the
   model name. Set it only when the name doesn't imply a provider (e.g.
   a custom or local model).

   `thinking` turns a model's thinking on or off, with an optional budget
   of tokens it may think for before it has to answer. On a local MLX
   model, `{ enabled: false }` skips the thinking entirely, which is the
   biggest saving there is on a small task.

   `replyLimits` changes how the MLX chat server treats a reply that goes
   in circles: `hedgeLimit` is how many second thoughts ("But wait",
   "Hmm") it allows and `repeatLimit` how many times one sentence may
   repeat, both within the last two thousand tokens, and `limitAnswers`
   watches the answer as well as the thinking. `0` turns a limit off,
   which a song with a chorus needs. Other providers ignore it.

   `openRouter.provider` chooses which companies OpenRouter may send the
   call to, for example `{ provider: { ignore: ["open-inference"] } }` to
   skip one, or `{ provider: { only: ["fireworks"], allowFallbacks: false } }`
   to use only one. Other providers ignore it. `rawAttributes` is spread
   into the provider's request body as given, for a request field Agency
   has no option for, such as `{ top_k: 5 }`.

   `warnAtRoundsLeft` warns the model before it runs out of tool rounds
   (`maxToolCallRounds`). When `remaining` rounds are left (default 3),
   the call sends `text` as a user message; when one round is left and
   `finalWarning` is true (the default), it sends `finalWarningText`. In
   either text, `{remaining}` becomes the number of rounds left and
   `{limit}` the cap. Each warning is sent once per `llm()` call and is
   removed from the thread when the call returns. `remaining: 0` turns
   the first warning off. The default texts are "Of the {limit} tool
   rounds for this request, {remaining} remain. Finish what you can with
   them and then write your answer." and "This is the last tool round for
   this request. The results of the tool calls you make now are the last
   you will see. After them, write your answer from what you have." A
   call's own `warnAtRoundsLeft` combines with this one field by field.

   `baseUrl` sets the base URLs to use for the providers it names, for
   example `{ mlx: "http://studio.local:8090/v1" }` to reach an MLX
   server on another machine. A later `setLlmOptions` call with `baseUrl`
   replaces this one whole. A provider it leaves out uses the URL from
   `agency.json`, or its default.

   Setting a field to `null` removes it, so the value `agency.json` gives
   it, if any, applies again. To turn OpenRouter routing off entirely,
   pass `openRouter: {}`.

```ts
/** Default options for `llm()` calls. Every field is optional; only the
   fields you pass are changed. `provider` is normally derived from the
   model name. Set it only when the name doesn't imply a provider (e.g.
   a custom or local model).

   `thinking` turns a model's thinking on or off, with an optional budget
   of tokens it may think for before it has to answer. On a local MLX
   model, `{ enabled: false }` skips the thinking entirely, which is the
   biggest saving there is on a small task.

   `replyLimits` changes how the MLX chat server treats a reply that goes
   in circles: `hedgeLimit` is how many second thoughts ("But wait",
   "Hmm") it allows and `repeatLimit` how many times one sentence may
   repeat, both within the last two thousand tokens, and `limitAnswers`
   watches the answer as well as the thinking. `0` turns a limit off,
   which a song with a chorus needs. Other providers ignore it.

   `openRouter.provider` chooses which companies OpenRouter may send the
   call to, for example `{ provider: { ignore: ["open-inference"] } }` to
   skip one, or `{ provider: { only: ["fireworks"], allowFallbacks: false } }`
   to use only one. Other providers ignore it. `rawAttributes` is spread
   into the provider's request body as given, for a request field Agency
   has no option for, such as `{ top_k: 5 }`.

   `warnAtRoundsLeft` warns the model before it runs out of tool rounds
   (`maxToolCallRounds`). When `remaining` rounds are left (default 3),
   the call sends `text` as a user message; when one round is left and
   `finalWarning` is true (the default), it sends `finalWarningText`. In
   either text, `{remaining}` becomes the number of rounds left and
   `{limit}` the cap. Each warning is sent once per `llm()` call and is
   removed from the thread when the call returns. `remaining: 0` turns
   the first warning off. The default texts are "Of the {limit} tool
   rounds for this request, {remaining} remain. Finish what you can with
   them and then write your answer." and "This is the last tool round for
   this request. The results of the tool calls you make now are the last
   you will see. After them, write your answer from what you have." A
   call's own `warnAtRoundsLeft` combines with this one field by field.

   `baseUrl` sets the base URLs to use for the providers it names, for
   example `{ mlx: "http://studio.local:8090/v1" }` to reach an MLX
   server on another machine. A later `setLlmOptions` call with `baseUrl`
   replaces this one whole. A provider it leaves out uses the URL from
   `agency.json`, or its default.

   Setting a field to `null` removes it, so the value `agency.json` gives
   it, if any, applies again. To turn OpenRouter routing off entirely,
   pass `openRouter: {}`. */
export type LlmDefaults = {
  model?: string;
  provider?: string;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  thinking?: { enabled: boolean; budgetTokens: number | null };
  replyLimits?: { hedgeLimit: number | null; repeatLimit: number | null; limitAnswers: boolean | null };
  maxTokens?: number;
  maxToolResultChars?: number;
  maxToolCallRounds?: number;
  maxRepeatedToolCalls?: number;
  warnAtRoundsLeft?: WarnAtRoundsLeft;
  openRouter?: OpenRouterOptions;
  baseUrl?: LlmBaseUrls;
  rawAttributes?: any;
  retries?: number;
  timeout?: number;
  validationRetries?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L121))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L239))

## Effects

### std::llm::registerProvider

```ts
@always(path)
effect std::llm::registerProvider {
  path: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L217))

### std::read

```ts
@alwaysUnder(dir)
effect std::read {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L284))

## Functions

### setLlmOptions

```ts
setLlmOptions(opts: LlmDefaults)
```

Set default options for subsequent llm() calls. Only the fields you
  pass are changed. A per-call llm(..., { ... }) option overrides them.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| opts | [LlmDefaults](#llmdefaults) |  | The default LLM options to merge in |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L141))

### setModel

```ts
setModel(name: string)
```

Set the default model for subsequent llm() calls.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L151))

### envVarFor

```ts
envVarFor(provider: string): string
```

Return a provider's API-key environment variable name, or an empty string if unknown.

Recognizes anthropic, google, openai, openrouter, and litellm. LiteLLM also
needs LITELLM_BASE_URL; this helper returns only its API-key variable name.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| provider | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L162))

### pickProvider

```ts
pickProvider(
  order: string[] = ["anthropic", "google", "openai"],
): Result<string>
```

Return the first provider in `order` whose API-key environment variable
  is set, or a failure if none are. Checkable providers are anthropic,
  google, openai, openrouter, and litellm; unrecognized names in `order`
  are skipped.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| order | `string[]` | ["anthropic", "google", "openai"] | Providers to check, highest preference first |

**Returns:** `Result<string>`

**Throws:** `std::env`

**Needs:** `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L184))

### registerProviderModule

```ts
registerProviderModule(path: string): Result raises <std::llm::registerProvider>
```

Load a provider module by path at runtime and register its custom provider
  for llm() calls. The module must export register({ registerProvider }).

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| path | `string` |  | Path to the provider module (.mjs/.js) |

**Returns:** `Result`

**Throws:** `std::llm::registerProvider`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L220))

### listHostedModels

```ts
listHostedModels(): HostedModelInfo[]
```

Return all known hosted text models (the built-in catalog plus any
  refreshed data) for model discovery and pickers.

**Returns:** `HostedModelInfo[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L249))

### hostedModelInfo

```ts
hostedModelInfo(name: string): HostedModelInfo | null
```

Metadata for one hosted model by name, or null if the name is unknown or
  is not a text model.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  | The hosted model name (e.g. "gpt-4o-mini") |

**Returns:** `HostedModelInfo | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L257))

### modelSupportsInput

```ts
modelSupportsInput(model: string, modality: string): boolean | null
```

Check catalog support for an input modality; null means unknown.

Use this to decide whether to offer an image or PDF to a model. A null
answer means the catalog has no information; it does not prove incompatibility.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| model | `string` |  |  |
| modality | `string` |  | "image" or "pdf". |

**Returns:** `boolean | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L271))

### loadModelData

```ts
loadModelData(path: string): Result<number> raises <std::read>
```

Load a model-data JSON file into the catalog and return its model count.

Use the JSON produced by `agency models refresh` to add or update model
metadata. Later files win on matching provider and model names, merging
individual fields. Hosted-tool metadata also merges. The returned count is
for this file, not the accumulated catalog.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| path | `string` |  | File produced by agency models refresh, relative to the working directory or absolute. |

**Returns:** `Result<number>`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L297))
