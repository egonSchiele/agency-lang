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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L39))

## Constants

### AGENT_SPILL_OVER

Tool-result length threshold used by agents that offer saved-output readers.
A longer result is saved in the run and replaced with a preview and a name
for reading it back. A lower `maxToolResultChars` also triggers saving.

```ts
/** Tool-result length threshold used by agents that offer saved-output readers.
A longer result is saved in the run and replaced with a preview and a name
for reading it back. A lower `maxToolResultChars` also triggers saving. */
export static const AGENT_SPILL_OVER = 100000
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L18))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L24))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L32))

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

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| model | `string` |  | Model override, or "" for the ambient model. |
| provider | `string` |  | Provider for the override, ignored when model is empty. |
| tools | `any[]` | [] |  |
| hostedTools | `string[]` | [] | Provider-hosted tool identifiers to enable. |
| reasoningEffort | `ReasoningEffort \| null` | null | Requested reasoning level, or null to leave it unset. |
| thinking | `boolean` | false |  |
| validationRetries | `number` | 0 | Retries after structured-output validation fails, or zero to leave the option unset. |
| maxToolCallRounds | `number` | 0 | Maximum tool rounds, or zero for the configured default. |
| spillToolResultsOver | `number` | 0 | Save results above this threshold and give the model their path, or zero to leave spilling unset. The tools need something that reads a path: `read`, a shell tool built on `safeBash`, or `readSpill`. |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/lib/shared.agency#L41))
