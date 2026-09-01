---
name: "rewrite"
description: "Rewrite prose from the writing reviewer's findings and return the new text."
---

# rewrite

The writing reviewer (`std::agents/writing/review`) returns a list of
  findings. That suits a caller that wants to apply them itself. A caller
  that wants the finished text instead calls this agent: it runs the
  reviewer, hands the findings and the text to one rewriting call, and
  returns the rewritten text. With `passes` above 1 the rewritten text is
  reviewed and rewritten again, up to that many times; a review with no
  findings ends the loop early.

## Functions

### writingRewriteAgent

```ts
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
  extraTools: any[] = [],
): Result<string>
```

Review prose and return it rewritten with the findings applied. If
  the reviewer finds nothing wrong with the text, send it back unchanged.

  @param text - The text to rewrite
  @param task - Who the text is for and what it must get across, or ""
  @param guidelines - The caller's own writing guidelines, as text, or ""
    for the reviewer's built-in catalog alone
  @param context - Extra material for the judgment, or ""
  @param passes - How many review-and-rewrite rounds to run at most. Each
    round reviews the current text and rewrites it; a round whose review
    finds nothing ends the loop.
  @param maxCost - Hard spend cap for all rounds together
  @param maxTime - Hard wall-clock cap for all rounds together
  @param model - Model override, or "" for the ambient model
  @param provider - Provider for the model override
  @param extraTools - Extra tools to offer the LLM, appended to the built-in set

* Rewrites a piece of text according to the findings of a writing review.
 *
 * Quick note on the `passes` parameter: a single pass is usually enough.
 * Running the eval suite comparing one pass to two passes,
 * the accuracy went from 0.769 -> 0.795.
 *
 * Usage example:
 *
 * ```ts
 * const rewritten = writingRewriteAgent(
 *   text: "Original text",
 * )
 * ```

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
| extraTools | `any[]` | [] |

**Returns:** `Result<string>`

**Throws:** `std::guard`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/writing/rewrite.agency#L86))
