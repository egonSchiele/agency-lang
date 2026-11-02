---
name: "verifier"
description: "Check completed work on disk against measurable task criteria."
---

# verifier

The verifier derives criteria, uses tools to check the work, and returns
`Feedback` findings. You can supply known criteria as well. It has shell
execution tools, so the caller's handlers decide which commands may run.
Use `reviewAgent` to judge text without running it.

A stopped run may return saved partial findings. A failed verification
returns no findings, so an empty list alone does not prove the work passed.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the verifier's file inspection, command execution, and Agency check tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/verifier.agency#L32))

### verifierAgent

```ts
verifierAgent(
  task: string,
  criteria: string[] = [],
  maxCost: number = $20.00,
  maxTime: number = 15m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
): Result<Feedback[]>
```

Check work on disk against task criteria with tools and return findings.
  A failed verification returns no findings.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| task | `string` |  |  |
| criteria | `string[]` | [] | Known criteria to check alongside those derived from the task. |
| maxCost | `number` | $20.00 | Cost budget in USD. |
| maxTime | `number` | 15m | Time budget in milliseconds. |
| model | `string` | "" | Model override, or "" for the ambient model. |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |
| session | `string` | "" | Name a conversation to reuse across calls, or "" for an isolated thread. |
| extraTools | `any[]` | [] | Tools available to criteria generation and verification. |

**Returns:** `Result<Feedback[]>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/verifier.agency#L79))
