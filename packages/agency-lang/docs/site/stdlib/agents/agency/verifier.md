---
name: "verifier"
description: "Run an Agency program and judge its result against a task."
---

# verifier

The verifier checks the returned value and can inspect files the program
created. A program that cannot run produces an error finding.
Use `agencyReviewAgent` to check source without executing it.

A stopped run may return saved partial findings. A failed judgment returns
no findings, so an empty list alone does not prove the program passed.

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the Agency verifier's file inspection and command execution tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/verifier.agency#L31))

### agencyVerifierAgent

```ts
agencyVerifierAgent(
  source: string,
  task: string,
  maxCost: number = $20.00,
  maxTime: number = 15m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
): Result<Feedback[]>
```

Run an Agency program and judge its result against a task.
  Run failures become error findings, and a failed judgment returns no findings.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| source | `string` |  |  |
| task | `string` |  |  |
| maxCost | `number` | $20.00 | Cost budget in USD. |
| maxTime | `number` | 15m | Time budget in milliseconds. |
| model | `string` | "" | Model override for the judgment, or "" for the ambient model. |
| provider | `string` | "" | Provider for the judgment model, ignored when model is empty. |
| session | `string` | "" | Name a judgment conversation to reuse, or "" for an isolated thread. |
| extraTools | `any[]` | [] | Additional tools for judging the program's result. |

**Returns:** `Result<Feedback[]>`

**Throws:** `std::guard`, `std::run`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/agency/verifier.agency#L94))
