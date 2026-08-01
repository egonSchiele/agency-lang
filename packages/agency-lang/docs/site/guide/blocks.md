---
name: Blocks
description: Explains Agency's block syntax, used in place of lambdas for higher-order functions like `map`, including custom block-taking functions and inline block syntax.
---

# Blocks
Although Agency doesn't have lambdas the way JavaScript does, it has a similar feature called blocks. You can use this to define functions that take another function. For example, let's use Agency's built-in `map` function, which takes a block:

## Using blocks

### One parameter

```ts
  const names: string[] = ["Alice", "Bob", "Charlie"]

  const greetings = map(names) as name {
    return "Hi, ${name}!"
  }
```

You bind the parameter using `as`. 

### No parameters

With no params, you don't need `as`:

```ts
def callMe(block) {
  return block()
}

node main() {
  const foo = callMe() {
    return 5
  }

  // prints 5
  print(foo)
}
```

But you still need the parentheses after `callMe`. This won't parse:

```ts
const foo = callMe {
  return 5
}
```

### Multiple parameters

```ts
const names: string[] = ["Alice", "Bob", "Charlie"]

const greetings = mapWithIndex(names) as (name, index) {
  return "${index}: ${name}"
}
```

## Writing functions that take blocks

```ts
def callMe(block: (any) -> any) {
  return block()
}
```

## Inline blocks

For simple one-liner blocks, you can use the inline block syntax. Instead of writing the block after the function call, you write it as an argument using `\`:

```typescript
const names: string[] = ["Alice", "Bob", "Charlie"]
const greetings = map(names, \name -> "Hi, ${name}!")
```

For multiple parameters, wrap them in parentheses:

```typescript
const greetings = mapWithIndex(names, \(name, index) -> "${index}: ${name}")
```

For no parameters:

```typescript
const results = twice(\ -> "hello")
```

Inline blocks are single-line only, and the expression is implicitly returned.

## Limitations of blocks

### Don't assign the block to another variable

```ts
def foo(block: () => any) {
  let saved = block
  doSomething()
  let result = saved()
}
```

> [Side note] Why this happens: The issue is that when Agency resumes from an interrupt, it replays execution from the beginning of each function, skipping past already-completed steps. The step that copied `block` to `saved` already completed, so it's skipped. The deserialized `saved` has lost its connection to the enclosing scope. This works fine if the block doesn't throw an interrupt.

Just use the block parameter directly instead of copying it:

```ts
def foo(block: () => any) {
  doSomething()
  // uses the parameter directly — this is fine
  let result = block()
}
```

### Don't return the block from a function

```ts
def foo(block: () => any) {
  // don't do this
  return block
}
```

## Blocks and functions

You can use a function or a PFA anywhere you can pass in a block:

```ts
def add(a: number, b: number): number {
  return a + b
}

const result = map(range(10), add.partial(b: 5))
```