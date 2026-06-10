---
name: "eval"
---

# eval

## Types

### EvalRunTask

```ts
export type EvalRunTask = {
  task_id: string;
  rubric: string;
  args: Record<string, any>;
  node?: string;
  working_dir?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L12))

### EvalRunTaskResult

```ts
export type EvalRunTaskResult = {
  taskId: string;
  status: "success" | "error";
  evalRecordPath: string;
  statelogPath: string;
  workdirPath: string;
  errorMessage?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L20))

### EvalRunResult

```ts
export type EvalRunResult = {
  runId: string;
  runDir: string;
  agent: string;
  tasks: EvalRunTaskResult[];
  okCount: number;
  errorCount: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L29))

### EvalValue

```ts
export type EvalValue = {
  value: any;
  threadId?: string;
  tMs: number;
  truncated?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L98))

### EvalRecord

```ts
export type EvalRecord = {
  traceId: string;
  recordVersion: number;
  formatVersion: number;
  durationMs: number;
  source: string;
  evalInputs: EvalValue[];
  evalOutputs: EvalValue[];
  threads: Record<string, any>[];
  events: Record<string, any>[];
  interrupts: Record<string, any>[];
  errors: Record<string, any>[];
  incomplete: Record<string, any>[];
  metrics: Record<string, any>;
  warnings: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L105))

### PairwiseVerdictInput

```ts
export type PairwiseVerdictInput = {
  path: string;
  response: string;
  truncated?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L147))

### PairwiseVerdict

```ts
export type PairwiseVerdict = {
  verdictVersion: number;
  goal: string;
  inputs: PairwiseVerdictInput[];
  winner: string;
  confidence: string;
  reasoning: string;
  generatedAt: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L153))

## Functions

### evalRun

```ts
evalRun(compiled: CompiledProgram, tasks: EvalRunTask[], node: string, runsDir: string, runId: string, continueOnError: boolean): EvalRunResult
```

Run a compiled Agency program against eval tasks, writing per-task
  statelog and eval artifacts under runsDir/runId. Subprocess execution goes
  through std::agency.run so caller handlers still approve subprocess
  execution and child interrupts.

  @param compiled - Compiled program from std::agency.compile
  @param tasks - Eval tasks to run sequentially
  @param node - Default node to invoke when a task does not specify one
  @param runsDir - Output directory for eval runs
  @param runId - Optional run id; generated when empty
  @param continueOnError - Continue remaining tasks after a task error

**Parameters:**

| Name | Type | Default |
|---|---|---|
| compiled | [CompiledProgram](../agency.md#compiledprogram) |  |
| tasks | `EvalRunTask[]` |  |
| node | `string` | "main" |
| runsDir | `string` | "runs/" |
| runId | `string` | "" |
| continueOnError | `boolean` | true |

**Returns:** [EvalRunResult](#evalrunresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L38))

### evalExtract

```ts
evalExtract(statelogPath: string): EvalRecord
```

Extract a structured eval record from a statelog file. Equivalent to
  what `agency eval extract` writes to disk, but returned directly so
  eval pipelines composed in Agency can inspect or judge without going
  through a temporary file.

  The shape mirrors the on-disk eval-record format. Top-level fields
  (traceId, durationMs, evalInputs, evalOutputs, warnings) are the
  most commonly consumed; nested arrays (threads, events, interrupts,
  errors, incomplete) are loosely typed because their schemas are
  large and evolve independently — consumers can JSON-inspect as
  needed.

  @param statelogPath - Path to a .statelog.jsonl file produced by an
    agent run (e.g. the file under `runs/<run-id>/tasks/<task-id>/`
    after `evalRun`).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| statelogPath | `string` |  |

**Returns:** [EvalRecord](#evalrecord)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L122))

### evalJudge

```ts
evalJudge(rubric: string, recordPathA: string, recordPathB: string): PairwiseVerdict
```

Pairwise-judge two eval records against a rubric. Returns a
  structured verdict naming the winner ("A", "B", or "tie"), the
  judge's confidence level ("low", "medium", "high"), and the
  reasoning the judge produced.

  Both record paths must point at JSON files in the EvalRecord shape
  produced by `evalExtract` or `agency eval extract`. The judge
  invokes the bundled `judgePairwise.agency` program in a subprocess,
  which means a real LLM call happens per invocation — budget
  accordingly when looping.

  The argument order matters when the caller cares about position
  bias: judge LLMs slightly prefer one position over the other, so
  high-precision callers should invoke twice with swapped order and
  reconcile the verdicts.

  @param rubric - What the judge should grade against. Per-task rubrics
    from an eval suite are the typical input.
  @param recordPathA - Path to the first eval record JSON file
  @param recordPathB - Path to the second eval record JSON file

**Parameters:**

| Name | Type | Default |
|---|---|---|
| rubric | `string` |  |
| recordPathA | `string` |  |
| recordPathB | `string` |  |

**Returns:** [PairwiseVerdict](#pairwiseverdict)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L163))
