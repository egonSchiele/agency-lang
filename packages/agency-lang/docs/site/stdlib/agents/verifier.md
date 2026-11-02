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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/verifier.agency#L27))

### verifierAgent

```ts
verifierAgent(
  task: string,
  criteria: string[] = [],
  context: string = "",
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

  @param criteria - Known criteria to check alongside those derived from the task.
  @param context - Reserved and currently unused.
  @param maxCost - Cost budget in USD.
  @param maxTime - Time budget in milliseconds.
  @param model - Model override, or "" for the ambient model.
  @param provider - Provider for the model override, ignored when model is empty.
  @param session - Name a conversation to reuse across calls, or "" for an isolated thread.
  @param extraTools - Tools available to criteria generation and verification.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| criteria | `string[]` | [] |
| context | `string` | "" |
| maxCost | `number` | $20.00 |
| maxTime | `number` | 15m |
| model | `string` | "" |
| provider | `string` | "" |
| session | `string` | "" |
| extraTools | `any[]` | [] |

**Returns:** `Result<Feedback[]>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/verifier.agency#L74))
