---
name: "eval"
---

# eval

Helpers for running and judging eval suites from Agency code.

  ## Run a task suite

  ```ts
  import { compile } from "std::agency"
  import { evalRun } from "std::agency/eval"

  node main() {
    const agent = compile("agent.agency")
    const result = evalRun(agent, [
      { task_id: "capital-france", goal: "Return Paris", args: {} },
    ])
    print(result.runDir)
  }
  ```

  ## Extract and judge eval records

  ```ts
  import { evalExtract, evalJudge } from "std::agency/eval"

  node main() {
    const record = evalExtract("runs/demo/tasks/capital-france/statelog.jsonl")
    print(record.evalOutputs)

    const verdict = evalJudge(
      "Prefer the answer that names the capital exactly.",
      "runs/a/tasks/capital-france/eval-record.json",
      "runs/b/tasks/capital-france/eval-record.json",
    )
    print(verdict.winner)
  }
  ```

  ## Judge whole run directories

  ```ts
  import { evalJudgeSuite } from "std::agency/eval"

  node main() {
    const verdict = evalJudgeSuite("runs/baseline", "runs/candidate", [
      { task_id: "capital-france", goal: "Return Paris", args: {} },
    ])
    print(verdict.winner)
  }
  ```

  ## Optimize an agent prompt

  ```ts
  import { optimize } from "std::agency/eval"
  import { read } from "std::fs"

  node main() {
    const source = read("agent.agency")
    const result = optimize({}, source, [
      { task_id: "capital-france", goal: "Return Paris", args: {} },
    ], "Prefer concise, exact answers.")
    print(result.championIter)
  }
  ```

## Types

### EvalTask

```ts
export type EvalTask = {
  task_id: string;
  goal: string;
  args: Record<string, any>;
  node?: string;
  working_dir?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L79))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L87))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L96))

### EvalValue

```ts
export type EvalValue = {
  value: any;
  threadId: string | null;
  tMs: number;
  truncated?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L165))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L172))

### PairwiseVerdictInput

```ts
export type PairwiseVerdictInput = {
  path: string;
  response: string;
  truncated?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L214))

### PairwiseVerdict

```ts
export type PairwiseVerdict = {
  verdictVersion: number;
  goal: string;
  inputs: PairwiseVerdictInput[];
  winner: string;
  confidence: number;
  reasoning: string;
  generatedAt: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L220))

### JudgeAggregationPolicy

```ts
export type JudgeAggregationPolicy = {
  samples: number;
  confidenceThreshold: number;
  marginThreshold: number;
  positionBias: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L260))

### TaskVerdictInput

```ts
export type TaskVerdictInput = {
  path?: string;
  status: string;
  response?: string;
  truncated?: boolean;
  errorMessage?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L267))

### JudgeSample

```ts
export type JudgeSample = {
  winner: string;
  confidence: number;
  reasoning: string;
  order: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L275))

### TaskVerdict

```ts
export type TaskVerdict = {
  taskId: string;
  goal: string;
  inputs: TaskVerdictInput[];
  winner: string;
  confidence: number;
  reasoning: string;
  samples: JudgeSample[];
  generatedAt: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L282))

### SuiteVerdict

```ts
export type SuiteVerdict = {
  verdictVersion: number;
  generatedAt: string;
  policy: JudgeAggregationPolicy;
  winsA: number;
  winsB: number;
  ties: number;
  winner: string;
  perTask: TaskVerdict[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L293))

### OptimizeDecision

```ts
export type OptimizeDecision =
  | "baseline"
  | "accepted"
  | "rejected"
  | "validation-failed"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L333))

### OptimizeIterationResult

```ts
export type OptimizeIterationResult = {
  iter: number;
  agentPath: string;
  mutationPath?: string;
  evalRunDir?: string;
  verdictPath?: string;
  decision: OptimizeDecision;
  wins: number;
  losses: number;
  ties: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L335))

### OptimizeResult

```ts
export type OptimizeResult = {
  runId: string;
  runDir: string;
  championIter: number | "baseline";
  championSource: string;
  acceptedCount: number;
  rejectedCount: number;
  validationFailedCount: number;
  iterations: OptimizeIterationResult[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L347))

## Functions

### evalRun

```ts
evalRun(compiled: CompiledProgram, tasks: EvalTask[], node: string, runsDir: string, runId: string, continueOnError: boolean): EvalRunResult
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
| tasks | `EvalTask[]` |  |
| node | `string` | "main" |
| runsDir | `string` | "runs/" |
| runId | `string` | "" |
| continueOnError | `boolean` | true |

**Returns:** [EvalRunResult](#evalrunresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L105))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L189))

### evalJudge

```ts
evalJudge(goal: string, recordPathA: string, recordPathB: string): PairwiseVerdict
```

Pairwise-judge two eval records against a goal. Returns a
  structured verdict naming the winner ("A", "B", or "tie"), the
  judge's confidence as an integer from 0 to 100, and the
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

  @param goal - What the judge should grade against. Per-task goals
    from an eval suite are the typical input.
  @param recordPathA - Path to the first eval record JSON file
  @param recordPathB - Path to the second eval record JSON file

**Parameters:**

| Name | Type | Default |
|---|---|---|
| goal | `string` |  |
| recordPathA | `string` |  |
| recordPathB | `string` |  |

**Returns:** [PairwiseVerdict](#pairwiseverdict)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L230))

### evalJudgeSuite

```ts
evalJudgeSuite(runA: string, runB: string, tasks: EvalTask[], samples: number, confidenceThreshold: number, marginThreshold: number, positionBias: string): SuiteVerdict
```

Judge two eval run directories by task id and aggregate the results into a
  suite verdict. Missing or failed task records are handled deterministically
  without calling the LLM judge; successful tasks are judged pairwise.

  @param runA - Path to the first eval run directory
  @param runB - Path to the second eval run directory
  @param tasks - Task suite defining task ids and goals to compare
  @param samples - Judge samples per task
  @param confidenceThreshold - Minimum task confidence counted as a suite win
  @param marginThreshold - Suite win margin required to avoid an overall tie
  @param positionBias - Position bias control: "swap" or "none"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| runA | `string` |  |
| runB | `string` |  |
| tasks | `EvalTask[]` |  |
| samples | `number` | 3 |
| confidenceThreshold | `number` | 50 |
| marginThreshold | `number` | 0 |
| positionBias | `string` | "swap" |

**Returns:** [SuiteVerdict](#suiteverdict)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L304))

### optimize

```ts
optimize(config: Record<string, any>, agentSource: string, tasks: EvalTask[], goal: string, node: string, iterations: number, judgeSamples: number, acceptThreshold: number, runsDir: string, runId: string, agentFilename: string, workingDir: string, mutatorModel: string): OptimizeResult
```

Optimize the prompt marked with @optimize(prompt) in agentSource by
  repeatedly proposing mutations, running the candidate against eval tasks,
  and accepting candidates whose confident pairwise wins exceed losses by
  acceptThreshold.

  This stdlib function does not install any approval handler. Callers that
  want to auto-approve std::agency.run subprocess execution should wrap the
  call in their own handler; the CLI does this for `agency eval optimize`.

  @param config - Agency config to use for eval compilation and LLM calls
  @param agentSource - Agency source text containing exactly one target tag
  @param tasks - Eval tasks to run for each candidate
  @param goal - Plain-English optimization objective for the mutator
  @param node - Node containing the @optimize(prompt) target
  @param iterations - Maximum candidate iterations after the baseline
  @param judgeSamples - Pairwise judge samples per task
  @param acceptThreshold - Accept when wins minus losses exceeds this value
  @param runsDir - Directory where optimization artifacts are written
  @param runId - Run id; generated by default
  @param agentFilename - Logical filename used when materializing agentSource
  @param workingDir - Working directory copied for candidate eval workspaces
  @param mutatorModel - Optional model override for prompt mutation

**Parameters:**

| Name | Type | Default |
|---|---|---|
| config | `Record<string, any>` |  |
| agentSource | `string` |  |
| tasks | `EvalTask[]` |  |
| goal | `string` |  |
| node | `string` | "main" |
| iterations | `number` | 5 |
| judgeSamples | `number` | 3 |
| acceptThreshold | `number` | 0 |
| runsDir | `string` | "runs/optimize" |
| runId | `string` | "" |
| agentFilename | `string` | "agent.agency" |
| workingDir | `string` | "." |
| mutatorModel | `string` | "" |

**Returns:** [OptimizeResult](#optimizeresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L358))
