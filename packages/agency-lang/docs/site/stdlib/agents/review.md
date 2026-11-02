---
name: "review"
description: "Review a work product against a task and return findings."
---

# review

Pass the work as text. The agent can consult web sources and read GitHub
pull requests and issues. Use `verifierAgent` to run checks on work on disk,
or `agencyReviewAgent` to include Agency parse and typecheck findings.

By default, a review that could not run returns no findings, and a review
the time or cost budget cut short returns the findings it saved. Pass
`failOpen: false` when either outcome must be reported as a failure. The
saved findings are then in the failure's data as `draft`.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the reviewer's web and GitHub lookup tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/review.agency#L37))

### reviewAgent

```ts
reviewAgent(
  work: string,
  task: string = "",
  context: string = "",
  maxCost: number = $10.00,
  maxTime: number = 10m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
  failOpen: boolean = true,
): Result<Feedback[]>
```

Review a work product against a task and return satisfied points and problems.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| work | `string` |  | The work product as text. |
| task | `string` | "" |  |
| context | `string` | "" |  |
| maxCost | `number` | $10.00 | Cost budget in USD. |
| maxTime | `number` | 10m | Time budget in milliseconds. |
| model | `string` | "" | Model override, or "" for the ambient model. |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |
| session | `string` | "" | Name a conversation to reuse across calls, or "" for an isolated thread. |
| extraTools | `any[]` | [] | Tools added to the built-in lookup tools. |
| failOpen | `boolean` | true | False makes failed or partial reviews return failures instead of empty or partial findings. |

**Returns:** `Result<Feedback[]>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/review.agency#L77))
