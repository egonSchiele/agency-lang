---
name: "planner"
description: "Generate and run an Agency program that composes agents for a task."
---

# planner

`plannerAgent` drafts a plan, generates source, and requests approval with
the plan, source, and detected effects before running it. It checks the
result with `verifierAgent` and can regenerate the program after findings.
A source-generation failure invokes `codingAgent` directly.

Use `codingAgent` for a task that does not need a generated orchestration
program. An optional `plan` skips the initial planning call.

## Effects

### std::agents::planApprove

Approve a generated program after inspecting its plan, source, and detected effects.

```ts
/** Approve a generated program after inspecting its plan, source, and detected effects. */
effect std::agents::planApprove {
  plan: string;
  source: string;
  effects: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/planner.agency#L36))

## Functions

### buildTools

```ts
buildTools(): any[]
```

Return the planner's project lookup, skill, and communication tools.

**Returns:** `any[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/planner.agency#L28))

### planCodePrompt

```ts
planCodePrompt(task: string, planText: string): string
```

Build an instruction to generate an Agency program for a task and plan.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| planText | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/planner.agency#L75))

### renderEffects

```ts
renderEffects(effects: Result<EffectsByExport>): string
```

Render detected interrupt effects for approval, or explain that analysis failed.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| effects | `Result<EffectsByExport>` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/planner.agency#L104))

### runApproved

```ts
runApproved(
  task: string,
  plan: string,
  src: string,
  state: PlanState,
): PlanState raises <std::agents::planApprove, std::guard, std::run>
```

Show a generated plan and source for approval, then run and verify it if approved.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| plan | `string` |  |
| src | `string` |  |
| state | `PlanState` |  |

**Returns:** `PlanState`

**Throws:** `std::agents::planApprove`, `std::run`, `std::guard`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/planner.agency#L197))

### plannerAgent

```ts
@guarded(cost: maxCost, time: maxTime)
plannerAgent(
  task: string,
  context: string = "",
  plan: string = "",
  maxCost: number = $100.00,
  maxTime: number = 60m,
  model: string = "",
  provider: string = "",
  session: string = "",
  extraTools: any[] = [],
): Result<string> raises <std::agents::planApprove, std::guard, std::run>
```

Generate an Agency program that composes agents to solve a complex task,
  request approval, run it, and check the result.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| task | `string` |  |  |
| context | `string` | "" |  |
| plan | `string` | "" | Seed plan that skips the planning call when nonempty. |
| maxCost | `number` | $100.00 | Cost budget in USD across the generated work. |
| maxTime | `number` | 60m | Time budget in milliseconds. |
| model | `string` | "" | Model override for the planning call only, or "" for the ambient model. |
| provider | `string` | "" | Provider for the planning model, ignored when model is empty. |
| session | `string` | "" | Named conversation for the planning call, unused when a seed plan is given. |
| extraTools | `any[]` | [] | Tools added to the planning call only. |

**Returns:** `Result<string>`

**Throws:** `std::guard`, `std::agents::planApprove`, `std::run`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/planner.agency#L236))
