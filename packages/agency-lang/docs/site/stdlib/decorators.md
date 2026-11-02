---
name: "decorators"
description: "Apply cost and time budgets to whole functions."
---

# decorators

```ts
import { guarded } from "std::decorators"

@guarded(cost: $1.00, time: 5m)
def summarize(text: string): Result<string> {
  return llm("Summarize: ${text}", { tools: [saveDraft] })
}
```

`guarded` limits a function call and returns its saved draft if the budget
runs out. To write your own decorator, see [Decorators](/guide/decorators).

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

Run the decorated function under cost and working-time budgets.
  Return its saved draft when a budget runs out, or a failure if none exists.

  @param cost - Spend cap in dollars, or null for no cap.
  @param time - Working-time cap in milliseconds, or null for no cap.
  @param label - Guard label, defaulting to the function name.
  @param keepDraft - Return a failure on every budget trip when false, with any draft in the failure data.

Use `saveDraft` or `finalize` to preserve work if the budget runs out.
A saved string returns with a note that it may be unfinished. Without a
saved value, a budget trip returns a failure naming the limit.
Set `keepDraft: false` when a partial answer must count as a failure;
the failure's data still includes the draft.

A completed empty string returns a failure saying there was no answer.
The decorator rejects its own budget trip, so callers must pass larger
limits to allow more work. See `docs/dev/agents/subagent-budgets.md`.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/decorators.agency#L28))
