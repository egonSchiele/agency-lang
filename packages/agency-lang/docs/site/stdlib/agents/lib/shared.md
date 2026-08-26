---
name: "shared"
description: "Helpers every std::agents worker uses: context folding, model"
---

# shared

overrides, and the handler an eval entry node runs its worker under.

## Types

### ReasoningEffort

```ts
export type ReasoningEffort = "low" | "medium" | "high"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L29))

## Functions

### evalHandler

```ts
evalHandler(intr)
```

The handler for an eval entry node. A worker under evaluation may read
  the docs that ship in this package (that is how it looks up syntax), and
  nothing else: every other interrupt, including a budget trip, is
  rejected so the caps stay caps and no write or command escapes.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| intr |  |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L11))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L18))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L31))
