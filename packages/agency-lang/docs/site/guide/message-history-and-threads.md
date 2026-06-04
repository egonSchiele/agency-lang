---
title: Message history and threads
name: Message history and threads
description: Explains how Agency's default shared message history works across LLM calls, and how `thread` and subthread blocks let you create isolated conversations that don't pollute the main history.
---

# Message history and threads

A critical part of an agent is the message history. You want the agent to remember everything that's been said so far. Let's see how message history works in Agency.

By default, all LLM calls share a message history:

```ts
const result1 = llm("Hi my name is Alice. What is your name?")
const result2 = llm("Do you remember my name?")
print(result1)
print(result2)
```

Prints:

```
Hello Alice! I'm an AI assistant and I don't have a personal name, but you can call me Assistant. How can I help you today?
Yes, I remember your name is Alice! How can I assist you today?
```

This message history gets shared across function calls and across nodes, which makes it very easy to build an agent that remembers everything that has been talked about so far. Sometimes, though, you want to have a side conversation that doesn't pollute the main message history. You can use threads and subthreads for this.

`thread` creates an isolated conversation. The thread block starts a new empty conversation, and all the LLM calls within the thread block share message history, but it doesn't touch the main conversation.

```ts
  const result1 = llm("Hi my name is Alice. What is your name?")
  thread {
    const result2 = llm("Do you remember my name?")
  }
  print(result1)
  print(result2)
```

Prints:

```
Hello Alice! I'm an AI assistant, and I don't have a personal name, but you can call me Assistant. How can I help you today?
I don’t have the ability to remember personal details or past interactions, including your name. However, I’m here to help you with any questions or tasks you have! How can I assist you today?
```

This is a good way to have a side conversation without filling up the context in the main conversation. If you want to create a side conversation but still wanted to inherit all the messages in the current conversation, use a `subthread` instead:

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

Prints:

```
Hello Alice! I'm an AI assistant and I don't have a personal name, but you can call me Assistant. How can I help you today?
Yes, I remember your name is Alice! How can I assist you today?
Chocolate sorbet sounds delicious! A great choice for chocolate lovers. Do you have any favorite toppings to go with it?
I don't have access to personal data, so I can't know your favorite ice cream flavor. However, if you tell me what it is, I’d love to hear about it!
```

You can also nest threads and subthreads to create side conversations branching off other side conversations.

## Where threads work

Message threads are scoped to a running agent. They work anywhere inside a `node` or `def` body, and inside callback bodies (`handle`, `pipe`, etc.) that fire while a node is running.

They do **not** work in these "bootstrap" scopes:

- Module top-level code (e.g. a `const x = ...` declaration outside any node/function). This runs once at module load — there is no agent yet, so there is no message thread to attach to.
- The body of a `callback(...)` registration at the top of a module.
- The `onAgentStart` lifecycle hook. This fires before the agent runs.

If you call a thread builtin from one of these scopes — `systemMessage`, `userMessage`, `llm`, `thread { ... }`, `subthread { ... }` — you'll get a runtime error like *"Message threads are not available in this scope."* with a pointer to this guide. Move the code inside a `node` or `def` body to fix it.

`onAgentEnd` is the exception: it fires *after* the run completes, so it has access to the final conversation. You can inspect or log the thread state from there.

## See also

- [Cross-Thread Context Sharing](./cross-thread-context) — `listThreads()`, `getThread()`, and the `thread(label, summarize, continue, session)` named arguments for inspecting and resuming sibling threads. The marquee use case is the categorize-and-route pattern (one router, many specialized agents, per-category thread continuity).