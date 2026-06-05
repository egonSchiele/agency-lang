---
name: Concurrency
description: Covers Agency's concurrency primitives including `parallel`, `seq`, `fork`, and `race` for running multiple branches of work simultaneously.
---

# Concurrency

Agency offers a few concurrency primitives.

## `parallel` and `seq`
To run multiple functions concurrently, call them all inside a `parallel` block.

```ts
parallel {
  functionA()
  functionB()
  functionC()
}
```

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

You can write normal Agency code in `seq`. Unlike the `parallel` block, it doesn't have any restrictions. 

When might you want to use `seq`? When one of the function calls depends on the value of another function call:

```ts
parallel {
  functionA()
  seq {
    const resultA = functionA()
    functionB(resultA)
  }
}
```

## `fork`
`fork` allows you to run multiple threads in parallel and collect all their results. It's like `map`, but each thread runs concurrently. Here is an example program to help find a gift for someone on Etsy.

```ts
node main() {
  const giftIdea = input("Tell me about a person you want to get a gift for: ")
  const prompt = `This person is looking for a gift for a special someone. Based on the gift recipient's description and interests, please suggest some keyword searches on Etsy for finding them a gift. The gift recipient is: ${giftIdea}`
  const searches: string[] = llm(prompt)
  const results = fork(searches) as search {
    print("Searching for ${search}...")
  }
  print("Here are some gift ideas based on your description:")
  print(results)
}
```

The way it works is:

1. Asks for details about the gift recipient
2. Uses an LLM to generate keyword searches
3. Runs each keyword search in parallel and collects the results.

You can also nest `fork`s inside other `fork`s. This can be a powerful way to run multiple LLM calls in parallel to explore a problem space and pick which direction you want to go in.

## `race`

`race` is similar to `fork`, but instead of waiting for all the threads to finish, it returns as soon as one thread finishes and cancels the other threads.

```ts
node main() {
  const prompt = "Write me a 100 word story about a talking dog."
  const models = ["gpt-4o-mini", "gpt-3.5-turbo", "gemini-3.1-flash-lite-preview"]
  const story = race(models) as model {
    const _story = llm(prompt, { model: model })
    return { model: model, story: _story }    
  }

  printJSON(story)
}
```

## State isolation across branches

Just like each agent **run** gets its own copy of globals and its own message-thread state (see [execution model](./execution-model)), each **branch** of a `parallel`, `fork`, or `race` block gets its own copy too. Branches start with a snapshot of the parent's globals at the moment the fork runs, and any writes a branch makes never leak back to the parent.

This matters because the moment you write something like:

```ts
parallel {
  researchAgentA()
  researchAgentB()
}
```

…you'd reasonably worry: "what if both agents internally use the same global variable to track their work? Won't they corrupt each other's state?" They won't. Each branch gets its own snapshot. The same goes for the active message thread — each branch's unguarded `llm()` calls write to a branch-local subthread, not the parent's conversation.

### The fork-loop pitfall

Users coming from JavaScript will reach for "shared global accumulator" and be surprised when their writes vanish:

```ts
let count = 0
for (i in [0, 1, 2]) {
  fork([1]) as _ {
    count = count + 1   // writes to the branch's local copy
  }
}
print(count)   // prints 0 — branch writes were discarded
```

The idiomatic replacement is "return the contribution and reduce":

```ts
const contributions = fork([0, 1, 2]) as i { return 1 }
const count = sum(contributions)   // 3
```

### Opting into shared state

Sometimes you really do want multiple branches to cooperate on the same global state — a shared todo list, a progress meter, a dedup cache. For that, pass `shared: true`:

```ts
parallel(shared: true) {
  workerA()        // sees and mutates the parent's globals
  workerB()        // sees and mutates the parent's globals
  workerC()        // sees and mutates the parent's globals
}
```

The same option works on `fork` and `race`:

```ts
fork(items, shared: true) as item { ... }
race(items, shared: true) as item { ... }
```

When `shared: true` is set, branches pointer-share the parent's globals: writes inside a branch are immediately visible to siblings and to the parent after join. Use this when you actively *want* the cross-branch coordination; leave it off (the default) when you're parallelizing for independence.

**Note:** the message-thread active pointer is **always** branch-local regardless of `shared`. Concurrent branches pushing/popping the same active thread would corrupt the conversation. If you need branches to write into a shared thread, use [named sessions or `thread(continue: id)`](./cross-thread-context) — those keep working under both modes because the thread *registry* is always shared.

## Concurrent interrupts

If you have multiple threads running in parallel, it's possible that they will all throw interrupts at the same time. Agency supports this and will just return an array of interrupts to the user. The user can then respond to each interrupt one by one. See the section on [interrupts](./interrupts) for more details on how interrupts work and how to respond to them.