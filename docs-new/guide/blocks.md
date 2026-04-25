# Blocks
Although Agency doesn't have lambdas the way JavaScript does, it has a similar feature called blocks. You can use this to define functions that take another function. For example, let's use Agency's built-in `map` function, which takes a block:

```ts
  const names: string[] = ["Alice", "Bob", "Charlie"]
  const greetings = map(names) as name {
    return "Hi, ${name}!"
  }
  print(greetings)
```

Let's write our own `mapWithIndex` function. Just like `map`, but it also returns an index.

```ts
def mapWithIndex(arr: any[], block: (any, number) => any): any[] {
  const result = []
  let i = 0
  for (item in arr) {
    result.push(block(item, i))
    i += 1
  }
  return result
}
```

Now use it:

```ts
  const names: string[] = ["Alice", "Bob", "Charlie"]
  const greetings = mapWithIndex(names) as (name, index) {
    return "Hi, ${name}! You are index ${index} in the list."
  }
  print(greetings)
```

## Inline blocks

For simple one-liner blocks, you can use the inline block syntax. Instead of writing the block after the function call, you write it as an argument using `\`:

```typescript
  const names: string[] = ["Alice", "Bob", "Charlie"]
  const greetings = map(names, \name -> "Hi, ${name}!")
  print(greetings)
```

For multiple parameters, wrap them in parentheses:

```typescript
  const greetings = mapWithIndex(names, \(name, index) -> "${index}: ${name}")
```

For no parameters:

```typescript
  const results = twice(\ -> "hello")
```

Inline blocks are expression-only — the expression is implicitly returned. For multi-line blocks with multiple statements, use the trailing `as` syntax shown above.

## Blocks and interrupts

Blocks work correctly with [interrupts](./interrupts). If a block throws an interrupt (or calls a function that throws one), Agency can serialize the execution state, and when the user responds, resume from the exact point the block left off. Blocks can also close over variables from their enclosing scope, and this works correctly across interrupts too.

However, there is one limitation. If a function receives a block parameter and copies it to a local variable, and then calls it from a later step, the block will not resume correctly after an interrupt. For example:

```ts
def foo(block: () => any) {
  let saved = block       // copies block to a local variable
  doSomething()           // some other work
  let result = saved()    // calls the copy — if this interrupts, resume will break
}
```

The issue is that when Agency resumes from an interrupt, it replays execution from the beginning of each function, skipping past already-completed steps. The step that copied `block` to `saved` already completed, so it's skipped. The deserialized `saved` has lost its connection to the enclosing scope.

This works fine if the block doesn't throw an interrupt, since no serialization/deserialization happens. It also works fine if you use the block parameter directly instead of copying it:

```ts
def foo(block: () => any) {
  doSomething()
  let result = block()    // uses the parameter directly — this is fine
}
```

The reason the parameter works is that on resume, the calling function re-executes (since its step didn't complete), re-creates the block inline, and passes the fresh block as an argument — overwriting the deserialized value.