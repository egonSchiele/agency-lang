---
name: List comprehensions
description: Build a new list from an existing one in a single expression, either sequentially or concurrently.
---

# List comprehensions

A list comprehension builds a new array from an existing collection, in one
expression:

```ts
const doubled = [x * 2 for x in numbers]
```

That is the same as writing a loop that appends to an array, but shorter and
without a mutable variable to get wrong.

## Filtering

Add an `if` clause to keep only some items:

```ts
const bigNames = [name for name in names if name.length > 5]
```

## Running the items concurrently

Put `fork` in front and every item runs at the same time:

```ts
const summaries = fork [llm("Summarize: ${doc}") for doc in docs]
```

Use this when the body is slow, which for an agent usually means it makes an
LLM call. Ten documents take about as long as one, instead of ten times as
long. Results come back in the order of the original list, no matter which
item finishes first.

The two forms differ in one important way beyond speed. `fork` gives each item
its own copy of your global variables, and throws those copies away when the
work joins back up. So a body that changes a global will not have that change
survive:

```ts
let count = 0

// count is still 0 afterwards - each branch changed its own copy
const results = fork [tally(x) for x in xs]
```

If you need the changes to stick, use the plain form, or read
[concurrency](/guide/concurrency) for `shared: true`.

The `if` clause runs before the work fans out, so the filter itself is not
concurrent. Only the body is.

## Binders

The part after `for` works exactly like the one in a
[`for` loop](/guide/basic-syntax#loops).

A second binder gives you the index when you are iterating an array:

```ts
const labeled = ["${i}: ${name}" for name, i in names]
// ["0: Alice", "1: Bob"]
```

For an object, the second binder is the value at that key instead:

```ts
const config = { host: "localhost", port: "8080" }
const lines = ["${k}=${v}" for k, v in config]
// ["host=localhost", "port=8080"]
```

The indices are positions in the collection you started with, not in the
result. So filtering does not renumber them:

```ts
const xs = ["a", "b", "c", "d"]
const kept = ["${i}:${x}" for x, i in xs if x != "b"]
// ["0:a", "2:c", "3:d"] - note the missing 1
```

You can also pull apart each item as you go:

```ts
const greetings = ["Hi ${name}" for {name, age} in people]
const firsts = [a for [a, b] in pairs]
```

## Things to know

A long comprehension can be broken across lines:

```ts
const summaries = fork [summarize(doc)
  for doc in docs
  if doc.length > 0]
```

If it is getting long, though, that is usually a sign the body wants to be a
named function.

Anything that is not a list or an object gives you an empty result rather than
an error, which matches how `for` loops behave. That includes strings, so
`[c for c in "abc"]` gives you `[]`, not a list of characters.

## When to use a block instead

The body of a comprehension is a single expression. When you need several
statements, use the block form, which does the same job:

```ts
const reports = map(topics) as topic {
  const notes = research(topic)
  return summarize(notes)
}
```

`fork(topics) as topic { ... }` is the concurrent equivalent.

## References

- [Concurrency](/guide/concurrency) - `fork`, `race`, and shared state
- [Blocks](/guide/blocks) - the multi-statement form
- [std::index](/stdlib/) - `map`, `filter`, `reduce`, and friends
