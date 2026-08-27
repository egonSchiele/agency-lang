Here is a call capped with a guard:

    const result = guard(label: "summary", time: 500ms) {
      return summarize(doc)
    }

`guard` limits the time of the block and returns a Result: the block's value on success, a failure when the budget trips. The budget is per call.

Make sure that:
1. each summarize call is inside its own `guard` with `time: 500ms`, not one guard around the whole loop.
2. a failure becomes the string "timed out" in that document's place.

Both points count equally.
