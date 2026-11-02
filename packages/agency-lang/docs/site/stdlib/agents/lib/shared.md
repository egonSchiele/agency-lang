---
name: "shared"
description: "Build agent prompts and LLM options, and restrict evals to bundled docs."
---

# shared

Use `withContext` to add optional material to a task and `llmOptions` to
apply model overrides consistently. `docsOnlyHandler` lets an eval worker
read packaged documentation while rejecting other interrupts.

## Types

### ReasoningEffort

```ts
export type ReasoningEffort = "low" | "medium" | "high"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L35))

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

Approve packaged-document reads and reject other interrupts.

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

Append optional context to a task prompt, returning the task unchanged when context is empty.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L28))

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

Build LLM options for an agent call, using the ambient model unless overridden.

  @param model - Model override, or "" for the ambient model.
  @param provider - Provider for the override, ignored when model is empty.
  @param hostedTools - Provider-hosted tool identifiers to enable.
  @param reasoningEffort - Requested reasoning level, or null to leave it unset.
  @param validationRetries - Retries after structured-output validation fails, or zero to leave the option unset.
  @param maxToolCallRounds - Maximum tool rounds, or zero for the configured default.
  @param spillToolResultsOver - Save results above this threshold, requiring `readSpill` in tools, or zero to leave spilling unset.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L37))
