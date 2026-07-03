---
name: "statelog"
---

# statelog

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L10))

### StatelogEvalRecord

```ts
export type StatelogEvalRecord = {
  traceId: string;
  recordVersion: number;
  formatVersion: number;
  durationMs: number;
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L17))

## Functions

### emit

```ts
emit(data)
```

Emit a custom event to the calling TypeScript code via the onEmit callback.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| data |  |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L34))

### evalValue

```ts
evalValue(value: any)
```

Record an eval value — a value that should be considered part of
  the user-facing input to this agent. Captured in the statelog as
  an `evalValueRecorded` event and surfaced by `agency eval extract`
  on the `evalValues[]` field of the produced record.

  Call this once per discrete recorded value. May be called multiple
  times in a single trace; all firings are collected in order. The
  consuming eval / judge / input definition decides what to do with
  multiple firings.

  When no eval annotation exists in a trace, `eval extract` falls
  back to a heuristic (first user-role message of the first LLM
  call) and emits a warning. Annotating explicitly is preferred.

  @param value - The value to record. Any JSON-serializable type is
    accepted; stored as `unknown` in the eval record. Top-level
    `undefined` records as `null`; top-level functions and symbols
    throw a TypeError; nested functions, `undefined`, and symbols
    follow JSON serialization rules; circular references and `bigint`
    throw at the call site (with your stack), not later inside the
    log writer.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L41))

### evalOutput

```ts
evalOutput(value: any)
```

Record an eval output — a value that should be considered the
  agent's user-facing response. Captured in the statelog as an
  `evalOutputRecorded` event and surfaced by `agency eval extract`
  on the `evalOutputs[]` field of the produced record.

  Call this once per discrete user-facing response. May be called
  multiple times in a single trace; all firings are collected in
  order. The consuming eval / judge / task definition decides what
  to do with multiple firings (e.g. a pairwise judge can use the
  last firing).

  When no eval annotation exists in a trace, `eval extract` falls
  back to a heuristic (last LLM completion on the top-level thread)
  and emits a warning. Annotating explicitly is preferred — the
  heuristic does NOT account for post-LLM processing the agent
  applies before showing a response to the user.

  @param value - The value to record. Any JSON-serializable type is
    accepted; same serialization rules as `evalValue`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| value | `any` |  |

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L68))

### evalRecord

```ts
evalRecord(statelogPath: string, allowedPaths: string[]): StatelogEvalRecord
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L93))

### evalValues

```ts
evalValues(statelogPath: string, allowedPaths: string[]): StatelogEvalValue[]
```

Parse a statelog JSONL file and return the values recorded as eval values.
  This mirrors `new StatelogParser(path).evalValues()` in TypeScript.

  @param statelogPath - Path to the statelog JSONL file to parse
  @param allowedPaths - Optional allow-list of path prefixes

**Parameters:**

| Name | Type | Default |
|---|---|---|
| statelogPath | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** `StatelogEvalValue[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L106))

### evalOutputs

```ts
evalOutputs(statelogPath: string, allowedPaths: string[]): StatelogEvalValue[]
```

Parse a statelog JSONL file and return the values recorded as eval outputs.
  This mirrors `new StatelogParser(path).evalOutputs()` in TypeScript.

  @param statelogPath - Path to the statelog JSONL file to parse
  @param allowedPaths - Optional allow-list of path prefixes

**Parameters:**

| Name | Type | Default |
|---|---|---|
| statelogPath | `string` |  |
| allowedPaths | `string[]` | [] |

**Returns:** `StatelogEvalValue[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L117))

### finalEvalOutput

```ts
finalEvalOutput(statelogPath: string, allowedPaths: string[]): StatelogEvalValue | null
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/statelog.agency#L128))
