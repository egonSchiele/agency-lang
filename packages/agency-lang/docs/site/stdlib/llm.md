---
name: "llm"
---

# llm

## Types

### LlmDefaults

```ts
export type LlmDefaults = {
  model?: string;
  temperature?: number;
  reasoningEffort?: string;
  maxTokens?: number;
  maxToolResultChars?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L10))

## Functions

### setLlmOptions

```ts
setLlmOptions(opts: LlmDefaults)
```

Set default options for subsequent `llm()` calls. Only the fields you
  pass are changed; others keep their current value. A per-call
  `llm(..., { ... })` option still overrides these defaults.

  Branch-scoped: a `fork`/`race` branch inherits the defaults active at
  fork time, but a `setLlmOptions(...)` inside a branch affects only that
  branch — it does not leak to siblings or the parent after join. The
  defaults survive interrupt/resume.

  @param opts - The default LLM options to merge in

**Parameters:**

| Name | Type | Default |
|---|---|---|
| opts | [LlmDefaults](#llmdefaults) |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L18))

### setModel

```ts
setModel(name: string)
```

Set the default model for subsequent `llm()` calls. Convenience
  wrapper for `setLlmOptions({ model: name })`.

  A per-call `llm(..., { model })` option still overrides this, and it is
  branch-scoped the same way `setLlmOptions` is.

  @param name - The model name (e.g. "gpt-4o-mini", "claude-opus-4-8")

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L34))

### pickProvider

```ts
pickProvider(order: string[]): Result
```

Detect which LLM provider is available based on API-key environment
  variables, in your preferred order. Returns `success(provider)` with
  the first provider in `order` whose key env var is set, or a
  `failure(message)` listing the variables it checked if none are.

  Recognized providers and their env vars: "anthropic"
  (ANTHROPIC_API_KEY), "google" (GEMINI_API_KEY), "openai"
  (OPENAI_API_KEY). Unrecognized names in `order` are skipped. This only
  detects the provider; mapping a provider to a concrete model is the
  caller's job.

  @param order - Providers to check, highest preference first

**Parameters:**

| Name | Type | Default |
|---|---|---|
| order | `string[]` | ["anthropic", "google", "openai"] |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L60))
