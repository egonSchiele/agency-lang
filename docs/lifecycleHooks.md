# Lifecycle Hooks

Agency provides lifecycle hooks that let you observe and react to key events during agent execution. Hooks are passed via the `callbacks` object alongside `onStream`.

## Available Hooks

| Hook | Fires when | Data passed |
|------|-----------|-------------|
| `onAgentStart` | Agent function is called | `{ nodeName, args, messages }` |
| `onAgentEnd` | Agent function returns | `{ nodeName, result }` |
| `onNodeStart` | A graph node begins executing | `{ nodeName }` |
| `onNodeEnd` | A graph node finishes executing | `{ nodeName, data }` |
| `onLLMCallStart` | Before an LLM call is made | `{ prompt, tools, model }` |
| `onLLMCallEnd` | After an LLM response is received | `{ result, usage, cost, timeTaken }` |
| `onToolCallStart` | Before a tool function is invoked | `{ toolName, args }` |
| `onToolCallEnd` | After a tool function returns | `{ toolName, result, timeTaken }` |
| `onStream` | Streaming chunks *(see Streaming)* | `StreamChunk` |

## Usage

Hooks are passed in the `callbacks` object when calling an agent from TypeScript:

```ts
const callbacks = {
  onAgentStart: ({ nodeName, args }) => {
    console.log(`Agent ${nodeName} started with args:`, args);
  },
  onNodeStart: ({ nodeName }) => {
    console.log(`Entering node: ${nodeName}`);
  },
  onNodeEnd: ({ nodeName, data }) => {
    console.log(`Exiting node: ${nodeName}`, data);
  },
  onLLMCallStart: ({ prompt, model }) => {
    console.log(`LLM call to ${model}`);
  },
  onLLMCallEnd: ({ usage, cost, timeTaken }) => {
    console.log(`LLM responded in ${timeTaken}ms, tokens: ${usage?.totalTokens}`);
  },
  onToolCallStart: ({ toolName, args }) => {
    console.log(`Calling tool: ${toolName}`, args);
  },
  onToolCallEnd: ({ toolName, result, timeTaken }) => {
    console.log(`Tool ${toolName} returned in ${timeTaken}ms`);
  },
  onAgentEnd: ({ nodeName, result }) => {
    console.log(`Agent ${nodeName} finished`);
  },
};

const result = await myAgent({ callbacks });
```

All hooks are async-compatible — if your callback returns a promise, it will be awaited before execution continues. Hooks are observational only (they cannot modify execution flow). Any hook that is not provided is a no-op.

Hooks also work with interrupt functions:

```ts
await approveInterrupt(response, { callbacks });
await rejectInterrupt(response, { callbacks });
```
