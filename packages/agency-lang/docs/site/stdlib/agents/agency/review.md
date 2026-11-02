---
name: "review"
description: "Check Agency source and optionally review it against a task."
---

# review

`agencyReviewAgent` reports parse errors and, when parsing succeeds,
typecheck errors and warnings. Supplying `task` adds an LLM review with
access to the bundled documentation and web sources.

The source is not executed. Use `agencyVerifierAgent` to run it.
A failed LLM review contributes no findings, while static findings remain.

## Functions

### reportFeedback

```ts
reportFeedback(report: TypeCheckReport): Feedback[]
```

Convert a typecheck report into findings: one error item per error,
  one advisory item per warning.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| report | [TypeCheckReport](../../agency.md#typecheckreport) |  |

**Returns:** `Feedback[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/review.agency#L132))

### buildTools

```ts
buildTools(): any[]
```

Return the Agency reviewer's documentation and web lookup tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/review.agency#L147))

### agencyReviewAgent

```ts
agencyReviewAgent(
  source: string,
  task: string = "",
  context: string = "",
  maxCost: number = $10.00,
  maxTime: number = 10m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
  dir: string = "",
  strict: boolean = false,
): Result<Feedback[]>
```

Check Agency source for parse and type errors, and review it against a task when given.
  A failed LLM review contributes no findings.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| source | `string` |  |  |
| task | `string` | "" | What the code should do, or "" for static checks only. |
| context | `string` | "" |  |
| maxCost | `number` | $10.00 | Cost budget in USD for the task review. |
| maxTime | `number` | 10m | Time budget in milliseconds for the task review. |
| model | `string` | "" | Model override, or "" for the ambient model. |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |
| session | `string` | "" | Name a conversation to reuse across calls, or "" for an isolated thread. |
| extraTools | `any[]` | [] | Tools added to the LLM review. |
| dir | `string` | "" | Base directory for the source's relative imports. |
| strict | `boolean` | false | True uses the name checks applied during sandboxed compilation. |

**Returns:** `Result<Feedback[]>`

**Throws:** `std::guard`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/review.agency#L211))
