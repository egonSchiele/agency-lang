# Graders

### Grading with code instead of an LLM

An LLM judge is flexible but slow, costs money, and is a little different every time. When you can say what "correct" means in code, do that instead. You write a **grading module**: a TypeScript file that default-exports one grader or a list of them, saved as `graders.ts` beside the test's `test.json`:

```ts
// einstein/graders.ts
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
agency eval run agent.agency --suite evals/einstein --out runs/einstein
agency eval grade runs/einstein
```

Grading appends one score row per grader, all in one pass. The built-in graders are:

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

Graders belong to tests. A test names its module with `graders` in its spec, or a `graders.ts` beside its `test.json` is picked up automatically. A test with no graders is scored by the bundled goal judge against its `goal`.

`eval run` stores a copy of each test's graders in the run directory, and `eval grade` scores with that copy, so an edit to `graders.ts` never silently changes what an old run scores. To re-score old runs with the graders you have now, name the suite: `eval grade runs/einstein --suite evals/einstein` grades each run with its test's current graders, matched by test id.

`--goal <text>` judges every trace against that text with the bundled goal judge (a test that recorded its own goal keeps it). It can't be combined with `--suite`, because the suite's graders bring their own criteria (give `LlmJudge` a `goal` in `graders.ts` instead).

### Grading by hand

Some things have no automatic grader. Is this summary actually good? Would you send this email? For those, `agency label` lets you answer a checklist of yes/no questions about each run, and writes your answers into the same `annotations.jsonl`, next to the graders' scores. That deserves its own section, so it comes later.
