# Lifecycle Hooks

Agency provides lifecycle hooks that let you observe and react to key events during agent execution. Hooks are passed via the `callbacks` object when calling an agent function.

All hooks are fully typed via the `AgencyCallbacks` type exported from `agency-lang/runtime`.

## Available Hooks

| Hook | Fires when | Data passed |
|------|-----------|-------------|
| `onAgentStart` | Agent function is called | `{ nodeName, args, messages }` |
| `onAgentEnd` | Agent function returns | `{ nodeName, result }` |
| `onNodeStart` | A graph node begins executing | `{ nodeName }` |
| `onNodeEnd` | A graph node finishes executing | `{ nodeName, data }` |
| `onFunctionStart` | A `def` function begins executing | `{ functionName, args, isBuiltin }` |
| `onFunctionEnd` | A `def` function finishes executing | `{ functionName, timeTaken }` |
| `onLLMCallStart` | Before an LLM call is made | `{ prompt, tools, model, messages }` |
| `onLLMCallEnd` | After an LLM response is received | `{ model, result, usage, cost, timeTaken, messages }` |
| `onToolCallStart` | Before a tool function is invoked | `{ toolName, args }` |
| `onToolCallEnd` | After a tool function returns | `{ toolName, result, timeTaken }` |
| `onStream` | Streaming chunks *(see Streaming)* | `StreamChunk` |

## Usage

Hooks are passed in the `callbacks` object when calling an agent from TypeScript:

```ts
import type { AgencyCallbacks } from "agency-lang/runtime";

const callbacks: AgencyCallbacks = {
  onAgentStart: ({ nodeName, args }) => {
    console.log(`Agent ${nodeName} started with args:`, args);
  },
  onNodeStart: ({ nodeName }) => {
    console.log(`Entering node: ${nodeName}`);
  },
  onNodeEnd: ({ nodeName, data }) => {
    console.log(`Exiting node: ${nodeName}`, data);
  },
  onFunctionStart: ({ functionName, args, isBuiltin }) => {
    console.log(`Calling function: ${functionName}`, args);
  },
  onFunctionEnd: ({ functionName, timeTaken }) => {
    console.log(`Function ${functionName} finished in ${timeTaken}ms`);
  },
  onLLMCallStart: ({ prompt, model, messages }) => {
    console.log(`LLM call to ${model}, ${messages.length} messages`);
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

All hooks are async-compatible — if your callback returns a promise, it will be awaited before execution continues. Any hook that is not provided is a no-op.

Hooks also work with interrupt functions:

```ts
await approveInterrupt(response, { callbacks });
await rejectInterrupt(response, { callbacks });
```

## Modifying Messages in LLM Hooks

The `onLLMCallStart` and `onLLMCallEnd` hooks receive the current `messages` array (as serialized `MessageJSON[]`) and can optionally return a new messages array to replace it.

### Modifying messages before the LLM call

Return a new array from `onLLMCallStart` to change what gets sent to the model:

```ts
const callbacks: AgencyCallbacks = {
  onLLMCallStart: ({ messages, prompt, model }) => {
    // Add a system message before every LLM call
    return [
      { role: "system", content: "Always respond in JSON." },
      ...messages,
    ];
  },
};
```

### Modifying messages after the LLM response

Return a new array from `onLLMCallEnd` to change the conversation history going forward:

```ts
const callbacks: AgencyCallbacks = {
  onLLMCallEnd: ({ messages, result }) => {
    // Remove the first message (e.g. a one-shot system prompt)
    return messages.slice(1);
  },
};
```

If the callback does not return a value (or returns `undefined`), the messages are left unchanged. You can also mutate the `messages` array in-place; since it is passed by reference, changes will be reflected without needing to return a new array.

## Hook Data Reference

### `onAgentStart`

Fires when an exported node function is called via `runNode`.

| Field | Type | Description |
|-------|------|-------------|
| `nodeName` | `string` | Name of the agent node |
| `args` | `Record<string, any>` | Arguments passed to the agent |
| `messages` | `MessageJSON[]` | Initial message history |

### `onAgentEnd`

Fires when the agent finishes executing.

| Field | Type | Description |
|-------|------|-------------|
| `nodeName` | `string` | Name of the agent node |
| `result` | `RunNodeResult<any>` | Result including `data`, `messages`, and `tokens` |

### `onNodeStart`

Fires when a graph node begins executing.

| Field | Type | Description |
|-------|------|-------------|
| `nodeName` | `string` | Name of the graph node |

### `onNodeEnd`

Fires when a graph node finishes executing.

| Field | Type | Description |
|-------|------|-------------|
| `nodeName` | `string` | Name of the graph node |
| `data` | `any` | The node's return value |

### `onFunctionStart`

Fires when a `def` function begins executing.

| Field | Type | Description |
|-------|------|-------------|
| `functionName` | `string` | Name of the function |
| `args` | `Record<string, any>` | Arguments passed to the function |
| `isBuiltin` | `boolean` | Whether this is a built-in function |

### `onFunctionEnd`

Fires when a `def` function finishes executing.

| Field | Type | Description |
|-------|------|-------------|
| `functionName` | `string` | Name of the function |
| `timeTaken` | `number` | Execution time in milliseconds |

### `onLLMCallStart`

Fires before an LLM call is made. Can return a `MessageJSON[]` to replace the messages sent to the model.

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | `string` | The user prompt |
| `tools` | `{ name, description?, schema }[]` | Tools available to the model |
| `model` | `ModelName \| ModelConfig \| undefined` | Model being called |
| `messages` | `MessageJSON[]` | Current message history |

### `onLLMCallEnd`

Fires after an LLM response is received. Can return a `MessageJSON[]` to replace the message history going forward.

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string \| ModelConfig` | Model that responded |
| `result` | `PromptResult` | The full completion result |
| `usage` | `TokenUsage \| undefined` | Token usage statistics |
| `cost` | `CostEstimate \| undefined` | Cost estimate |
| `timeTaken` | `number` | Round-trip time in milliseconds |
| `messages` | `MessageJSON[]` | Message history including the response |

### `onToolCallStart`

Fires before a tool function is invoked during a prompt loop.

| Field | Type | Description |
|-------|------|-------------|
| `toolName` | `string` | Name of the tool |
| `args` | `any[]` | Arguments passed to the tool |

### `onToolCallEnd`

Fires after a tool function returns.

| Field | Type | Description |
|-------|------|-------------|
| `toolName` | `string` | Name of the tool |
| `result` | `any` | Value returned by the tool |
| `timeTaken` | `number` | Execution time in milliseconds |

### `onStream`

Fires for each streaming chunk when `stream` is enabled. Called directly (not through `callHook`).

| Variant | Fields | Description |
|---------|--------|-------------|
| `text` | `{ type: "text", text: string }` | A text chunk from the model |
| `tool_call` | `{ type: "tool_call", toolCall: ToolCallJSON }` | A tool call from the model |
| `done` | `{ type: "done", result: PromptResult }` | Stream complete |
| `error` | `{ type: "error", error: any }` | Stream error |
