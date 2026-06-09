---
title: Judging eval records
description: Documents `agency eval judge`, which compares two eval records against a plain-English goal and writes a pairwise verdict JSON.
---

# Judging eval records

`agency eval judge` compares two `.eval.json` records from `agency eval extract`, sends the final response from each record to an LLM judge, and writes a small verdict JSON showing which response better meets your goal.

## Synopsis

```bash
agency eval judge --goal <text> [--out <path>] <recordA.eval.json> <recordB.eval.json>
```

Options:

- `--goal <text>` — required plain-English description of what success looks like.
- `-o, --out <path>` — output verdict JSON path. Defaults to `<recordA-stem>.vs.<recordB-stem>.verdict.json` in the current working directory.

## Example

```bash
agency eval judge \
  --goal "give the correct capital of India (New Delhi) with no additional text" \
  lib/eval/judge/fixtures/india-A.eval.json \
  lib/eval/judge/fixtures/india-B.eval.json
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

v0.1 compares only final responses. Behavioral assertions, rubric files, single-record scoring, and multi-mode dispatch are not supported yet.
