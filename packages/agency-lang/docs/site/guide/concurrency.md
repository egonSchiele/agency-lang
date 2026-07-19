---
name: Concurrency
description: Covers Agency's concurrency primitives including `parallel`, `seq`, `fork`, and `race` for running multiple branches of work simultaneously.
---

# Concurrency

Agency offers a few concurrency primitives.

## `fork`
`fork` allows you to run multiple branches in parallel and collect all their results. It's like `map`, but each thread runs concurrently:

```ts
node main() {
  const countries = ["India", "USA", "Germany"]
  const capitals = fork(countries) as country {
    return llm(`What is the capital of ${country}?`)
  }
}
```

## `race`

`race` is similar to `fork`, but instead of waiting for all the branches to finish, it returns as soon as one thread finishes and cancels the other branches.

```ts
node main() {
  const prompt = "Write me a 100 word story about a talking dog."
  const models = ["gpt-4o-mini", "gpt-3.5-turbo", "gemini-3.1-pro-preview"]
  const story = race(models) as model {
    const _story = llm(prompt, { model: model })
    return { model: model, story: _story }    
  }

  printJSON(story)
}
```

## `parallel` and `seq`
To run multiple functions concurrently, call them all inside a `parallel` block.

```ts
parallel {
  functionA()
  functionB()
  functionC()
}
```

`parallel` is just syntactic sugar for `fork`. It's for the common use case of running multiple functions concurrently.

Note that `parallel` blocks are mostly limited to function calls. You can't run arbitrary code in there.

Inside of a parallel block, if there's some code you want to run sequentially, use a `seq` block.

```ts
parallel {
  functionA()
  seq {
    functionB()
    functionC()
  }
}
```

In this example:
- `functionA` runs concurrently with the `seq` block.
- `functionB` runs before `functionC`.

You can write normal Agency code in `seq`. Unlike the `parallel` block, it doesn't have any restrictions. 

## State isolation across branches

Each branch in Agency gets isolated state. We will cover this more in the state isolation section. For now, you just need to know that if you have a global variable, each thread in `fork`, `race`, or `parallel` will get their copy of that global variable:

```ts
const globalVar = 0
fork([1, 2, 3]) as i {
  globalVar = globalVar + 1

  // Always prints 1
  print(globalVar)
}

// prints 0, not 3
print(globalVar)
```

Note that not only did the branches not share `globalVar` with each other, they didn't even share it with their parent. So all the different changes to that variable were lost after the fork.

### Opting into shared state

If you *do* want the branches to share state, set `shared: true`:

```ts
const globalVar = 0
fork([1, 2, 3], shared: true) as i {
  globalVar = globalVar + 1

  // Prints 1, 2, or 3 depending on which branch runs first
  print(globalVar)
}

// prints 3
print(globalVar)
```

The same option works on `race` and `parallel` too.

The comprehension forms spell this as a prefix:
[`forkShared [...]` and `raceShared [...]`](/guide/comprehensions). A `race` over
an empty list resolves to `null`.