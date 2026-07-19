---
name: "supervise"
description: "Runs a block, pausing it at a fixed interval to check progress and"
---

# supervise

steer: continue, redirect with a message, or stop.

  supervise owns pause-and-check so no agent has to. Compose it around any
  long-running block:

    supervise(every: 5m, maxTime: 30m, check: myCheck) {
      return codingAgent(task, maxTime: 30m)
    }

  The check callback decides at each pause. "redirect" injects its message
  into the paused LLM loop, so it only steers blocks that are LLM loops.
  "continue" and "stop" work for any block. A stopped block is aborted, and
  work it saved with saveDraft is salvaged into the returned Result.

  A supervised block must not read a Result with `match`: a match expression
  inside a block that pauses and resumes evaluates to null. Use
  `if (isFailure(r))` and `r.value` instead. See
  tests/agency/supervise/nestedGuardResume.agency.

## Types

### SuperviseDecision

What a supervise check decides: continue silently, redirect with a
  course-correction message, or stop the block. `message` carries the
  redirect text or the stop reason, and is ignored for "continue".

```ts
/** What a supervise check decides: continue silently, redirect with a
  course-correction message, or stop the block. `message` carries the
  redirect text or the stop reason, and is ignored for "continue". */
export type SuperviseDecision = {
  action: "continue" | "redirect" | "stop";
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/supervise.agency#L26))

## Functions

### supervise

```ts
supervise(
  every: number,
  maxTime: number,
  check: (elapsed: number) -> SuperviseDecision,
  block: () -> any,
): Result<any>
```

Run a block, pausing it every interval to check progress and steer it.

  @param every - How often to pause and check
  @param maxTime - Total time budget across all intervals
  @param check - Called at each pause with elapsed time, and decides whether to continue, redirect, or stop
  @param block - The long-running work

**Parameters:**

| Name | Type | Default |
|---|---|---|
| every | `number` |  |
| maxTime | `number` |  |
| check | `(elapsed: number) => SuperviseDecision` |  |
| block | `() => any` |  |

**Returns:** `Result<any>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/supervise.agency#L31))
