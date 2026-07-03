---
name: The `main` node
description: Explanation of the `main` node in Agency, the entry point of a program, and how it behaves when executing or importing files.
---

# The `main` node

The was our first example:

```ts
node main() {
  const greeting = llm("Say hello to the world!");
  print(greeting);
}
```

Every Agency script needs a `main` node. The `main` node is the entry point of the program. Its like Python's `if __name__ == "__main__"` syntax. If you execute an Agency file directly, its `main` node is what will get executed. The `main` node doesn't execute if you import this file somewhere, just if you execute that file directly.

We'll talk more about nodes later!

## References
- [Nodes](/guide/nodes)