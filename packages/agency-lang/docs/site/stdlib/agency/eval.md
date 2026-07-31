---
name: "eval"
description: "Helpers for judging eval runs from Agency code."
---

# eval

Helpers for judging eval runs from Agency code. (Running suites from
  Agency was removed 2026-07-30: the old binding predated workdir seeding
  and diverged from `agency eval run` semantics. Run suites with the CLI;
  a binding over the current runSuite can come back when needed.)

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L47))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L54))

### PairwiseVerdictInput

```ts
export type PairwiseVerdictInput = {
  path: string;
  response: string;
  truncated?: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L89))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L95))

### JudgeAggregationPolicy

```ts
export type JudgeAggregationPolicy = {
  samples: number;
  confidenceThreshold: number;
  marginThreshold: number;
  positionBias: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L125))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L132))

### JudgeSample

```ts
export type JudgeSample = {
  winner: string;
  confidence: number;
  reasoning: string;
  order: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L140))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L147))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L158))

## Functions

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L76))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L110))

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

Judge two eval run directories by input id and aggregate the results into a suite verdict. Input ids and goals come from each run directory itself (the input.json files the run wrote). Missing or failed input records are handled deterministically without calling the LLM judge; successful inputs are judged pairwise.

  @param runA - Path to the first eval run directory
  @param runB - Path to the second eval run directory
  @param samples - Judge samples per input
  @param confidenceThreshold - Minimum input confidence counted as a suite win
  @param marginThreshold - Suite win margin required to avoid an overall tie
  @param positionBias - Whether to swap A/B order across samples to cancel judge position bias

**Parameters:**

| Name | Type | Default |
|---|---|---|
| runA | `string` |  |
| runB | `string` |  |
| samples | `number` | 3 |
| confidenceThreshold | `number` | 50 |
| marginThreshold | `number` | 0 |
| positionBias | `"swap" \| "none"` | "swap" |

**Returns:** [SuiteVerdict](#suiteverdict)

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agency/eval.agency#L169))
