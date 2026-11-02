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

  @param task - The intended reader and what the text must communicate.
  @param guidelines - Writing guidelines that override conflicting built-in review rules.
  @param passes - Maximum review-and-rewrite rounds, stopping early when a review has no findings.
  @param maxCost - Cost budget in USD for all rounds together.
  @param maxTime - Time budget in milliseconds for all rounds together.
  @param model - Model override, or "" for the ambient model.
  @param provider - Provider for the model override, ignored when model is empty.

Start with one pass and increase `passes` when another review of the
rewritten text is useful. The rewrite call receives the review findings
and the original task and guidelines.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| task | `string` | "" |
| guidelines | `string` | "" |
| context | `string` | "" |
| passes | `number` | 1 |
| maxCost | `number` | $5.00 |
| maxTime | `number` | 10m |
| model | `string` | "" |
| provider | `string` | "" |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/rewrite.agency#L80))
