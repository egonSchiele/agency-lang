---
name: List comprehensions
description: Build a new list from an existing one in a single expression, either sequentially or concurrently.
---

# List comprehensions

Agency supports Python-style list comprehensions:

```ts
const doubled = [x * 2 for x in numbers]
```

## Filtering

Add an `if` clause to keep only some items:

```ts
const bigNames = [name for name in names if name.length > 5]
```

## Running the items concurrently

Prefix with `fork` to run each item concurrently:

```ts
const summaries = fork [llm("Summarize: ${doc}") for doc in docs]
```

Note that each branch will get isolated state for global variables. See the [state isolation](/guide/state-isolation#isolation-across-concurrent-branches) section for more details.

Example:

```ts
// global variable
let count = 0

node main() {
  const xs = range(10)
  // count is still 0 afterwards - each branch changed its own copy
  const results = fork [count += x for x in xs]
}
```

Each branch got its own copy of `count`. The state wasn't shared, and was thrown away when the branch finished.

### Shared state
If you want shared state, use `forkShared`:

```ts
// global variable
let count = 0

node main() {
  const xs = range(10)
  // count is now 45
  const results = forkShared [count += x for x in xs]
}
```

See the [concurrency](/guide/concurrency) and [state isolation](/guide/state-isolation#isolation-across-concurrent-branches) docs for more on shared state.

The `if` clause runs before the work fans out, so the filter itself is not concurrent.

## `race` and `raceShared`

Put `race` in front to get the first result back, and cancel the rest:

```ts
// whichever summary comes back first wins; the other branches are cancelled
const fastest = race [summarize(doc) for doc in docs]
```

Note that this returns a *single result*, not a list. `race` also gets isolated state. To share state, use `raceShared`.

## Binders

List comprehension with an index variable:

```ts
const labeled = ["${i}: ${name}" for name, i in names]
// ["0: Alice", "1: Bob"]
```

For an object, the list comprehension iterates over the key-value pairs:

```ts
const config = { host: "localhost", port: "8080" }
const lines = ["${k}=${v}" for k, v in config]
// ["host=localhost", "port=8080"]
```

Filtering does not renumber indices:

```ts
const xs = ["a", "b", "c", "d"]
const kept = ["${i}:${x}" for x, i in xs if x != "b"]
// ["0:a", "2:c", "3:d"] - note the missing 1
```

You can also destructure each item as you go:

```ts
const greetings = ["Hi ${name}" for {name, age} in people]
const firsts = [a for [a, b] in pairs]
```

## Calling methods on a comprehension

A comprehension is an expression, so you can call a method on it, index it,
or slice it directly - no need to assign it to a variable first:

```ts
const lines = ["- ${item}" for item in items].join("\n")
```

This works anywhere an expression is allowed, including inside string
interpolation:

```ts
const block = "<criteria>${["- ${c}" for c in allCriteria].join("\n")}</criteria>"
```

The same holds for plain array literals: `[1, 2, 3].join("-")` and
`[10, 20, 30][1]`.

## References

- [Concurrency](/guide/concurrency)
- [Blocks](/guide/blocks)