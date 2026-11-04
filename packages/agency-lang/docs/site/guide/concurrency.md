---
name: Concurrency
description: Covers Agency's concurrency primitives including `parallel`, `seq`, `async`, `fork`, and `race` for running multiple branches of work simultaneously.
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

## `async`

`async f()` runs `f` beside the statements that follow it in the same block. The block waits for `f` at the first use of its value, or at the end of the block.

```ts
node turn(msg: string) {
  let title = async nameConversation(msg)
  const reply = llm(msg)
  print(reply)
  saveTitle(title)
}
```

Here `nameConversation` runs while the model writes the reply. `saveTitle(title)` is the first statement that uses `title`, so the function waits for `nameConversation` just before it. If `nameConversation` finishes first, nothing waits.

There is no `await`. The value is ready when you read it.

### The two forms

```ts
let title = async nameConversation(msg)   // run beside, and keep the value
async extractMemories(msg)                // run beside, and drop the value
```

`async` goes on a call, at the start of a statement or on the right-hand side of a `let` or `const`. It cannot go inside a larger expression, such as an argument or a condition. A `with` suffix works as it does on any call:

```ts
let title = async nameConversation(msg) with approve
```

### Where the function waits

For `let x = async f()`, the function waits just before the first statement after it that mentions `x`. A mention anywhere in the statement counts, including inside an `if`, a loop, a `match`, or a block argument, and including an assignment to `x`. If nothing mentions `x`, the function waits at the end of the block.

For `async f()` with no variable, the function waits at the end of the block.

"The block" is the body the `async` statement sits in: a function or node body, an `if` branch, a loop body, a `handle` body, or a `seq` arm. In a loop body, each iteration waits at the end of its body, so the calls of two iterations never overlap.

A `goto`, `break`, or `continue` cannot run beside the call. When one of them is the next statement at the top level of the block, the function waits just before it:

```ts
for (item in items) {
  async log(item)
  if (done(item)) {
    print("stopping")
  }
  continue    // the function waits for log() just before this line
}
```

One nested deeper, inside an `if` before the wait, is a compile error. Start the `async` call after it, or use the value before it.

Two `async` calls in one block all run together. The second call and the statements after it run beside the first call:

```ts
let title = async nameConversation(msg)
let facts = async extractMemories(msg)
const reply = llm(msg)
saveTitle(title)
saveFacts(facts)
```

`nameConversation`, `extractMemories`, and the reply all run at the same time.

### What happens

1. The function waits for the call. A slow call delays the rest of the function by the difference. The call never outlives the function.
2. An early `return` waits for the call too. If a turn can stop early, start its `async` calls after the early exits.
3. The arguments are read when the `async` line runs, the same as for a plain call. In `async f(llm(prompt))`, that `llm()` call happens first, before anything runs beside it.
4. An interrupt in either the call or the rest of the block works as it does in a `fork`. The first interrupt is shown only once the other side has stopped running or is waiting on its own interrupt. Interrupts from both sides are answered together, and the program resumes where each one paused.
5. A handler inside the call answers only the call's interrupts. A handler around the whole block answers both sides.
6. The rest of the block keeps the conversation thread: an `llm()` call there adds its messages to the conversation. The call's own `llm()` calls start from a copy of the conversation so far, and their messages stay off it. Use `thread { }` inside the call for a blank conversation.
7. Global variables are shared between the call and the rest of the block, as they are between a plain call and the code after it.
8. A pause requested from outside while the call is running takes effect after the function stops waiting. The debugger's `set` command is refused until then.
9. If the call is a TypeScript function that throws, the function returns a failure with the error, and an interrupt waiting on the other side is dropped.
10. A `restore()` to a checkpoint taken inside the block, or before the `async` line, runs the call again.
11. Under a decision-model provider, the two sides' model calls are batched into shared requests.

## State isolation across branches

Each branch in Agency gets isolated state for global variables. We will cover this more in the state isolation section. For now, you just need to know that if you have a global variable, each thread in `fork`, `race`, or `parallel` will get their copy of that global variable:

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

You can also use [list comprehensions](/guide/comprehensions) with `fork` and `race`.