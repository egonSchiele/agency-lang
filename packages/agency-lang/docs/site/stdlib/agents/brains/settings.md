---
name: "settings"
description: "The settings the Agency agent's brains and subagent wrappers"
---

# settings

share, and the model options built from them. `agencyAgent` in
  `std::agents/agency` builds the record from its parameters.

## Types

### AgentSettings

What a brain and its subagent wrappers need to know about one call. An
  empty model or provider means the ambient one, which `setModel` or
  `setLlmOptions` chose.

```ts
/** What a brain and its subagent wrappers need to know about one call. An
  empty model or provider means the ambient one, which `setModel` or
  `setLlmOptions` chose. */
export type AgentSettings = {
  // Extra text for every model the call runs, such as the user's own
  // instructions. "" for none.
  context: string;
  // The main model. The coder, the researcher, and the reviewers run on it.
  model: string;
  provider: string;
  // The coordinator's own calls, the oracle, and the explorer run on this
  // one. "" means the main model.
  reasoningModel: string;
  reasoningProvider: string;
  // The small model that sends a plain message straight to the coder or
  // the researcher. "" means no routing.
  routerModel: string;
  routerProvider: string;
  // Tools added to the coder's and the Agency coder's own.
  coderTools: any[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/settings.agency#L10))

### ModelChoice

A model and its provider, as the stdlib agents take them.

```ts
/** A model and its provider, as the stdlib agents take them. */
export type ModelChoice = {
  model: string;
  provider: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/settings.agency#L30))

## Functions

### modelOptions

```ts
modelOptions(model: string, provider: string): any
```

Return the `llm()` options that pick `model` and `provider`, or no
  options when `model` is empty, so the ambient model stays in place.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| model | `string` |  | The model name, or "" for the ambient model |
| provider | `string` |  | The model's provider |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/settings.agency#L35))

### reasoningChoice

```ts
reasoningChoice(settings: AgentSettings): ModelChoice
```

Return the reasoning model and its provider, or the main model when no
  reasoning model is set.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](#agentsettings) |  | The call's settings |

**Returns:** [ModelChoice](#modelchoice)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/settings.agency#L52))

### reasoningOptions

```ts
reasoningOptions(settings: AgentSettings): any
```

Return the `llm()` options that pick the reasoning model, or the main
  model when no reasoning model is set.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| settings | [AgentSettings](#agentsettings) |  | The call's settings |

**Returns:** `any`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/settings.agency#L71))
