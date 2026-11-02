---
name: "statelog"
description: "Record agent inputs and outputs for evaluation, and inspect saved traces."
---

# statelog

Enable observability and configure a log file to save eval annotations.

  ```ts
  import { evalValue, evalOutput } from "std::statelog"

  node main(question: string) {
    evalValue(question)
    const answer: string = llm(question)
    evalOutput(answer)
  }
  ```

  Use `evalOutput` when the response you want graded differs from the
  entry node's return value. Read a saved run with `evalRecord`, or use
  `finalEvalOutput` when you only need its last output:

  ```ts
  import { finalEvalOutput } from "std::statelog"

  node main() {
    const output = finalEvalOutput("./statelog.jsonl")
    return output
  }
  ```

  `setAgentName` groups runs by agent. `turnStart` marks messages from a
  person for the logs viewer. `emit` sends custom data to the host's
  `onEmit` callback.

## Types

### StatelogEvalValue

An eval input or output with its thread and time in milliseconds since trace start.

```ts
/** An eval input or output with its thread and time in milliseconds since trace start. */
export type StatelogEvalValue = {
  value: any;
  threadId?: string;
  tMs: number;
  truncated?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L46))

### StatelogEvalRecord

A normalized view of one saved run for grading and analysis.

```ts
/** A normalized view of one saved run for grading and analysis. */
export type StatelogEvalRecord = {
  traceId: string;
  recordVersion: number;
  formatVersion: number;
  durationMs: number;
  startedAtMs: number;
  agentName?: string;
  source: string;
  evalValues: StatelogEvalValue[];
  evalOutputs: StatelogEvalValue[];
  threads: Record<string, any>[];
  events: Record<string, any>[];
  interrupts: Record<string, any>[];
  errors: Record<string, any>[];
  incomplete: Record<string, any>[];
  metrics: Record<string, any>;
  warnings: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L54))

## Functions

### emit

```ts
emit(data: any)
```

Emit a custom event to the calling TypeScript code.

Use with the host's `onEmit` callback to deliver progress or other application events.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| data | `any` |  | The payload the host's `onEmit` callback should receive. |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L74))

### setAgentName

```ts
setAgentName(name: string)
```

Set a stable display name for this agent, used to group its runs.

Call once near startup so the runs explorer and statelog's eval pages
  group this agent's runs under a stable name. The last call in a trace
  wins. Use slashes to group variants, such as "agency-agent/coordinator".

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  | Use 1–200 ASCII letters, digits, ".", "_", "-", or "/", with no empty, ".", or ".." path segments. |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L88))

### turnStart

```ts
turnStart(message: string)
```

Mark the start of a turn when a person sends this program a message.

Records a `turnStart` event. The logs viewer splits a session into turns
  at these events: each turn runs from its message to the next, and the
  time after a turn's last event is shown as waiting for the person. The
  `repl` function in `std::ui/cli` logs one for every line
  a person submits that is not a slash command, so a program that takes
  its messages another way (a seeded first prompt, a chat server) calls
  this itself.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| message | `string` |  | The message the person sent. |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L106))

### evalValue

```ts
evalValue(value: any)
```

Record an input to this agent for evaluation.

Mark the actual input at the point your agent receives it, so evaluators
  do not have to infer it from the conversation. Without an annotation,
  extraction uses the last user-role message in the first LLM completion
  on the top-level thread and adds a warning.

  Repeated calls contribute separate entries to `evalValues` in order.
  Values follow JSON serialization rules. Circular references, `bigint`,
  and top-level functions or symbols throw at the call site.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| value | `any` |  | A JSON-serializable value representing the input the user supplied. |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L125))

### evalOutput

```ts
evalOutput(value: any)
```

Record the agent's response for evaluation.

Use when the response to grade differs from the entry node's return
  value, or the node returns nothing. Explicit outputs replace the return
  value in the eval record. Without an annotation, extraction uses the
  entry node's non-null return value.

  Repeated calls contribute separate entries to `evalOutputs` in order.
  `finalEvalOutput` selects the last entry. Values follow the same JSON
  serialization rules as `evalValue`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| value | `any` |  | A JSON-serializable value representing the response the user receives. |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L144))

### evalRecord

```ts
evalRecord(
  statelogPath: string,
  allowedPaths: string[] = [],
): StatelogEvalRecord
```

Read a saved statelog trace for evaluation or analysis.

Inspect a previous run from Agency code without invoking the CLI.
  Returns the same record as `agency eval extract`, including eval values,
  outputs, conversation activity, metrics, and extraction warnings.
  The file must contain a single trace.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| statelogPath | `string` |  | A JSONL file containing one trace, relative to the working directory or absolute. |
| allowedPaths | `string[]` | [] | Restrict reads to these directories, or leave empty to allow any path. |

**Returns:** [StatelogEvalRecord](#statelogevalrecord)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L159))

### evalValues

```ts
evalValues(
  statelogPath: string,
  allowedPaths: string[] = [],
): StatelogEvalValue[]
```

Read the evaluation inputs from a saved statelog trace.

Read the inputs used for evaluation without the full run record.
  Includes inferred input when the agent did not call `evalValue`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| statelogPath | `string` |  | A JSONL file containing one trace, relative to the working directory or absolute. |
| allowedPaths | `string[]` | [] | Restrict reads to these directories, or leave empty to allow any path. |

**Returns:** `StatelogEvalValue[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L173))

### evalOutputs

```ts
evalOutputs(
  statelogPath: string,
  allowedPaths: string[] = [],
): StatelogEvalValue[]
```

Read the evaluation outputs from a saved statelog trace.

Read all outputs used for evaluation, preserving their order.
  Uses explicit `evalOutput` annotations when present, otherwise the entry
  node's non-null return value. Returns an empty array when neither exists.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| statelogPath | `string` |  | A JSONL file containing one trace, relative to the working directory or absolute. |
| allowedPaths | `string[]` | [] | Restrict reads to these directories, or leave empty to allow any path. |

**Returns:** `StatelogEvalValue[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L188))

### finalEvalOutput

```ts
finalEvalOutput(
  statelogPath: string,
  allowedPaths: string[] = [],
): StatelogEvalValue | null
```

Read the last evaluation output from a saved statelog trace, or null if none exists.

Select the last entry from `evalOutputs` for a judge that needs one answer.
  The result includes the value's thread and time, as well as its payload.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| statelogPath | `string` |  | A JSONL file containing one trace, relative to the working directory or absolute. |
| allowedPaths | `string[]` | [] | Restrict reads to these directories, or leave empty to allow any path. |

**Returns:** `StatelogEvalValue | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L202))
