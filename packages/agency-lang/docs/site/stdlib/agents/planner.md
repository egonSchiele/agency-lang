---
name: "planner"
description: "The plan-as-code meta-agent: given a task, generates an Agency program that composes worker agents and tools to solve it."
---

# planner

plannerAgent: the plan-as-code meta-agent. Given a task, generate an Agency
  program (an agent-as-plan) that composes the worker agents and tools to solve
  it, show the plan, source, and capability envelope for approval, run it in a
  handler-sandboxed subprocess, verify, and fall back to codingAgent on failure.

## Types

## Effects

### std::agents::planApprove

Raised before a generated plan-agent runs, so the plan, source, and
  capability envelope can be shown and approved. Reject halts and fails.

```ts
/** Raised before a generated plan-agent runs, so the plan, source, and
  capability envelope can be shown and approved. Reject halts and fails. */
effect std::agents::planApprove {
  plan: string;
  source: string;
  effects: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/planner.agency#L18))

## Functions

### planCodePrompt

```ts
planCodePrompt(task: string, planText: string): string
```

Build the code-generation instruction: emit a program whose `node main` composes
  the building blocks to carry out `planText` for `task`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| planText | `string` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/planner.agency#L49))

### renderEffects

```ts
renderEffects(effects: Result<EffectsByExport>): string
```

Human-readable capability envelope for the approval prompt, or an honest
  note when the effects could not be computed.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| effects | `Result<EffectsByExport>` |  |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/planner.agency#L77))

### runApproved

```ts
runApproved(
  task: string,
  plan: string,
  src: string,
  state: PlanState,
): PlanState raises <std::agents::planApprove>
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| plan | `string` |  |
| src | `string` |  |
| state | [PlanState](#planstate) |  |

**Returns:** [PlanState](#planstate)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/planner.agency#L164))

### plannerAgent

```ts
plannerAgent(
  task: string,
  context: string = "",
  plan: string = "",
  maxCost: number = $100.00,
  maxTime: number = 60m,
  model: string = "",
  provider: string = "",
): Result<string> raises <std::agents::planApprove, std::guard>
```

Plan-as-code: draft (or use a seed) plan, generate an agent that solves the
  task, show the plan/source/effects for approval, run it in a sandboxed
  subprocess, and verify. Falls back to codingAgent on generation failure or
  repeated verification gaps. Recursion (a generated agent calling plannerAgent)
  is bounded by the runtime's subprocess maxDepth and by maxCost/maxTime.

  @param task - what to accomplish.
  @param context - optional extra material.
  @param plan - optional seed plan; when non-empty the analysis step is skipped.
  @param maxCost - hard spend cap for the whole tree (default $100).
  @param maxTime - hard wall-clock cap (default 60 minutes).
  @param model - model override for the planning step only, or "" for the ambient model.
  @param provider - provider for the model override.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| task | `string` |  |
| context | `string` | "" |
| plan | `string` | "" |
| maxCost | `number` | $100.00 |
| maxTime | `number` | 60m |
| model | `string` | "" |
| provider | `string` | "" |

**Returns:** `Result<string>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/planner.agency#L195))
