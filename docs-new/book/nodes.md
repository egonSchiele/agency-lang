# Nodes
A node defines an entry point into your agent. Here is an agent with two nodes. This means that if you use this agent from TypeScript code, you can import either of these nodes and use it as a function.

```ts
const prompt = `Please categorize this user message. If the message is about remembering something, return 'reminder'. If the message is about a to-do, return 'todo'.`

type Category = "reminder" | "todo";

node categorize(message: string) {
  const category: Category = llm(`${prompt}. Here's the user message: '${message}'`)
  return category
}

node main() {
  const userMessage = "Remind me to buy milk tomorrow"
  return categorize(userMessage)
}
```

There are a couple important benefits to this. This means that you can break up your agent, sort of like a state machine, and start at a state that makes sense for you. It also means that nodes behave a little differently than functions.

When a function call finishes, it returns back to the caller. But when you go to a new node, that marks a permanent transition. In this code snippet, the `main` node is calling the `categorize` node, which means that `categorize` is now the active node. Once it's finished, the program ends, unless it redirects to another node. `categorize` won't return back to the `main` node once it is done.

For this reason, whenever you call a node, you have to `return` the call. So it's not `categorize(userMessage)`, it's `return categorize(userMessage)` -- to make it clear that execution isn't returning back to this node.

## The `main` node

The `main` node is slightly special because it acts like Python's `if __name__ == __main__` syntax. If you execute an Agency file directly, its `main` node is what will get executed. The `main` node doesn't auto execute if you import this file somewhere, just if you execute that file directly.