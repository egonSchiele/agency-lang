---
name: "researcher"
description: "Answer research questions using web and Wikipedia sources."
---

# researcher

Use `researcherAgent` for a cited answer from retrieved sources. It asks
for an answer again when the first reply is too short and reports a failure
if that follow-up is blank. No separate reviewer checks the answer.

As an LLM tool, this handoff continues the caller's conversation. From code,
use a `thread` block to isolate the research. `keepDraft: false` makes a
budget stop a failure even when a draft is available. The draft is then in
the failure's data as `draft`. Pass `offerSaveDraft: false` as well when
nothing reads that draft, so the model spends no rounds saving one.

The model reports progress in a sentence beside each tool call, and
nothing prints it by default. `std::agents/lib/toolkits` shows the
callback that does.

## Types

### ResearchEvalInput

What an eval hands the researcher: the question, and the conversation
  before it when the test has one. The shape the `evals/researcher` suite
  uses as its input.

```ts
/** What an eval hands the researcher: the question, and the conversation
  before it when the test has one. The shape the `evals/researcher` suite
  uses as its input. */
export type ResearchEvalInput = {
  task: string;
  history?: ThreadMessage[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L207))

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the researcher's source lookup and communication tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L48))

### researcherAgent

```ts
@guarded(cost: maxCost, time: maxTime, keepDraft: keepDraft)
researcherAgent(
  task: string,
  context: string = "",
  maxCost: number = $50.00,
  maxTime: number = 30m,
  model: string = "",
  provider: string = "",
  extraTools: any[] = [],
  history: ThreadMessage[] = [],
  keepDraft: boolean = true,
  offerSaveDraft: boolean = true,
): Result<string>
```

Answer a research question from web and Wikipedia sources and return a
  cited answer.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| task | `string` |  | The research question |
| context | `string` | "" | Extra material folded into the prompt, or "" |
| maxCost | `number` | $50.00 | Cost budget in USD. |
| maxTime | `number` | 30m | Time budget in milliseconds. |
| model | `string` | "" | Model override, or "" for the ambient model |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |
| extraTools | `any[]` | [] | Extra tools to offer the LLM, appended to the built-in set |
| history | `ThreadMessage[]` | [] | Prior messages, oldest first, used only when the active thread is empty. |
| keepDraft | `boolean` | true | False returns a budget failure even when a draft was saved. |
| offerSaveDraft | `boolean` | true | False keeps `saveDraft` out of the model's tools, for a caller that never reads the draft. |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/researcher.agency#L148))
