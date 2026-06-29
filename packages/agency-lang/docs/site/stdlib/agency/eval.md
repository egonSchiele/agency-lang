---
name: "eval"
---

# eval

Helpers for running and judging eval suites from Agency code.

  ## Run an input suite

  ```ts
  import { compile } from "std::agency"
  import { evalRun } from "std::agency/eval"

  node main() {
    const agent = compile("agent.agency")
    const result = evalRun(agent, [
      { id: "capital-france", goal: "Return Paris", args: {} },
    ])
    print(result.runDir)
  }
  ```

  ## Extract and judge eval records

  ```ts
  import { evalExtract, evalJudge } from "std::agency/eval"

  node main() {
    const record = evalExtract("runs/demo/inputs/capital-france/statelog.jsonl")
    print(record.evalOutputs)

    const verdict = evalJudge(
      "Prefer the answer that names the capital exactly.",
      "runs/a/inputs/capital-france/eval-record.json",
      "runs/b/inputs/capital-france/eval-record.json",
    )
    print(verdict.winner)
  }
  ```

  ## Judge whole run directories

  ```ts
  import { evalJudgeSuite } from "std::agency/eval"

  node main() {
    const verdict = evalJudgeSuite("runs/baseline", "runs/candidate", [
      { id: "capital-france", goal: "Return Paris", args: {} },
    ])
    print(verdict.winner)
  }
  ```

  ## Optimize marked declarations

  ```ts
  import { optimize } from "std::agency/eval"

  node main() {
    const result = optimize({}, "agent.agency", ".", [
      { id: "capital-france", goal: "Return Paris", args: {} },
    ], "Prefer concise, exact answers.")
    print(result.championIter)
  }
  ```

## Types

### Input

```ts
export type Input = {
  id?: string;
  goal?: string;
  args: Record<string, any>;
  node?: string;
  working_dir?: string;
  metadata?: Record<string, any>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L77))

### EvalRunInputResult

```ts
export type EvalRunInputResult = {
  inputId: string;
  status: "success" | "error";
  evalRecordPath: string;
  statelogPath: string;
  workdirPath: string;
  errorMessage?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L86))

### EvalRunResult

```ts
export type EvalRunResult = {
  runId: string;
  runDir: string;
  agent: string;
  inputs: EvalRunInputResult[];
  okCount: number;
  errorCount: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L95))

### EvalValue

```ts
export type EvalValue = {
  value: any;
  threadId?: string;
  tMs: number;
  truncated?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L164))

### EvalRecord

```ts
export type EvalRecord = {
  traceId: string;
  recordVersion: number;
  formatVersion: number;
  durationMs: number;
  source: string;
  evalValues: EvalValue[];
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L171))

### PairwiseVerdictInput

```ts
export type PairwiseVerdictInput = {
  path: string;
  response: string;
  truncated?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L213))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L219))

### JudgeAggregationPolicy

```ts
export type JudgeAggregationPolicy = {
  samples: number;
  confidenceThreshold: number;
  marginThreshold: number;
  positionBias: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L259))

### VerdictSide

```ts
export type VerdictSide = {
  path?: string;
  status: string;
  response?: string;
  truncated?: boolean;
  errorMessage?: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L266))

### JudgeSample

```ts
export type JudgeSample = {
  winner: string;
  confidence: number;
  reasoning: string;
  order: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L274))

### InputVerdict

```ts
export type InputVerdict = {
  inputId: string;
  goal: string;
  inputs: VerdictSide[];
  winner: string;
  confidence: number;
  reasoning: string;
  samples: JudgeSample[];
  generatedAt: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L281))

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
  perInput: InputVerdict[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L292))

### OptimizeDecision

```ts
export type OptimizeDecision =
  | "baseline"
  | "accepted"
  | "rejected"
  | "validation-failed"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L332))

### OptimizeIterationResult

```ts
export type OptimizeIterationResult = {
  iter: number;
  decision: OptimizeDecision;
  agentDir?: string;
  mutationPath?: string;
  evalRunDir?: string;
  verdictPath?: string;
  winsA: number;
  winsB: number;
  ties: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L334))

### OptimizeResult

```ts
export type OptimizeResult = {
  runId: string;
  runDir: string;
  championIter: number | "baseline";
  championFiles: Record<string, string>;
  acceptedCount: number;
  rejectedCount: number;
  validationFailedCount: number;
  iterations: OptimizeIterationResult[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L346))

## Functions

### evalRun

```ts
evalRun(compiled: CompiledProgram, inputs: Input[], node: string, runsDir: string, runId: string, continueOnError: boolean): EvalRunResult
```

Run a compiled Agency program against eval inputs, writing per-input
  statelog and eval artifacts under runsDir/runId. Subprocess execution goes
  through std::agency.run so caller handlers still approve subprocess
  execution and child interrupts.

  @param compiled - Compiled program from std::agency.compile
  @param inputs - Eval inputs to run sequentially
  @param node - Default node to invoke when an input does not specify one
  @param runsDir - Output directory for eval runs
  @param runId - Optional run id; generated when empty
  @param continueOnError - Continue remaining inputs after an input error

**Parameters:**

| Name | Type | Default |
|---|---|---|
| compiled | [CompiledProgram](../agency.md#compiledprogram) |  |
| inputs | `Input[]` |  |
| node | `string` | "main" |
| runsDir | `string` | "runs/" |
| runId | `string` | "" |
| continueOnError | `boolean` | true |

**Returns:** [EvalRunResult](#evalrunresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L104))

### evalExtract

```ts
evalExtract(statelogPath: string): EvalRecord
```

Extract a structured eval record from a statelog file. Equivalent to
  what `agency eval extract` writes to disk, but returned directly so
  eval pipelines composed in Agency can inspect or judge without going
  through a temporary file.

  The shape mirrors the on-disk eval-record format. Top-level fields
  (traceId, durationMs, evalValues, evalOutputs, warnings) are the
  most commonly consumed; nested arrays (threads, events, interrupts,
  errors, incomplete) are loosely typed because their schemas are
  large and evolve independently — consumers can JSON-inspect as
  needed.

  @param statelogPath - Path to a .statelog.jsonl file produced by an
    agent run (e.g. the file under `runs/<run-id>/inputs/<input-id>/`
    after `evalRun`).

**Parameters:**

| Name | Type | Default |
|---|---|---|
| statelogPath | `string` |  |

**Returns:** [EvalRecord](#evalrecord)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L188))

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

  @param goal - What the judge should grade against. Per-input goals
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L229))

### evalJudgeSuite

```ts
evalJudgeSuite(runA: string, runB: string, inputs: Input[], samples: number, confidenceThreshold: number, marginThreshold: number, positionBias: string): SuiteVerdict
```

Judge two eval run directories by input id and aggregate the results into a
  suite verdict. Missing or failed input records are handled deterministically
  without calling the LLM judge; successful inputs are judged pairwise.

  @param runA - Path to the first eval run directory
  @param runB - Path to the second eval run directory
  @param inputs - Input suite defining input ids and goals to compare
  @param samples - Judge samples per input
  @param confidenceThreshold - Minimum input confidence counted as a suite win
  @param marginThreshold - Suite win margin required to avoid an overall tie
  @param positionBias - Position bias control: "swap" or "none"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| runA | `string` |  |
| runB | `string` |  |
| inputs | `Input[]` |  |
| samples | `number` | 3 |
| confidenceThreshold | `number` | 50 |
| marginThreshold | `number` | 0 |
| positionBias | `string` | "swap" |

**Returns:** [SuiteVerdict](#suiteverdict)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L303))

### optimize

```ts
optimize(config: Record<string, any>, entryFile: string, workingDir: string, inputs: Input[], goal: string, node: string, iterations: number, samples: number, confidenceThreshold: number, marginThreshold: number, runsDir: string, runId: string, mutatorModel: string, writeback: boolean, verbosity: string): OptimizeResult
```

Optimize declarations marked with the `optimize` modifier in an Agency
  file. For example, `optimize const prompt = "..."` marks a string
  declaration the optimizer may mutate while evaluating candidates against
  eval inputs. Targets are discovered across the local Agency import tree of
  entryFile.

  Provide exactly one of inputs or goal: a goal desugars to a single
  no-argument input. Each candidate is compared against the current champion
  with the shared eval judge suite, and a candidate is accepted iff the
  suite verdict winner is "B" (the candidate side).

  This stdlib function does not install any approval handler. Callers that
  want to auto-approve std::agency.run subprocess execution should wrap the
  call in their own handler; the CLI does this for `agency eval optimize`.

  @param config - Agency config to use for eval compilation and LLM calls
  @param entryFile - Agency file containing the eval entrypoint
  @param workingDir - Directory used to resolve a relative entryFile
  @param inputs - Eval inputs to run for each candidate (exclusive with goal)
  @param goal - Single optimization goal (exclusive with inputs)
  @param node - Node to evaluate while optimizing discovered declarations
  @param iterations - Maximum candidate iterations after the baseline
  @param samples - Judge samples per input
  @param confidenceThreshold - Minimum input confidence counted as a suite win
  @param marginThreshold - Suite win margin required to avoid an overall tie
  @param runsDir - Directory where optimization artifacts are written
  @param runId - Run id; generated by default
  @param mutatorModel - Optional model override for proposing mutations
  @param writeback - Write the champion file set back to the source files
  @param verbosity - Progress logging: "silent" or "default"

**Parameters:**

| Name | Type | Default |
|---|---|---|
| config | `Record<string, any>` |  |
| entryFile | `string` |  |
| workingDir | `string` | "." |
| inputs | `Input[]` | [] |
| goal | `string` | "" |
| node | `string` | "main" |
| iterations | `number` | 5 |
| samples | `number` | 3 |
| confidenceThreshold | `number` | 50 |
| marginThreshold | `number` | 0 |
| runsDir | `string` | "runs/optimize" |
| runId | `string` | "" |
| mutatorModel | `string` | "" |
| writeback | `boolean` | false |
| verbosity | `string` | "silent" |

**Returns:** [OptimizeResult](#optimizeresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L357))
