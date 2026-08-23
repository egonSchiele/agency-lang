---
name: "statelog"
description: "Record and read back eval data from the statelog, marking an agent's input and response for later analysis."
---

# statelog

Record and read back eval data from the statelog. Call `evalValue` and
  `evalOutput` inside an agent to mark its user-facing input and response,
  then read them from a saved trace with `evalValues`, `evalOutputs`,
  `finalEvalOutput`, or the full `evalRecord`. `emit` sends a custom event
  straight to the host.

  ```ts
  import { evalValue, evalOutput } from "std::statelog"

  node main(question: string) {
    evalValue(question)
    let answer: string = llm(question)
    evalOutput(answer)
  }
  ```

## Types

### StatelogEvalValue

```ts
export type StatelogEvalValue = {
  value: any;
  threadId?: string;
  tMs: number;
  truncated?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L30))

### StatelogEvalRecord

```ts
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L37))

## Functions

### emit

```ts
emit(data: any)
```

Emit a custom event to the calling TypeScript code.

  @param data - The event payload to emit.

Delivered to the host via the `onEmit` callback.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| data | `any` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L57))

### setAgentName

```ts
setAgentName(name: string)
```

Set a stable display name for this agent, used to group its runs.

  Names use letters, digits, ".", "_", "-" and "/" (to nest a family's
  variants, as in "agency-agent/coordinator"): no spaces, at most 200
  characters, and no empty, "." or ".." segment between slashes.

  @param name - The agent name, e.g. "gcode-v2".

* Names this agent in the statelog. Cross-run tools (the runs explorer,
 * statelog's eval pages) group runs under this identity instead of the
 * launch command. Call it once, early; the last call in a trace wins. The
 * name is also a URL path segment on statelog, so an invalid one throws
 * rather than producing a trace that cannot be grouped.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L86))

### evalValue

```ts
evalValue(value: any)
```

Record a value as part of the user-facing input to this agent. May be called multiple times per trace; all firings are collected in order.

  @param value - The value to record. Any JSON-serializable type is accepted.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L99))

### evalOutput

```ts
evalOutput(value: any)
```

Record a value as the agent's user-facing response. May be called multiple times per trace; all firings are collected in order.

  @param value - The value to record. Any JSON-serializable type is accepted.

* Records the value in the statelog as an `evalOutputRecorded` event, which
 * `agency eval extract` surfaces on the `evalOutputs[]` field. When no eval
 * annotation exists in a trace, `eval extract` falls back to a heuristic
 * (last LLM completion on the top-level thread) and emits a warning.
 * Annotating explicitly is preferred, since the heuristic does not account
 * for post-LLM processing the agent applies before showing a response. The
 * consuming eval / judge / task definition decides what to do with multiple
 * firings (e.g. a pairwise judge can use the last firing). Same
 * serialization rules as `evalValue`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L119))

### evalRecord

```ts
evalRecord(
  statelogPath: string,
  allowedPaths: string[] = [],
): StatelogEvalRecord
```

Parse a statelog JSONL file and return the same structured EvalRecord
  produced by `agency eval extract`. Use this when an agent needs to inspect
  a previous run without shelling out to the CLI.

  @param statelogPath - Path to the statelog JSONL file to parse
  @param allowedPaths - Optional allow-list of path prefixes. When provided,
    statelogPath must resolve under one of these prefixes.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| statelogPath | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** [StatelogEvalRecord](#statelogevalrecord)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L128))

### evalValues

```ts
evalValues(
  statelogPath: string,
  allowedPaths: string[] = [],
): StatelogEvalValue[]
```

Parse a statelog JSONL file and return the values recorded as eval values.

  @param statelogPath - Path to the statelog JSONL file to parse.
  @param allowedPaths - Optional allow-list of path prefixes; statelogPath must resolve under one.

Mirrors `new StatelogParser(path).evalValues()` in TypeScript.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| statelogPath | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** `StatelogEvalValue[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L142))

### evalOutputs

```ts
evalOutputs(
  statelogPath: string,
  allowedPaths: string[] = [],
): StatelogEvalValue[]
```

Parse a statelog JSONL file and return the values recorded as eval outputs.

  @param statelogPath - Path to the statelog JSONL file to parse.
  @param allowedPaths - Optional allow-list of path prefixes; statelogPath must resolve under one.

Mirrors `new StatelogParser(path).evalOutputs()` in TypeScript.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| statelogPath | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** `StatelogEvalValue[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L153))

### finalEvalOutput

```ts
finalEvalOutput(
  statelogPath: string,
  allowedPaths: string[] = [],
): StatelogEvalValue | null
```

Parse a statelog JSONL file and return the final eval output, or null when
  the trace has no output. This is the canonical judge-ready final-output
  selection rule.

  @param statelogPath - Path to the statelog JSONL file to parse
  @param allowedPaths - Optional allow-list of path prefixes

**Parameters:**

| Name | Type | Default |
|---|---|---|
| statelogPath | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** `StatelogEvalValue | null`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L163))
