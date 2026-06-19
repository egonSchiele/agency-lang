---
title: Optimizing agents
description: Documents `agency eval optimize` — the eval-driven loop that rewrites declarations marked with the optimize modifier, including custom TypeScript graders, validation sets, configuration, and run artifacts.
---

# Optimizing agents

`agency eval optimize` (also `agency optimize`) improves an agent by rewriting the declarations you mark with the `optimize` modifier. It evaluates the baseline, asks a mutator model to propose new values for those declarations, runs and grades each candidate against your inputs, and keeps the best one.

```bash
agency optimize agent.agency --goal "Return the capital of the given country."
agency optimize agent.agency --inputs inputs.json --graders grading.ts --iterations 5
agency optimize agent.agency:main --inputs inputs.json --validation-split 0.3 --no-writeback
```

## Marking what to optimize

Put `optimize` on any string `const`/`let` the optimizer may rewrite. Discovery starts at the agent file and follows local relative `.agency` imports.

```agency
optimize const systemPrompt = "Answer accurately."

node main(question: string): string {
  optimize const prompt = "Answer accurately: ${question}"
  const answer: string = llm(prompt)
  return answer
}
```

A rewritten value must preserve every interpolation placeholder the original used (`${question}` here). Legacy `@optimize(...)` tags are not supported.

## Inputs and the goal

You describe what to optimize against with inputs and/or a goal. An input is one invocation of the agent: `args` for the node, plus optional `goal`, `expected`, `node`, `working_dir`, and freeform `metadata`.

```json
{ "inputs": [
  { "id": "india",  "args": { "country": "India" },  "expected": "New Delhi" },
  { "id": "japan",  "args": { "country": "Japan" },  "expected": "Tokyo" }
] }
```

- `--inputs <file|dir>` — the input suite.
- `--goal <text>` — an overall goal. **Combinable with `--inputs`**: it fills in as the goal for any input that doesn't set its own. Used alone, it creates one inline no-argument input (and fails upfront if the node requires arguments).
- At least one of `--inputs` / `--goal` is required.

`expected` is the gold output for an input (any JSON). It's read by the built-in match graders and surfaced to the optimizer's reflection — see below.

## Options

| Flag | Meaning |
| --- | --- |
| `<file>[:<node>]` | Required agent target. A directory resolves to `main.agency`; the node defaults to `main`. |
| `--inputs <file\|dir>` | Input suite file or directory. |
| `--goal <text>` | Overall goal (combinable with `--inputs`; or a single inline input on its own). |
| `--graders <file>` | A TypeScript grading module that replaces the default goal judge. See [Custom graders](#custom-graders). |
| `--validation-inputs <file\|dir>` | Held-out validation suite. See [Validation sets](#validation-sets). |
| `--validation-split <ratio>` | Hold out this fraction of `--inputs` (seeded by `--seed`) when `--validation-inputs` is absent. |
| `--optimizer <name>` | `greedy` (default), `gepa`, or `example`. |
| `--iterations <n>` | Max candidate iterations after the baseline. Default `5`. |
| `--minibatch <n>` | GEPA minibatch size (gepa only). Default `8`. |
| `--seed <n>` | RNG seed for reproducible search / validation split. |
| `--mutator-model <model>` | Model override for proposing mutations. |
| `--no-writeback` | Don't write the champion back to the source files. |
| `--silent` | Print nothing; artifacts are still written. |
| `--run-id <id>` | Output run id (must not already exist). |
| `--runs-dir <path>` | Output root. Defaults to `eval.optimizeRunsDir`, then `eval.runsDir/optimize`, then `runs/optimize`. |

The baseline runs the unmutated program first; if a baseline input fails (or fails a `mustPass` gate), the run aborts and reports the failing inputs — a failure before any mutation means the program or suite is broken, not the optimization.

## Custom graders

By default a run is graded by one built-in LLM judge that scores each output against the input's `goal` (or the overall `--goal`). To grade differently — match a known answer, run a deterministic check, combine several graders — pass `--graders ./grading.ts` (or set `eval.optimize.graders` in `agency.json`). The module **replaces** the default judge.

A grading module **default-exports one grader or an array of graders**. A "grader" is any of:

```ts
import { grader, ExactMatch, Contains, LlmJudge, type Grader } from "agency-lang/optimize";

// (a) a metric function: ctx = { output, input, judge }
//     `input` is the typed Input; the gold answer is `input.expected`
//     (extra per-input data can also live under `input.metadata`).
const exact: Grader = ({ output, input }) =>
  output === input.expected ? 1 : 0;   // return a number (0..1), boolean, or {score, feedback}

// (b) a wrapped function carrying policy (mustPass gate, weight, threshold, samples, inputScope)
const gate = grader(exact, { mustPass: true, name: "capital-exact" });

// (c) a configured built-in — matchOn defaults to ["expected"]
const has = new Contains({});                                    // output contains input.expected
const judge = new LlmJudge({ goal: "Return the capital.", samples: 3 });

export default [gate, judge];   // or `export default exact` for the simple case
```

**How grades become the objective.** Every grade counts: a number contributes its value (0..1), and a boolean / `ExactMatch` / `Contains` result contributes `1.0` (pass) or `0.0` (fail) — so a binary-only grader gives you plain accuracy. The objective for an input is the weighted mean of its grades, and the run objective is the mean across inputs. `mustPass` is an orthogonal **gate**: a failed `mustPass` grader zeroes that input regardless of its other grades.

> **Pick a grader that has a gradient.** Exact `===` against free-form LLM output almost never matches (`"The capital is New Delhi."` ≠ `"New Delhi"`), so it scores 0 for every candidate and the search can't climb. Use `Contains`, `Similarity`, or an `LlmJudge` (or constrain the prompt to emit only the value) so a better candidate actually scores higher.

`ctx.judge({ goal, output })` runs the bundled LLM goal judge from inside a metric function, so you can mix deterministic and LLM grading. When a grading module is configured, a per-input `goal` is optional.

### Steering the search without a goal

The optimizer's reflection is fed each input's `expected` answer **and** each grader's `feedback`, so a self-explaining grader (one that returns `{ score, feedback }`) or labeled `expected` outputs can drive the rewrites *without* a `--goal` — `--goal` is then an optional extra steer. A grader that returns only a bare score and inputs with no `expected` leave the mutator nothing to learn from, so it can only guess from the current prompt; provide one or the other.

The mutator is instructed **not** to hard-code the expected answers into the prompt. A [validation set](#validation-sets) is the backstop that fails any prompt which memorizes them anyway.

## Validation sets

Pass `--validation-inputs <file|dir>` to grade the champion against held-out inputs, or `--validation-split <ratio>` to hold out a seeded fraction of `--inputs`. Search and candidate acceptance run on the **training** inputs; with the default `greedy` optimizer the champion written back is the one with the best **validation** objective, and `report.md` shows train-vs-validation side by side so an overfit prompt (high train, flat validation) is visible. `gepa` and `example` report a validation objective but select on training; the report says so.

## Configuration

Everything can live under `eval.optimize` in `agency.json`; CLI flags override it.

```jsonc
{
  "eval": {
    "optimize": {
      "goal": "Return the capital of the given country.",
      "graders": "./grading.ts",
      "validation": { "inputs": "./validation-inputs.json" }
    }
  }
}
```

## Output and artifacts

Each run writes a directory under the runs root:

```text
runs/optimize/<run-id>/
  report.md            # human-readable: setup, per-iteration table, champion grade breakdown
  summary.json         # the full OptimizeResult (machine-readable)
  champion/
    grades.json        # the champion's per-input breakdown (output + each grader's score/feedback)
  agent-runs/ws-*/run-*/inputs/<input-id>/   # per-candidate eval runs (records + statelogs)
  ws/ws-*/             # the forked workspaces candidates were evaluated in
```

- **Read `report.md`** to see what happened: the resolved grading setup (echoed at startup too), each iteration's decision + objective + rationale, and the champion's per-input grades. A high objective next to off-topic outputs here is the quickest way to spot a gamed metric.
- **Read `summary.json`** (or `champion/`) to get the actual result — notably `championFiles`, the **optimized source** the run produced, which `report.md` does not print.

By default the optimizer also prints progress to the console (the resolved grading setup, per-iteration decisions, and the start→end value of every optimized variable). `--silent` suppresses console output; artifacts are still written.

## Writing your own optimizer

`greedy`, `gepa`, and `example` are built on a shared `BaseOptimizer`; you can register your own strategy. `example` (`lib/optimize/optimizers/example.ts`) is the minimal copy-paste template. The authoring guide lives with the developer docs in the repository at `docs/dev/writing-optimizers.md`.

## Notes

The CLI installs an approval handler for the internal `std::agency.run(...)` calls used by eval execution. The stdlib `agency.eval.optimize(...)` function does **not** install a handler; Agency callers should wrap it in their own handler when they want auto-approval.
