---
name: Partial results
description: Keep the best-so-far value when a guard stops your work. Save drafts as you go with `saveDraft`, or compute a final partial with `finalize`.
---

# Partial results

You can set limits on time or cost using guards(/guide/guards). Suppose you ask a research agent to research five topics and use a guard to limit its time to 10 minutes. If the guard trips, all of the research will get thrown away. This is wasteful. If the agent researched 4/5 topics, you should be able to get that. Partial results let you save your work as you go, so if the code is aborted, you can still get something back.

There are two tools:

- `saveDraft` saves a value as your work improves.
- `finalize` computes a value at the moment the work stops.

## Saving as you go with saveDraft

Here is an example without saveDraft. This code has a timeout of one second, but it sleeps for two seconds.

```ts
node main() {
  const res = guard(time: 1s) {
    sleep(2s)
    return "finalResult"
  }
  print(res)
}
```

Running this returns a failure. Now lets use `saveDraft`:

```ts
node main() {
  const res = guard(time: 1s) {
    saveDraft("draft1")
    sleep(2s)
    return "finalResult"
  }
  print(res)
}
```

Now this returns a success with the value `"draft1"`. The guard tripped, but the last saved draft was returned instead of a failure.

For the earlier research example:

```ts
node main() {
  const result = guard(time: 10m) {
    let report = ""
    for (topic in topics) {
      report = report + research(topic)
      saveDraft(report)
    }
    return report
  }

  // If the code finished in time, `result` will have the full report.
  // Otherwise, it will still contain the report so far.
  if (isSuccess(result)) {
    print(result.value)
  }
}
```

The loop above is deliberate: `saveDraft` has to run after each topic, and a
comprehension body is a single expression. When you only want the results and
do not need to save progress between them, a
[comprehension](/guide/comprehensions) is shorter:

```ts
const reports = fork [research(topic) for topic in topics]
```

Things to note:

- The last saved value wins.
- The draft should match the return type of your function.
- You can't use `saveDraft` from the global scope.
- If your function raises an exception, that exception gets converted to a failure in Agency. In that case, we don't return the saved draft value, we return the failure, so that it doesn't get lost.

## Computing the partial with finalize

Sometimes the best partial result is not a value you saved along the way. It is something you compute from whatever you have at the moment the guard trips. A `finalize` block runs when the scope is aborted, and lets you salvage your work. Here is an example:

```ts
def research(topic: string): string {
  const outline = draftOutline(topic)
  const full = expand(outline)     // guard trips in here
  return full

  finalize {
    if (outline != null) {
      return "OUTLINE ONLY: " + outline
    }
    return "nothing yet"
  }
}
```

Things to note:

- A finalize only runs when the scope is aborted.
- Inside a finalize, you can access any variables in scope, but they might not have been assigned yet, so each var could be null.
- You can't raise an interrupt in `finalize`.
- You can only have one finalize per function or block, and the convention is to put it at the end of the function.
- In a function with a finalize, a `return` expression that contains a call must be just the call, like `return f(x)`. Anything more complex is a compile error. Assign to a local first.
- **When both exist, finalize wins**: if a scope has both a saved draft and a finalize, the finalize's return value is what gets returned.

## Partials in a call chain

Example code:

```ts
def add(a: number, b: number): number {
  saveDraft(a + b + 100)
  sleep(2s)
  return a + b
}

node main() {
  const res = guard(time: 1s) {
    saveDraft(1)
    const x = add(1, 2)
    return 2
    finalize {
      return x * 2
    }
  }
  print(res)
}
```

What's happening:
- we set a 1 second guard in `main`
- we save a draft of `1` in `main`
- we call `add`, which saves a draft of `103` and then sleeps for 2 seconds
- the guard trips while `add` is sleeping
- we return the saved draft of `103` from `add`, setting `x` to `103` in `main`
- the `finalize` block in `main` runs
- the `finalize` block returns `x * 2`, which is `206`.

Notice that the guard aborts multiple functions and thus triggers partial results from multiple levels.

If `main` didn't have a `finalize` or a saved draft, it would return a failure. It doesn't get to use `add`'s saved draft as its own.

## Partials in forks and races

Concurrent work follows the same rule, per branch:

- Inside a `fork`, each branch keeps its own draft value.
- A `race` loser is cancelled, not tripped, so its draft is discarded, and its finalize does not run.

## Partials in an interrupt payload

When a guard trips, it raises an interrupt. The interrupt's data includes `draftValue`:

```ts
handle {
  // some code
} with (i) {
  if (i.effect == "std::guard") {
    if (i.data.draftValue != null) {
      // Something useful exists. Stop here and keep it.
      return reject()
    }
    // Nothing salvageable yet. Buy more time.
    return approve({ maxTime: 60000 })
  }
  return pass()
}
```

## References

- [Guards](/guide/guards)