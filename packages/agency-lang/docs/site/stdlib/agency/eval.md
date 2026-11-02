---
name: "eval"
description: "Extract run records and compare agent responses with LLM judges."
---

# eval

Inspect saved statelog traces, compare two responses against a goal, or
  compare two whole run directories. Use the CLI to run evaluation suites.

  ## Extract and judge eval records

  ```ts
  import { evalExtract, evalJudge } from "std::agency/eval"

  node main() {
    const record = evalExtract("runs/demo/statelog.jsonl")
    print(record.evalOutputs)

    const verdict = evalJudge(
      "Prefer the answer that names the capital exactly.",
      "runs/a/statelog.jsonl",
      "runs/b/statelog.jsonl",
    )
    print(verdict.winner)
  }
  ```

  ## Judge whole run directories

  ```ts
  import { evalJudgeSuite } from "std::agency/eval"

  node main() {
    const verdict = evalJudgeSuite("runs/baseline", "runs/candidate")
    print(verdict.winner)
  }
  ```

## Types

### EvalValue

```ts
export type EvalValue = {
  value: any;
  threadId?: string;
  tMs: number;
  truncated?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L51))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L58))

### PairwiseVerdictInput

```ts
export type PairwiseVerdictInput = {
  path: string;
  response: string;
  truncated?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L94))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L100))

### JudgeAggregationPolicy

```ts
export type JudgeAggregationPolicy = {
  samples: number;
  confidenceThreshold: number;
  marginThreshold: number;
  positionBias: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L132))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L139))

### JudgeSample

```ts
export type JudgeSample = {
  winner: string;
  confidence: number;
  reasoning: string;
  order: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L147))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L154))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L165))

## Functions

### evalExtract

```ts
evalExtract(statelogPath: string): EvalRecord
```

Read a structured evaluation record from a statelog trace.

Read one trace as a normalized record for analysis. The record is
  computed from the statelog rather than stored as a separate file.
  Use `evalOutputs` to inspect what will be graded.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| statelogPath | `string` |  | A statelog JSONL file containing exactly one trace. |

**Returns:** [EvalRecord](#evalrecord)

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L81))

### evalJudge

```ts
evalJudge(
  goal: string,
  recordPathA: string,
  recordPathB: string,
): PairwiseVerdict
```

Compare two saved agent responses against a grading goal.

Runs the bundled pairwise judge, making an LLM call for each comparison.
  The verdict names A, B, or tie, with confidence from zero to 100. For
  comparisons sensitive to response order, judge both orders and reconcile
  the results. Each path must name a single-trace statelog.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| goal | `string` |  | The criteria the judge should use to compare the responses. |
| recordPathA | `string` |  | A statelog JSONL file containing the first run's single trace. |
| recordPathB | `string` |  | A statelog JSONL file containing the second run's single trace. |

**Returns:** [PairwiseVerdict](#pairwiseverdict)

**Needs:** `fileRead`, `llm`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L117))

### evalJudgeSuite

```ts
evalJudgeSuite(
  runA: string,
  runB: string,
  samples: number = 3,
  confidenceThreshold: number = 50,
  marginThreshold: number = 0,
  positionBias: "swap" | "none" = "swap",
): SuiteVerdict
```

Compare two evaluation run directories and aggregate their per-test verdicts.

Compares matching test IDs across two run directories. Goals and test
  IDs come from the run annotations saved with each trace. Missing or
  failed runs and missing goals get deterministic verdicts without an LLM
  call. Successful comparisons make the requested number of judge calls.

  Per-test winners below the confidence threshold count as suite ties. The
  overall win-count difference must exceed the margin threshold to choose
  a suite winner.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| runA | `string` |  | The first run directory containing statelog traces and run annotations. |
| runB | `string` |  | The second run directory containing statelog traces and run annotations. |
| samples | `number` | 3 | The number of judge calls for each comparable test. |
| confidenceThreshold | `number` | 50 | Treat per-test confidence below this zero-to-100 threshold as a suite tie. |
| marginThreshold | `number` | 0 | Require the suite's win-count difference to exceed this number. |
| positionBias | `"swap" \| "none"` | "swap" | Use swap to alternate response order across samples, or none to keep A first. |

**Returns:** [SuiteVerdict](#suiteverdict)

**Needs:** `fileRead`, `llm`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L187))
