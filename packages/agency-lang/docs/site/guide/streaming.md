---
name: Streaming
description: Explains how to stream responses from the model in an LLM call, using the `stream` option and `onStream` callback.
---

# Streaming

To stream your response back, you need to do two things:
1. Set `stream: true` in your LLM call.

```ts
const response = llm("What is the capital of France?", { stream: true })
```

2. Provide an `onStream` callback function to handle the streamed data.

You can provide callbacks in Agency code or TypeScript code. Here is an example in Agency code.

```ts
node main() {
  callback("onStream") as data {
    printJSON(data)
  }
  const response = llm("What is the capital of India?", stream: true)
}
```

Read more about callbacks [here](/guide/callbacks).