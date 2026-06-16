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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L20))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L29))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L39))

### pickProvider

```ts
pickProvider(order: string[]): Result<string>
```

Return the first provider in `order` whose API-key environment variable
  is set, or a failure if none are. Recognized providers: "anthropic"
  (ANTHROPIC_API_KEY), "google" (GEMINI_API_KEY), "openai"
  (OPENAI_API_KEY).

  @param order - Providers to check, highest preference first

**Parameters:**

| Name | Type | Default |
|---|---|---|
| order | `string[]` | ["anthropic", "google", "openai"] |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/llm.agency#L63))
