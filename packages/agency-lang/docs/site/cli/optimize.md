---
title: Optimizing agents
description: Documents `agency eval optimize` — the eval-driven loop that rewrites declarations marked with the optimize modifier, including custom TypeScript graders, validation sets, configuration, and run artifacts.
---

# Optimizing agents

`agency optimize` improves an agent by rewriting your prompts for you.

For example, let's say you are writing an agent to return the capital of India. Here's your code:

```ts
node main() {
  const prompt = "What is the capital of France?"
  const response = llm(prompt)
  return response
}
```

Notice that the prompt is incorrectly asking for the capital of France. We're going to have the optimizer change this prompt to India. It's really easy to get started with the optimizer for a toy example like this. First, we need to mark the targets we want the optimizer to optimize:

```ts
node main() {
  // added `optimize` to next line
  optimize const prompt = "What is the capital of France?"
  const response = llm(prompt)
  return response
}
```

The only change needed is the `optimize` modifier on the `prompt` variable declaration. Now call the `optimize` command, giving it your agency file and a goal:

```
agency optimize foo.agency --goal 'Return the capital of India'
```

If you run this command, you'll see output similar to this:

```
  grading:
    - goal
    first input: input-1 — goal: Return the capital of India

== optimize greedy (run demo-run): 1 target(s), 1 input(s), up to 5 iteration(s) ==
  - bar.agency:main:prompt = "What is the capital of France?"
  baseline   objective 0.000
  iter 1/5  accepted objective 1.000 (6.3s)
  ~ bar.agency:main:prompt:
      - What is the capital of France?
      + What is the capital of India?
      The change focuses on directly addressing the goal of retrieving the capital of India by modifying the prompt to reflect…
  reached the maximum objective (1.000) — stopping early

== Optimized variables ==
  ~ bar.agency:main:prompt:
      - What is the capital of France?
      + What is the capital of India?

Complete: champion iteration 1, accepted 1, rejected 0, invalid 0 (10.0s)
Optimize demo-run completed: 1 accepted, 0 rejected
```

You can put `optimize` on any string `const` `let` to tell the the optimizer to rewrite it.

## Inputs, graders, optimizers

The `--goal` flag makes it really easy to get started with the optimizer, but gives you limited control. Now let's look at a more real-world example. But first I need to explain how the optimizer works.

The optimizer has three core things: inputs, graders, and the optimizer itself.

### Inputs
Inputs are examples you give to the optimizer. They are example input-output pairs.

For example, let's say we're optimizing this code:

```ts
node main(country) {
  // note prompt incorrectly says "area" instead of "capital"
  optimize const prompt = `What is the area of ${country}?`
  const response = llm(prompt)
  return response
}
```

It is very similar to the code we just saw, but now there's a `country` parameter for the node. We might give these inputs to the optimizer:

```
{
  "inputs": [
    { "args": { "country": "India" },  "expected": "New Delhi" },
    { "args": { "country": "Japan" },  "expected": "Tokyo" },
    { "args": { "country": "Brazil" }, "expected": "Brasília" }
  ]
}
```
  
Save this as inputs.json and run the optimizer again:

```
agency optimize foo.agency --goal 'Return the capital of India' --inputs inputs.json

```

This will run the optimizer the same as earlier, except now it also has three example inputs to look at. The optimizer will run foo.agency once for each input. That means it will run your agent, setting country to `"India"` for the first iteration, `"Japan"` for the second iteration etc, and look at the return value of the node.

You can optionally also provide other values:

```ts
export type Input = {
  /** Unique id. Generated for you if not given.*/
  id?: string;
  /** What the agent should accomplish — read by the goal judge and the
   *  pairwise judge suite. This is a per-input goal.*/
  goal?: string;
  /** Entry node to run. Defaults to `main`. */
  node?: string;
  /** Freeform, grader-agnostic metadata (tags, expectedOutput, …). */
  metadata?: Record<string, any>;
};
```

Notice that you can pass in a per-input goal, or an overall goal, as we have been doing with the `--goal` flag. You can pass in either one or both, but at least one goal is required. The `--goal` flag only fills in goals for inputs that don't have their own; they don't get combined. So if an input already has a goal, the `--goal` flag's value won't be used.

### Graders
So, we pass in an input, an expected output, and a goal to the optimizer. How does the optimizer measure the expected output? In our example with capitals, the expected output for India was `"New Delhi"`. What if the agent instead returned `"the capital of India is New Delhi"`? It's the job of the *grader* to decide how well the agent did. Let's look at some examples of graders.

#### ExactMatchGrader
Returns a binary pass-fail. Not the most useful grader, because it would give both of these the same score, which makes it hard for the optimizer to see if its changes to the agent are making any progress:

```
// these responses would get the same score:
response1 = "asdadasdasd"
response2 = "the capital of India is New Delhi"
```

#### ContainsGrader
Also returns a binary pass/fail like exact match, but this one checks to see if the expected output is anywhere in the response. Slightly better.

#### SimilarityGrader
Calculates the levenshtein distance and returns a score between 0 and 1 (0 = no match, 1 = perfect match).

#### LLM Judge
Asks an LLM to return a score between 0 and 1 (0 = no match, 1 = perfect match) for how well the response matches the goal — and, when an input sets `expected`, grades against that gold answer too (so `expected` tightens the default judge even without a custom grader).

This is the default grader.

### Custom graders

So far, we have just been using the LLM Judge, which is the default grader. But we can also specify a custom grader using the `--graders` flag.

First write a grader file:

```ts
// graders.ts
import { type Grader } from "agency-lang/optimize";

// `input` is the typed Input; the gold answer is at `input.expected`
// `output` is the actual response from your agent.
const exact: Grader = ({ output, input }) => {
   // return a number (0..1), a boolean, or a Grade
  return output === input.expected ? 1 : 0;
}

export default exact;
```

Use the grader:

```
agency optimize foo.agency --goal 'Return the capital of India' --graders graders.ts
```

That's a really simple example where we're writing a custom function to use as the grader. It's an exact match function which, as we know, isn't very good. We can easily change this though. Let's see some options.

We could call an LLM judge, passing it a custom judge prompt:

```ts
import { scalar, type Grader } from "agency-lang/optimize";
const judged: Grader = async ({ output, input, judge }) => {
  const v = await judge({ goal:
    `Hi this is my custom LLM judge prompt. The output should match this expected value: ${input.expected}.`,
    output
  });

  // Agency func to return a scalar score + reasoning for the score.
  // Generates something like:
  // 
  // ```
  // { score: { kind: "scalar", value: v.score }, feedback: v.reasoning }
  // ```
  return scalar(v.score, v.reasoning);   
};
```

We could use a built-in grader:

```ts
import { Contains } from "agency-lang/optimize";
export default (new Contains({}));
```

Instead of a single grader, we can also return an array of graders:

```ts
import { Contains, Grader, scalar } from "agency-lang/optimize";

const judged: Grader = async ({ output, input, judge }) => {
    const v = await judge({
        goal:
            `Hi this is my custom LLM judge prompt. The output should match this expected value: ${input.expected}.`,
        output
    });

    return scalar(v.score, v.reasoning);
};

export default [new Contains({}), judged];
```

Finally, you can use the `grader` function to wrap a custom function and supply some metadata:

```ts
// use the `exact` function as the grader.
// mustPass = if this grader fails, consider this entire iteration failed.
// name = shown in debug output.
const gate = grader(exact, { mustPass: true, name: "capital-exact" });
```

To recap:
- A grading module **default-exports one grader or an array of graders**. 
- A metric function returns a **number** (0..1 scalar), a **boolean** (1.0/0.0), or a full **Grade**. For a Grade with feedback, the `scalar(value, feedback?)` and `binary(pass, feedback?)` constructors are the ergonomic way to build one.

#### How grades become the objective
Every grade counts: a number contributes its value (0..1), and a boolean / `ExactMatch` / `Contains` result contributes `1.0` (pass) or `0.0` (fail) — so a binary-only grader gives you plain accuracy. The objective for an input is the weighted mean of its grades, and the run objective is the mean across inputs. `mustPass` is an orthogonal **gate**: a failed `mustPass` grader zeroes that input regardless of its other grades.

## Validation sets

Pass `--validation-inputs <file|dir>` to grade the champion against held-out inputs, or `--validation-split <ratio>` to hold out a seeded fraction of `--inputs`. Search and candidate acceptance run on the **training** inputs; the champion written back is the one with the best **validation** objective, and `report.md` shows train-vs-validation side by side so an overfit prompt (high train, flat validation) is visible. All built-in optimizers (`greedy`, `gepa`, `example`) select by validation. A custom optimizer that doesn't will say so in the report.

"select by validation" means: when you provide a held-out validation set (--validation-inputs or --validation-split), the optimizer doesn't blindly write back the candidate that scored best on the training inputs. Instead, after the search runs, each accepted candidate (plus the baseline) is re-scored on the held-out validation inputs, and the one with the best validation objective is the "champion" — that's what gets written to disk and reported as the final answer.

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

## Optimizers
Agency comes with two built-in optimizers, `greedy` and `gepa`. `greedy` is the default. You can specify the optimizer using the `--optimizer` flag. You can also write your own optimizers.

## Writing your own optimizer

`greedy`, `gepa`, and `example` are built on a shared `BaseOptimizer`, which you can extend. Write a module that default-exports a **factory** `(config) => Optimizer`, then point `--optimizer` (or `eval.optimize.optimizer`) at its path — exactly like `--graders`:

```ts
// myOptimizer.ts
import { BaseOptimizer, fileMap, type BaseOptimizerConfig, type Input, type OptimizeResult, type OptimizeTargetSet } from "agency-lang/optimize";

class MyOptimizer extends BaseOptimizer {
  readonly name = "mine";
  protected async optimizeTargets(source: OptimizeTargetSet, inputs: Input[]): Promise<OptimizeResult> {
    // search with this.scoreFiles / this.proposeValidMutation / this.evaluate …
  }
}

export default (config: BaseOptimizerConfig) => new MyOptimizer(config);
```

```bash
agency optimize foo.agency --inputs inputs.json --optimizer ./myOptimizer.ts
```

`--optimizer` takes either a **built-in name** (`greedy`, `gepa`, `example`) or a **path** (a value with a `/` or a `.ts`/`.js`/`.mjs` extension). The module is loaded the same way as a grading module (esbuild + import), and its result is used structurally as an `Optimizer` (`{ name, optimize }`). `example` (`lib/optimize/optimizers/example.ts`) is the minimal copy-paste template; the full authoring guide is in the repo at `docs/dev/writing-optimizers.md`.

## Notes

The CLI installs an approval handler for the internal `std::agency.run(...)` calls used by eval execution. The stdlib `agency.eval.optimize(...)` function does **not** install a handler; Agency callers should wrap it in their own handler when they want auto-approval.