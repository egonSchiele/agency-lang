# Callbacks

Agency exposes a number of hooks. It's possible to write callbacks for these hooks in Agency files or pass them in when you run the node through TypeScript. Here are both options.

## Callbacks in Agency files

```ts
callback onNodeStart(data) {
  print(`Node ${node.id} started.`)
}
```

## Callbacks in TypeScript

```ts
import { main } from "agency"
const callbacks = {
  onNodeStart: (data) => {
    console.log(`Node ${data.node.id} started.`)
  }
}

const result = main(param1, param2, { callbacks })
```

## List of hooks
Here are all the hooks that Agency provides.

### onAgentStart
Called when an agent (graph) starts executing.

- `nodeName`: the name of the entry node
- `args`: the arguments passed to the agent
- `messages`: the initial message history
- `cancel(reason?)`: call this to cancel the agent before it runs

### onAgentEnd
Called when an agent finishes executing.

- `nodeName`: the name of the entry node
- `result`: the result of running the agent

### onNodeStart
Called when a graph node begins executing.

- `nodeName`: the name of the node

### onNodeEnd
Called when a graph node finishes executing.

- `nodeName`: the name of the node
- `data`: the data returned by the node

### onLLMCallStart
Called before an LLM call is made. You can return a `MessageJSON[]` array to override the messages sent to the LLM.

- `prompt`: the prompt string
- `tools`: the tools available to the LLM, each with `name`, `description`, and `schema`
- `model`: the model being used
- `messages`: the messages that will be sent

### onLLMCallEnd
Called after an LLM call completes. You can return a `MessageJSON[]` array to override the messages stored in the thread.

- `model`: the model that was used
- `result`: the full prompt result from the LLM
- `usage`: token usage statistics (if available)
- `cost`: estimated cost (if available)
- `timeTaken`: how long the call took in milliseconds
- `messages`: the messages that were sent

### onFunctionStart
Called when a function (tool) begins executing.

- `functionName`: the name of the function
- `args`: the arguments passed to the function
- `isBuiltin`: whether this is a built-in function
- `moduleId`: the module the function belongs to

### onFunctionEnd
Called when a function (tool) finishes executing.

- `functionName`: the name of the function
- `timeTaken`: how long the function took in milliseconds

### onToolCallStart
Called when the LLM invokes a tool call.

- `toolName`: the name of the tool being called
- `args`: the arguments passed to the tool

### onToolCallEnd
Called when a tool call finishes.

- `toolName`: the name of the tool
- `result`: the result returned by the tool
- `timeTaken`: how long the tool call took in milliseconds

### onStream
Called during streaming LLM responses. The data is a tagged union with one of these types:

- `{ type: "text", text }` — a chunk of streamed text
- `{ type: "tool_call", toolCall }` — a streamed tool call
- `{ type: "done", result }` — streaming is complete
- `{ type: "error", error }` — an error occurred during streaming

### onCheckpoint
Called when a rewind checkpoint is created. Receives the checkpoint data.