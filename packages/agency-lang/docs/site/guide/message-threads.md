---
name: Message threads
description: Explains how Agency's default shared message history works across LLM calls, and how `thread` and subthread blocks let you create isolated conversations that don't pollute the main history.
---

# Message history and threads

By default, all LLM calls share a message history:

```ts
const result1 = llm("Hi my name is Alice. What is your name?")
const result2 = llm("Do you remember my name?")
print(result1)
print(result2)
```

Prints something like:

```
Hello Alice! I'm an AI assistant and I don't have a personal name, but you can call me Assistant. How can I help you today?
Yes, I remember your name is Alice! How can I assist you today?
```

This message history gets shared across function calls and across nodes.

## `thread` and `subthread`

Sometimes you want to have a side conversation that doesn't pollute the main message history. You can use threads and subthreads for this.

`thread` creates an isolated conversation. The thread block starts a new empty conversation. All the LLM calls within the thread block share message history, but they don't touch the main conversation.

```ts
  const result1 = llm("Hi my name is Alice. What is your name?")
  thread {
    const result2 = llm("Do you remember my name?")
  }
  print(result1)
  print(result2)
```

Prints something like:

```
Hello Alice! I'm an AI assistant, and I don't have a personal name, but you can call me Assistant. How can I help you today?
I don’t have the ability to remember personal details or past interactions, including your name. However, I’m here to help you with any questions or tasks you have! How can I assist you today?
```

If you want to create a side conversation but want to inherit the message history thus far, use a `subthread` instead:

```ts
  const result1 = llm("Hi my name is Alice. What is your name?")
  subthread {
    const result2 = llm("Do you remember my name?")
    const result3 = llm("Just fyi my favorite ice cream flavor is chocolate sorbet.")
  }
  const result4 = llm("What is my favorite ice cream flavor?")
  print(result1)
  print(result2)
  print(result3)
  print(result4)
```

Prints something like:

```
Hello Alice! I'm an AI assistant and I don't have a personal name, but you can call me Assistant. How can I help you today?
Yes, I remember your name is Alice! How can I assist you today?
Chocolate sorbet sounds delicious! A great choice for chocolate lovers. Do you have any favorite toppings to go with it?
I don't have access to personal data, so I can't know your favorite ice cream flavor. However, if you tell me what it is, I’d love to hear about it!
```

You can also nest threads and subthreads to create side conversations branching off other side conversations.

Message threads work everywhere except module top-level code.

## `systemMessage`, `userMessage`

When you make LLM calls, the `llm` function adds user messages and assistant messages to the message history automatically. But if you want to insert a message into the message history yourself, you can use functions from the [`std::thread` module](/stdlib/thread):

```ts
import { systemMessage, userMessage } from "std::thread"

node main() {
  systemMessage("You are a helpful assistant.")
  userMessage("Hi my name is Alice.")
  const result = llm("Do you remember my name?")
  print(result)
}
```

These functions only work inside nodes or functions. You can't use them in global scope.

## `getCost`, `getTokens`

Use these to get the current cost and token usage of the message history. 

```ts
import { getCost, getTokens } from "std::thread"

node main() {
  const result = llm("What's the capital of India?")
  print(result)
  print(getCost())
}
```

You can set limits on cost by using [guards](/guide/guards).

## References

- [Cross-Thread Context Sharing](./cross-thread-context) — lets threads peek at other threads.