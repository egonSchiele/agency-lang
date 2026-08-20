# Eval Basics

Evals are a useful but complex topic. I'll take it step by step.

## Run an agent

Example agent:

```ts
node main() {
  const response = llm("What is Einstein's birthday?")
  print(response)
  return response
}
```

Run it:

```bash
agency eval run test.agency
```

Will print something like:

```
run dir: /Users/adit/runs/foo
Albert Einstein was born on March 14, 1879.
[input-1] success in 3s
Run 2026-08-18-191911-rAGQlU completed: 1/1 tests ok
total LLM cost: $0.00
/Users/adit/runs/foo
```

Note the run id is `2026-08-18-191911-rAGQlU`. You can pass in a specific run id:

```bash
agency eval run test.agency --out foob
```

Now it will put the results in the dir `foob/`.

## What does the run dir contain?

Everyone's dying to know, so dish the dirt!

- `statelog.jsonl` - Statelog logs for the run
- `annotations.jsonl` - Grader results, for when you run the grader
- `code/` - Code used for the run, so we can reproduce if needed
- `graders/` - The grading code the run was set up with (only when the test has a grading module), so the run grades the same later even if you edit the graders or copy the directory elsewhere
- `workdir/` and `workdir.json` - Any other relevant files: for example, agency.json for config, and any files that the agents may have created.

## The run directory

You'll see that all of these files aren't in

```
runs/foo/
```

They're actually in

```
runs/foo/input-1/
```

This is because the `eval run` command lets you run the agent over several different inputs in parallel. Each input gets its own run directory under `runs/foo`.

Note that you have just run an agent. You have not evaluated anything yet. Each time you run an agent using `eval run`, it will create a directory for the run, like the one at `runs/foo/input-1`. This is called a **run directory**. The run directory is the unit that we use for everything else connected with evals and optimization.

## Grading
Now that you have a run, we can create it. The simplest way to grade is to use LLM as a judge with the `--goal` flag:

```bash
agency eval grade runs/foo --goal "returns einsteins bday"
```

This will add something to the annotations file in `input-1/annotations.jsonl` that looks like the following:

```json
+{"v":1,"id":"ann_xyz","traceId":"<trace-id>","createdAt":"2026-08-19T17:39:56.105Z","annotator":{"kind":"judge","id":"goal-judge@1"},"kind":"score","passId":"pass_xvh","passSize":1,"name":"goal","score":{"kind":"scalar","value":1},"weight":1,"mustPass":false,"feedback":"The agent output provides a direct and accurate answer to the goal, stating Albert Einstein's birth date correctly as March 14, 1879, which fully satisfies the requirement.","goal":"returns einsteins bday"}
```

Here we gave it the parent directory (`runs/foo/`). We could also give it the path to a single run directory:

```bash
agency eval grade runs/foo/input-1 --goal "returns einsteins bday"
```

## Suites

Here I have been showing you the building blocks for evals. In reality, you wouldn't grade a run by passing the goal on the command line. In reality, you would have an eval suite that you would use to grade an agent.

Lets make a new suite:

```json
{
  "inputs": [
    {
      "id": "einstein",
      "input": {},
      "goal": "returns Einstein's birthday",
      "expected": "March 14, 1879"
    }
  ]
}
```

Now we can run and grade it:

```bash
agency eval run test.agency --suite inputs.json --out runs/einstein
agency eval grade runs/einstein
```

Pretty suite, eh?

Note that you don't need both "goal" and "expected", you only need one. By default, the grader is going to use LLM as a judge, and it will use both if both are provided. So you don't need both but it can be nice to provide both just to give the LLM judge more information.

## List runs

As we have already seen, the grader will add its grade to annotations.jsonl. You can get a nice view of all the grades using:

```
agency runs list
```

This will show a list of all the runs and their scores. Note that if you have graded a run multiple times, it will only show the score from the last time it was graded. It will also print the mean of all the scores. This again uses the last score if there are multiple scores for one run.

