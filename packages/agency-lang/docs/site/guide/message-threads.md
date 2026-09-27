---
name: Message threads
description: Share or isolate message history with threads and subthreads, and use lastReply to read reply text, thinking, probabilities, usage, and cost.
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

## `lastReply`: read a reply's metadata

```ts
import { lastReply, Reply } from "std::thread"

node main() {
  const answer: string = llm("Why does ice float on water?")
  print(answer)

  const reply: Reply | null = lastReply()
  if (reply == null) {
    return
  }
  if (reply.usage != null) {
    print(reply.usage.inputTokens)
    print(reply.usage.outputTokens)
  }
  if (reply.cost != null) {
    print(reply.cost)
  }
  for (block in reply.thinkingBlocks) {
    print(block.text)
  }
}
```

`llm()` returns the answer. `lastReply()` reads the most recent assistant message on the active thread, including metadata the model attached to it. It makes no model request and does not change the conversation. Call it inside a node or function, immediately after the `llm()` call whose reply you want to inspect.

The return type is `Reply | null`. It is `null` when the active thread has no assistant message. Otherwise, the record has these fields:

| Field | What it contains | When absent |
| --- | --- | --- |
| `content` | The assistant message's text. For structured output, this can be serialized JSON; use the `llm()` return value for the parsed result. | Empty string |
| `thinkingBlocks` | Provider-supplied thinking blocks, each with `text` and an opaque `signature`. | Empty array |
| `logprobs` | Generated tokens with their log probabilities and any requested alternatives. | Empty array |
| `usage` | This reply's `inputTokens` and `outputTokens`. | `null` |
| `cost` | This reply's total cost estimate, when available. | `null` |
| `answers` | A decision model's answers and probabilities, indexed by question name. | `null` |
| `rawData` | The original provider-specific data. Its shape depends on the provider. | `null` |

Missing cost data is different from a reported cost of zero. The usage and cost fields describe the selected assistant message; they do not total earlier replies or all the requests in a tool loop. Use [`getCost()` and `getTokens()`](#getcost-gettokens) for accumulated usage.

Thinking blocks appear only when the provider supplies them. Reading `lastReply()` does not enable thinking or logprobs. Request token probabilities with the `llm()` option `logprobs: { top: 2 }` on a supported model. Each logprob entry has `token`, `logprob`, and a `top` array of alternatives. See [token logprobs](/guide/decision-models#token-logprobs-from-a-text-model) for a complete example.

For a decision call, `answers.answer` holds the result of a single boolean or string-literal-union question. An object annotation uses its field names instead, such as `answers.department`. Check the answer's `type` before reading fields such as `noul` or `probabilities`. The [decision-model guide](/guide/decision-models#read-the-probabilities) shows how to use these values.

### Read it on the right thread

```ts
import { lastReply, Reply } from "std::thread"

def ask(prompt: string): Reply | null {
  const answer: string = llm(prompt)
  return lastReply()
}

node main() {
  parallel {
    const first: Reply | null = ask("Explain why ice floats in one sentence.")
    const second: Reply | null = ask("Explain why the sky is blue in one sentence.")
  }
  if (first != null) {
    print(first.usage)
  }
  if (second != null) {
    print(second.usage)
  }
}
```

Each parallel branch reads its own reply and returns the record to the caller. Calling `lastReply()` after the `parallel` block would read the parent thread's last assistant message, which may be older or absent.

A fresh `thread` starts without a reply. A `subthread` inherits its parent's messages, so it can initially see an inherited reply. After leaving either block, the parent thread becomes active again. Read and save the child reply inside the block if you need it afterward.

Adding a user or system message does not hide the last assistant message. A message added with `assistantMessage()` does count as a reply, even though it did not come from a model and normally has no model metadata.

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
