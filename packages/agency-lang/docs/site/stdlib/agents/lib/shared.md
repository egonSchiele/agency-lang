---
name: "shared"
description: "Helpers every std::agents worker uses: context folding and model"
---

# shared

overrides.

## Types

### ReasoningEffort

```ts
export type ReasoningEffort = "low" | "medium" | "high"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L17))

## Functions

### withContext

```ts
withContext(task: string, context: string): string
```

Fold optional context material into a task prompt. Returns the task
  unchanged when no context is given.

  @param task - The task text
  @param context - Extra material, or "" for none

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L6))

### llmOptions

```ts
llmOptions(
  model: string,
  provider: string,
  tools: any[] = [],
  hostedTools: string[] = [],
  reasoningEffort: ReasoningEffort | null = null,
  thinking: boolean = false,
): any
```

Build an llm options object with an optional model override. Returns a
  fresh object every call and never mutates its arguments. The model and
  provider fields are only set when a model is named, so an empty override
  never clobbers the default model.

  @param model - Model name, or "" for the ambient model
  @param provider - Provider for the model, or "" to auto-resolve
  @param tools - Tools to offer the LLM
  @param hostedTools - Provider-hosted tools to enable
  @param reasoningEffort - Reasoning effort to request from the model, or null for none
  @param thinking - Whether to enable thinking mode, which allows the model to use more time and tokens to reason about its answer

**Parameters:**

| Name | Type | Default |
|---|---|---|
| model | `string` |  |
| provider | `string` |  |
| tools | `any[]` | [] |
| hostedTools | `string[]` | [] |
| reasoningEffort | `ReasoningEffort \| null` | null |
| thinking | `boolean` | false |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L19))
