---
name: "budgets"
description: "The time conversion for the coordinator's subagent tools: the"
---

# budgets

model passes a deadline in seconds, and the stdlib agents take
  milliseconds.

## Functions

### timeBudget

```ts
timeBudget(maxSeconds: number | null, fallback: number): number
```

Milliseconds for the stdlib agent's `maxTime`: the model's seconds, or
  the wrapper's default when it gave none.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| maxSeconds | `number \| null` |  |
| fallback | `number` |  |

**Returns:** `number`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/budgets.agency#L9))
