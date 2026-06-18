---
title: Judging eval records
description: Documents `agency eval judge`, which compares two eval records against a plain-English goal and writes a pairwise verdict JSON.
---

# Judging eval records

`agency eval judge` compares two `.eval.json` records from `agency eval extract` or two eval run directories from `agency eval run`, sends final responses to an LLM judge, and writes a verdict JSON showing which side better meets your goal.

## Synopsis

```bash
agency eval judge --goal <text> [--out <path>] <recordA.eval.json> <recordB.eval.json>
agency eval judge (--goal <text> | --inputs <file|dir>) [--out <path>] <runA> <runB>
```

Options:

- `--goal <text>` — plain-English description of what success looks like. Required for record comparison. For single-input run directories, creates an inline `input-1` goal.
- `--inputs <file|dir>` — eval input suite for run-directory comparison.
- `--samples <n>` — judge samples per input. Defaults to `3`.
- `--confidence-threshold <n>` — minimum input confidence counted as a suite win. Defaults to `50`.
- `--margin-threshold <n>` — suite win margin required. Defaults to `0`.
- `--position-bias <swap|none>` — alternate A/B positions across samples or keep original order. Defaults to `swap`.
- `-o, --out <path>` — output verdict JSON path. Defaults to `<recordA-stem>.vs.<recordB-stem>.verdict.json` in the current working directory.

## Example

```bash
agency eval judge \
  --goal "give the correct capital of India (New Delhi) with no additional text" \
  lib/eval/judge/fixtures/india-A.eval.json \
  lib/eval/judge/fixtures/india-B.eval.json
```

Compare two run directories against an input suite:

```bash
agency eval judge runs/baseline runs/candidate --inputs inputs.json
```

The command prints a short summary and writes the full verdict:

```text
Winner: A (medium)
Reasoning: Response A gives the capital directly, while Response B wraps it in JSON.

Wrote verdict to india-A.vs.india-B.verdict.json
```

## Verdict shape

```typescript
type PairwiseVerdict = {
  verdictVersion: 1;
  goal: string;
  inputs: [
    { path: string; response: string | null; truncated?: true },
    { path: string; response: string | null; truncated?: true },
  ];
  winner: "A" | "B" | "tie";
  confidence: "low" | "medium" | "high";
  reasoning: string;
  generatedAt: string;
};
```

`inputs[*].response` is the exact string sent to the judge, or `null` when the eval record had no recorded output. `truncated: true` mirrors `eval extract` metadata when the source response was already capped at extraction time.

## Limitations

Behavioral assertions and single-record scoring are not supported yet.
