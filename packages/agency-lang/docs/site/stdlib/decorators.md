---
name: "decorators"
description: "The decorators the standard library ships."
---

# decorators

The decorators the standard library ships. A decorator is a `decorator
def` written above another def as `@name(...)`; it receives the call and
the body as a block, and decides what to run. This module is where every
stdlib decorator lives, so there is one import line to look for:

```ts
import { guarded } from "std::decorators"
```

Today it holds `@guarded`, which runs a whole function under a cost and
time budget. To write your own, see [Decorators](/guide/decorators).

## Functions

### guarded

```ts
guarded(
  cost: number | null = null,
  time: number | null = null,
  label: string | null = null,
  keepDraft: boolean = true,
  call: Call,
  block: (args: object) -> any,
): Result raises <std::guard>
```

Run the decorated function under a cost and time budget, labelled with
  the function's name. If the budget runs out, the draft the function saved
  is the result, marked as possibly unfinished; with nothing saved, the
  result is a failure naming the budget.

  @param cost - Spend cap in dollars, or null for none
  @param time - Working-time cap, or null for none
  @param label - The guard's label; the function's name when null
  @param keepDraft - When false, a budget that runs out is always a failure naming the budget, with any saved draft in the failure's data as `draft`

The `@guarded` decorator: the `guard` block put around a whole function,
  with three rules added. If the body finishes, its result is the result
  (a finished `""` is a failure, "it returned no answer"). If the budget
  runs out, the best answer the body had is the result: what it saved with
  `saveDraft`, or handed up through a `finalize`, with a line appended to
  a string saying it may be unfinished. With nothing saved, the result is
  a failure naming the budget, "its time budget of 30m ran out".
  `keepDraft: false` makes every budget trip that failure, with the saved
  draft in its data, for a caller that must not take a partial result for
  a finished one.

  ```ts
  import { guarded } from "std::decorators"

  @guarded(cost: $1.00, time: 5m)
  def summarize(text: string): Result<string> {
    return llm("Summarize: ${text}", { tools: [saveDraft] })
  }
  ```

  The body runs with the arguments as passed (`block(call.args)`). Its draft
  reaches the guard the way any partial result does: by return position, or
  through a `finalize`. The decorator answers its own budget trip, so a
  caller cannot grant more budget; pass a larger limit instead. See
  docs/dev/agents/subagent-budgets.md.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| cost | `number \| null` | null |
| time | `number \| null` | null |
| label | `string \| null` | null |
| keepDraft | `boolean` | true |
| call | [Call](index.md#call) |  |
| block | `(args: Record<string, any>) => any` |  |

**Returns:** `Result`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/decorators.agency#L40))
