---
name: Nodes
description: Describes nodes — Agency's entry points into agents — and how they differ from functions, including the permanent transition behavior and the special role of the `main` node.
---

# Nodes
A node defines an entry point into your agent. There are two main ways the entry point can get used:
1. when you're running the agent as a script from the command line
2. when you're importing Agency code into TypeScript.

## The `main` node

The was our first example:

```ts
node main() {
  const greeting = llm("Say hello to the world!");
  print(greeting);
}
```
If you run Agency code on the command line, the `main` node is what gets run. Its like Python's `if __name__ == "__main__"` syntax. If you import the Agency file, either into another Agency file, or into TypeScript, the `main` node will not run automatically.

## Using nodes from TypeScript

Any nodes you define can be imported into TypeScript and called as functions. Check out the section on [TS interoperability](/guide/ts-interop) for more information.

## `goto`

You can go from one node to another in Agency code. You use the `goto` keyword for this. Here is a quick example.

```ts
node main() {
  const userMessage = input("What is your message? ");
  goto categorize(userMessage);
}

node categorize(userMessage: string) {
  const mood:"happy" | "sad" = llm(`Categorize this message: ${userMessage}`)
}
```

Note that if this was a function call, once the `categorize` function finished, it would return back to the `main` node. But a `goto` marks a permanent transition. Any code after the goto will not get called:

```ts
node main() {
  const userMessage = input("What is your message? ");
  goto categorize(userMessage);
  print("This will never get printed");
}
```