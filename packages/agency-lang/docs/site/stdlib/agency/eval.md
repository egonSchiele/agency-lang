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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L10))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L18))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L27))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L36))
