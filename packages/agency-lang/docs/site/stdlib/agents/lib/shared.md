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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L38))

## Constants

### AGENT_SPILL_OVER

```ts
export static const AGENT_SPILL_OVER = 100000
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L14))

## Functions

### docsOnlyHandler

```ts
docsOnlyHandler(intr)
```

Approves reads of the docs that ship in this package and rejects every
  other interrupt. Run a worker under it when it may look up syntax but
  must not write, run commands, or escape a budget trip. The stdlib eval
  entry nodes use it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| intr |  |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L20))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L27))

### llmOptions

```ts
llmOptions(
  model: string,
  provider: string,
  tools: any[] = [],
  hostedTools: string[] = [],
  reasoningEffort: ReasoningEffort | null = null,
  thinking: boolean = false,
  validationRetries: number = 0,
  maxToolCallRounds: number = 0,
  spillToolResultsOver: number = 0,
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
  @param validationRetries - How many times to resend a structured-output call whose answer failed schema validation, or 0 for none
  @param maxToolCallRounds - Tool-call rounds the call may use, or 0 for the configured default
  @param spillToolResultsOver - Save a tool result longer than this or than maxToolResultChars in the run and send the model a preview, or 0 to cut long results instead. The tools must include readSpill

**Parameters:**

| Name | Type | Default |
|---|---|---|
| model | `string` |  |
| provider | `string` |  |
| tools | `any[]` | [] |
| hostedTools | `string[]` | [] |
| reasoningEffort | `ReasoningEffort \| null` | null |
| thinking | `boolean` | false |
| validationRetries | `number` | 0 |
| maxToolCallRounds | `number` | 0 |
| spillToolResultsOver | `number` | 0 |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L40))
