# Graders

### Grading with code instead of an LLM

An LLM judge is flexible but slow, costs money, and is a little different every time. When you can say what "correct" means in code, do that instead. You write a **grading module**: a TypeScript file that default-exports one grader or a list of them, and pass it with `--graders`:

```ts
// graders.ts
import { grader, ExactMatch, Contains, Similarity } from "agency-lang/eval";

export default [
  // a function over the run: return true/false, a number from 0 to 1, or a full Grade
  grader(({ output }) => String(output).includes("1879"), { name: "mentions-year" }),

  // compare the output against the test's `expected` field
  new ExactMatch({ mustPass: true }),
  new Contains({ name: "has-date" }),
  new Similarity({ weight: 0.5 }),
];
```

```bash
agency eval grade runs/einstein --graders graders.ts
```

This appends one score row per grader, all in one pass. The built-in graders are:

- `ExactMatch` — pass if the output deep-equals the test's `expected` value.
- `Contains` — pass if the stringified output contains `expected`.
- `Similarity` — a 0 to 1 score based on edit distance between output and `expected`.

All three read `expected` by default; pass `matchOn: ["some", "path"]` to compare against a different field of the test instead.

A `grader(fn, options)` function receives `{ output, test, workdir, record, judge }`:

- `output` is what the agent returned.
- `test` is the test as you wrote it in the inputs file (so you can read `test.expected` or anything else you put there).
- `workdir` is the path to the run's working directory, so you can check for files the agent wrote.
- `record` is the run record, including metrics like `record.metrics.costUsdTotal`.
- `judge({ goal })` runs the bundled LLM judge on demand, for the cases where you want code to decide *whether* to ask an LLM.

Code graders are free to re-run, so you can grade the same run as many times as you like while you tune them.

### Your own LLM judge

The bundled goal judge is a general-purpose "does the output satisfy the goal" prompt. When you want a judge with its own rubric, write it as an Agency file and point `LlmJudge` at it from a grading module:

```ts
// graders.ts
import { LlmJudge } from "agency-lang/eval";

export default [
  new LlmJudge({ name: "tone", agencyFile: "./toneJudge.agency", goal: "is polite and concise" }),
];
```

The judge file is a normal Agency program whose `main` node takes `(goal, output, expected)` and returns `{ score, reasoning }` (or `{ pass, reasoning }` with `binary: true`). It is identified in the annotations by its file path and content hash, so editing the judge prompt in place counts as a new judge rather than silently changing what old scores mean.

### How scores combine

Each test's scores are folded into one number, the **objective**, between 0 and 1:

- Every grader contributes its score times its `weight` (default 1), and the objective is the weighted mean.
- A grader with `mustPass: true` is a gate: if it fails, that test scores 0 regardless of the others, and `eval grade` exits with code 2. That makes it usable as a CI check.
- `threshold` is the passing bar for a scalar grader (default 0, so any score passes); it decides whether a scalar gate fails. `samples` runs a grader several times and aggregates the results, which helps with a noisy LLM judge.

`eval grade` prints the objective for each run directory and the mean over all of them. A test whose agent errored scores 0 and fails every gate; it is counted, not skipped.

### Where the graders come from

When you don't pass `--graders` or `--goal`, `eval grade` picks graders in this order:

1. The test's own graders, if the input named a `graders` module (or, in the test-directory form, a `graders.ts` sits beside `test.json`).
2. The `eval.graders` module in `agency.json`, for tests that have none of their own.
3. The bundled goal judge, scoring against the test's `goal`.

`--graders <file>` overrides all of that for every test in the pass. `--goal` is the other override and always means the bundled goal judge; the two flags can't be combined, because a grading module brings its own criteria (give `LlmJudge` a `goal` there instead).

### Grading by hand

Some things have no automatic grader. Is this summary actually good? Would you send this email? For those, `agency label` lets you answer a checklist of yes/no questions about each run, and writes your answers into the same `annotations.jsonl`, next to the graders' scores. That deserves its own section, so it comes later.
