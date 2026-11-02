---
name: "rewrite"
description: "Review prose and return a rewrite with the findings applied."
---

# rewrite

`writingRewriteAgent` reviews the text, then rewrites it when the review
has findings. `passes` bounds the number of review-and-rewrite rounds.
A review without findings ends the loop, and a failed review fails the call.

```ts
import { writingRewriteAgent } from "std::agents/writing/rewrite"

node main() {
  print(writingRewriteAgent(text: "The report was written by Alice."))
}
```

## Functions

### writingRewriteAgent

```ts
@guarded(cost: maxCost, time: maxTime)
writingRewriteAgent(
  text: string,
  task: string = "",
  guidelines: string = "",
  context: string = "",
  passes: number = 1,
  maxCost: number = $5.00,
  maxTime: number = 10m,
  model: string = "",
  provider: string = "",
): Result<string>
```

Review prose and return a rewrite with the findings applied.
  Return unchanged text when the review has no findings.

Start with one pass and increase `passes` when another review of the
rewritten text is useful. On the eval suite, two passes scored 0.795
against 0.769 for one pass. The rewrite call receives the review findings
and the original task and guidelines.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| text | `string` |  |  |
| task | `string` | "" | The intended reader and what the text must communicate. |
| guidelines | `string` | "" | Writing guidelines that override conflicting built-in review rules. |
| context | `string` | "" |  |
| passes | `number` | 1 | Maximum review-and-rewrite rounds, stopping early when a review has no findings. |
| maxCost | `number` | $5.00 | Cost budget in USD for all rounds together. |
| maxTime | `number` | 10m | Time budget in milliseconds for all rounds together. |
| model | `string` | "" | Model override, or "" for the ambient model. |
| provider | `string` | "" | Provider for the model override, ignored when model is empty. |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/rewrite.agency#L82))
