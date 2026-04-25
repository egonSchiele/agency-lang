# Stage 4: Stdlib Functions

## Goal

Build utility functions for common LLM reliability strategies using `fork`, `race`, and block arguments. These are written in Agency code and shipped as part of the standard library. Users can read, modify, or write their own.

## Prerequisites

- Stage 2 (Block arguments) — functions can accept blocks
- Stage 3 (Fork primitive) — `fork` and `race` are available

## Functions

### `sample(n, block) -> any[]`

Run the same block N times in parallel. Returns all results.

```
def sample(n: number, block: () -> any): any[] {
  return fork (range(n)) as _ {
    return block()
  }
}
```

Usage:
```
let answers = sample(5) {
  let label: "positive" | "negative" | "neutral" = llm("Classify: ${text}")
  return label
}
// answers: ["positive", "positive", "neutral", "positive", "negative"]
```

### `consensus(n, block) -> any`

Run block N times, return the most common result. Majority vote.

```
def consensus(n: number, block: () -> any): any {
  let results = sample(n, block)
  return mostCommon(results)
}
```

Usage:
```
let label = consensus(5) {
  llm("Classify: ${text}")
}
// label: "positive" (appeared 3 out of 5 times)
```

### `bestOf(n, scorer, block) -> any`

Run block N times, return the result with the highest score.

```
def bestOf(n: number, scorer: (any) -> number, block: () -> any): any {
  let results = sample(n, block)
  return maxBy(results, scorer)
}
```

Usage:
```
let summary = bestOf(3, scoreSummary) {
  llm("Summarize: ${doc}")
}
```

### `retry(n, test, block) -> any`

Sequential retry. Run block up to N times, return first result that passes the test. No continuations needed — this is just a loop.

```
def retry(n: number, test: (any) -> boolean, block: () -> any): any {
  for i in range(n) {
    let result = block()
    if test(result) {
      return result
    }
  }
  return null
}
```

Usage:
```
let json = retry(3, isValidJSON) {
  llm("Extract JSON from: ${text}")
}
```

### `retryWithFeedback(n, test, block) -> any`

Sequential retry where each attempt receives the previous result and attempt number. Allows corrective feedback.

```
def retryWithFeedback(n: number, test: (any) -> boolean, block: (any, number) -> any): any {
  let prev = null
  for i in range(n) {
    let result = block(prev, i + 1)
    if test(result) {
      return result
    }
    prev = result
  }
  return prev
}
```

Usage:
```
let code = retryWithFeedback(3, typeChecks) as (prev, attempt) {
  if attempt == 1 {
    return llm("Write TypeScript for: ${spec}")
  } else {
    return llm("Fix this code: ${prev}. Errors: ${getErrors(prev)}")
  }
}
```

### `firstValid(variants, test, block) -> any`

Race multiple variants, return first result that passes a test.

```
def firstValid(variants: any[], test: (any) -> boolean, block: (any) -> any): any {
  let results = fork (variants) as v {
    return block(v)
  }
  for r in results {
    if test(r) {
      return r
    }
  }
  return null
}
```

Usage:
```
let result = firstValid([0.2, 0.5, 0.8], isValidJSON) as temp {
  llm("Extract JSON: ${text}") with { temperature: temp }
}
```

Note: This uses `fork` (wait for all) rather than `race` (first to complete) because it needs to check a condition. A true `race` version would be faster but can't guarantee the result passes the test. Both patterns are useful.

### Helper functions

These helper functions should also be in the stdlib:

```
// Return the most common element in an array
def mostCommon(items: any[]): any { ... }

// Return the element with the highest score
def maxBy(items: any[], scorer: (any) -> number): any { ... }

// Return the element with the lowest score
def minBy(items: any[], scorer: (any) -> number): any { ... }

// Generate a range [0, 1, ..., n-1]
def range(n: number): number[] { ... }
```

Some of these may already exist as builtins. Check before implementing.

## Testing Strategy

Each stdlib function needs:

### Unit tests (in co-located `.test.ts` files or `tests/agency/stdlib/`)
- Basic happy path
- Edge cases: N=0, N=1, empty inputs
- Block that returns different types
- Block that interrupts (for fork-based functions)

### Integration tests
- `sample` with mock LLM: verify N results returned
- `consensus`: verify most common result is returned
- `bestOf`: verify highest-scored result is returned
- `retry`: verify stops on first success, returns null after N failures
- `retryWithFeedback`: verify prev and attempt are passed correctly
- `firstValid`: verify first valid result is returned

### Compose tests
- `consensus` + `retry`: retry consensus until it's confident (> 80% agreement)
- `bestOf` + `retryWithFeedback`: get best of N, retry with feedback if none score well
- Nested forks via stdlib: `sample` inside `fork`

## Files to Create

| File | Contents |
|------|----------|
| `stdlib/sample.agency` | `sample` function |
| `stdlib/consensus.agency` | `consensus` function |
| `stdlib/bestOf.agency` | `bestOf` function |
| `stdlib/retry.agency` | `retry` and `retryWithFeedback` functions |
| `stdlib/firstValid.agency` | `firstValid` function |
| `stdlib/helpers.agency` | `mostCommon`, `maxBy`, `minBy`, `range` |
| `tests/agency/stdlib/` | End-to-end tests for each function |

## Notes

- These are regular Agency functions, not compiler primitives. Users can read and modify them.
- Users can write their own strategies using the same building blocks (`fork`, `race`, block arguments).
- The stdlib should be importable: `import { sample, consensus } from "agency/stdlib"` (or however Agency packages stdlib modules).
- Documentation for each function should be added to DOCS.md.
