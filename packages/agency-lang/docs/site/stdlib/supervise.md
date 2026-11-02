---
name: "supervise"
description: "Check and steer long-running work at regular intervals."
---

# supervise

```ts
import { supervise, SuperviseDecision } from "std::supervise"

def checkProgress(elapsed: number, draft: any): SuperviseDecision {
  printJSON(draft)
  return { action: "continue", message: "" }
}

node main() {
  return supervise(every: 5m, maxTime: 30m, check: checkProgress) {
    return llm("Investigate the task", { tools: [saveDraft] })
  }
}
```

The callback can continue, redirect with a message, or stop. Redirection
steers a paused LLM loop. Continue and stop work for any block.
Stopping can return work the block preserved with `saveDraft`.

Use supervision in one execution path. Concurrent sibling fork branches
can assign the same guard label and answer each other's checks.

## Types

### SuperviseDecision

The check's decision. `message` supplies redirect text or a stop reason;
continue ignores it.

```ts
/**
The check's decision. `message` supplies redirect text or a stop reason;
continue ignores it.
*/
export type SuperviseDecision = {
  action: "continue" | "redirect" | "stop";
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/supervise.agency#L31))

## Functions

### supervise

```ts
supervise(
  every: number,
  maxTime: number,
  check: (elapsed: number, draft: any) -> SuperviseDecision,
  block: () -> any,
): Result
```

Run a block and periodically check whether to continue, redirect, or stop.
  Do not call supervise concurrently in sibling fork branches.

The check receives elapsed working time and the latest saved draft, or null.
Use the draft to assess progress. A stopped block can return a saved partial
result under the usual guard salvage rules.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| every | `number` |  | Working-time interval in milliseconds between checks. |
| maxTime | `number` |  | Total working-time budget in milliseconds, at least `every`. |
| check | `(elapsed: number, draft: any) => SuperviseDecision` |  | Callback receiving elapsed time and the latest saved draft. |
| block | `() => any` |  |  |

**Returns:** `Result`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/supervise.agency#L45))
