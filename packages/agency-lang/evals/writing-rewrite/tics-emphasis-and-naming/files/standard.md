A quick word on how this standard is organized: first the example, then the rule, then the checks.

Here is a call capped with a guard:

    const result = guard(label: "summary", time: 500ms) {
      return summarize(doc)
    }

`guard` puts a fence around the block and hands back a Result: the block's value on success, a failure when the budget trips. ONLY per-call guards count. NEVER accept one guard around the whole loop. No shared budgets, no outer guards, no exceptions.

The "one document, one fence" principle is what we are checking for. Make sure that:
1. each summarize call sits inside its OWN guard with `time: 500ms`.
2. a failure becomes the string "timed out" in that document's place.

Both points count equally.
