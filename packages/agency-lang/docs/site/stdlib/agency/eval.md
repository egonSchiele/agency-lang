---
name: "eval"
description: "Helpers for running and judging eval suites from Agency code."
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L163))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L170))

### PairwiseVerdictInput

```ts
export type PairwiseVerdictInput = {
  path: string;
  response: string;
  truncated?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L205))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L211))

### JudgeAggregationPolicy

```ts
export type JudgeAggregationPolicy = {
  samples: number;
  confidenceThreshold: number;
  marginThreshold: number;
  positionBias: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L241))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L248))

### JudgeSample

```ts
export type JudgeSample = {
  winner: string;
  confidence: number;
  reasoning: string;
  order: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L256))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L263))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L274))

### OptimizeDecision

```ts
export type OptimizeDecision =
  | "baseline"
  | "accepted"
  | "rejected"
  | "validation-failed"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L312))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L314))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L326))

## Functions

### evalRun

```ts
evalRun(
  compiled: CompiledProgram,
  inputs: Input[],
  node: string = "main",
  runsDir: string = "runs/",
  runId: string = "",
  continueOnError: boolean = true,
): EvalRunResult
```

Run a compiled Agency program against a list of eval inputs sequentially, writing per-input statelog and eval artifacts under runsDir/runId, and return a summary of the run.

  @param compiled - Compiled program to evaluate
  @param inputs - Eval inputs to run sequentially
  @param node - Default node to invoke when an input does not specify one
  @param runsDir - Output directory for eval runs
  @param runId - Optional run id; generated when empty
  @param continueOnError - Continue remaining inputs after an input error

Subprocess execution goes through the std::agency run primitive, so caller
  handlers still approve subprocess execution and child interrupts.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L106))

### evalExtract

```ts
evalExtract(statelogPath: string): EvalRecord
```

Extract a structured eval record from a statelog file. Returns the same record `agency eval extract` writes to disk, but directly, so eval pipelines composed in Agency can inspect or judge it without going through a temporary file.

  @param statelogPath - Path to a .statelog.jsonl file produced by an agent run (e.g. the file under `runs/<run-id>/inputs/<input-id>/` after an eval run)

The shape mirrors the on-disk eval-record format. Top-level fields (traceId,
  durationMs, evalValues, evalOutputs, warnings) are the most commonly consumed.
  The nested arrays (threads, events, interrupts, errors, incomplete) are loosely
  typed because their schemas are large and evolve independently. Consumers can
  JSON-inspect as needed.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| statelogPath | `string` |  |

**Returns:** [EvalRecord](#evalrecord)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L192))

### evalJudge

```ts
evalJudge(
  goal: string,
  recordPathA: string,
  recordPathB: string,
): PairwiseVerdict
```

Pairwise-judge two eval records against a goal. Returns a structured verdict naming the winner ("A", "B", or "tie"), the judge's confidence as an integer from 0 to 100, and the reasoning the judge produced. Both record paths must point at JSON files in the EvalRecord shape produced by extracting an eval record.

  @param goal - What the judge should grade against (typically a per-input goal from an eval suite)
  @param recordPathA - Path to the first eval record JSON file
  @param recordPathB - Path to the second eval record JSON file

Runs the bundled pairwise-judge program in a subprocess, so a real LLM call
  happens per invocation. Budget accordingly when looping. Argument order can
  matter: judge LLMs slightly prefer one position over the other, so
  high-precision callers should invoke twice with swapped order and reconcile the
  verdicts.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| goal | `string` |  |
| recordPathA | `string` |  |
| recordPathB | `string` |  |

**Returns:** [PairwiseVerdict](#pairwiseverdict)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L226))

### evalJudgeSuite

```ts
evalJudgeSuite(
  runA: string,
  runB: string,
  inputs: Input[],
  samples: number = 3,
  confidenceThreshold: number = 50,
  marginThreshold: number = 0,
  positionBias: "swap" | "none" = "swap",
): SuiteVerdict
```

Judge two eval run directories by input id and aggregate the results into a suite verdict. Missing or failed input records are handled deterministically without calling the LLM judge; successful inputs are judged pairwise.

  @param runA - Path to the first eval run directory
  @param runB - Path to the second eval run directory
  @param inputs - Input suite defining input ids and goals to compare
  @param samples - Judge samples per input
  @param confidenceThreshold - Minimum input confidence counted as a suite win
  @param marginThreshold - Suite win margin required to avoid an overall tie
  @param positionBias - Whether to swap A/B order across samples to cancel judge position bias

**Parameters:**

| Name | Type | Default |
|---|---|---|
| runA | `string` |  |
| runB | `string` |  |
| inputs | `Input[]` |  |
| samples | `number` | 3 |
| confidenceThreshold | `number` | 50 |
| marginThreshold | `number` | 0 |
| positionBias | `"swap" \| "none"` | "swap" |

**Returns:** [SuiteVerdict](#suiteverdict)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L285))

### optimize

```ts
optimize(
  config: Record<string, any>,
  entryFile: string,
  workingDir: string = ".",
  inputs: Input[] = [],
  goal: string = "",
  node: string = "main",
  iterations: number = 5,
  samples: number = 3,
  confidenceThreshold: number = 50,
  marginThreshold: number = 0,
  runsDir: string = "runs/optimize",
  runId: string = "",
  mutatorModel: string = "",
  writeback: boolean = false,
  verbosity: "silent" | "default" = "silent",
): OptimizeResult
```

Optimize declarations marked with the `optimize` modifier in an Agency file. For example, `optimize const prompt = "..."` marks a string declaration the optimizer may mutate while evaluating candidates against eval inputs. Targets are discovered across the local Agency import tree of entryFile. Provide exactly one of inputs or goal: a goal desugars to a single no-argument input.

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
  @param verbosity - Progress logging level

Installs no approval handler: callers that want to auto-approve subprocess
  execution should wrap the call in their own handler (the CLI does this for
  `agency eval optimize`). The shared eval judge suite compares each candidate
  against the current champion and accepts it iff the suite verdict winner is
  the candidate side.

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
| verbosity | `"silent" \| "default"` | "silent" |

**Returns:** [OptimizeResult](#optimizeresult)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L342))
