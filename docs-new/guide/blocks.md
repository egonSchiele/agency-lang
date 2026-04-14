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