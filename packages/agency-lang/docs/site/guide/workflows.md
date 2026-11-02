---
name: Workflows
description: Define reusable sequences of function and LLM calls as JSON, check and run them, and offer saved workflows as tools.
---

# Workflows

A workflow is a sequence of steps written as JSON. Each step calls an Agency
function or asks an LLM for a typed response. Later steps can use earlier results.
Agency checks the sequence, compiles it into an Agency program, and runs it.

Use a workflow when you want to repeat a known sequence with different inputs.
For example, a workflow could find a note, ask an LLM to extract its shopping
list, and call a function that adds the items to a task list. The steps stay in
the order you wrote, even when one of them asks an LLM for help.

Workflows support function calls, LLM calls, and references to values. Put
branches, loops, retries, or other behavior in an Agency function, then call
that function from a step.

## Your first workflow

This example adds two numbers and doubles the sum. It makes no LLM calls.
Start in a project where you have [installed Agency](/guide/getting-started).
You can inspect the functions available in a module:

```bash
agency workflow tools std::math
```

The catalog shows each function's parameters, return type, and effects. For
this example, we need `add(a, b)` and `multiply(a, b)`.

Create a `workflows` folder in your project. Save this as
`workflows/doubleSum.json`:

```json
{
  "workflow": {
    "format": 1,
    "name": "doubleSum",
    "description": "Add two numbers and double the sum.",
    "inputs": "{ a: number; b: number }",
    "steps": [
      {
        "id": "sum",
        "kind": "tool",
        "module": "std::math",
        "tool": "add",
        "args": {
          "a": { "$ref": "inputs.a" },
          "b": { "$ref": "inputs.b" }
        }
      },
      {
        "id": "doubled",
        "kind": "tool",
        "module": "std::math",
        "tool": "multiply",
        "args": {
          "a": { "$ref": "steps.sum" },
          "b": 2
        }
      }
    ],
    "result": { "$ref": "steps.doubled" }
  }
}
```

The outer `workflow` field is the saved-file format. The object inside it is
the workflow itself. Its name must match the filename without `.json`.

`inputs` declares an Agency object type as text. Here, callers must supply two
numbers. Each step has a unique `id`. A `tool` step names the function's module,
the function, and its arguments. In Agency, functions are tools.

Run these commands from the project directory:

```bash
agency workflow check doubleSum
agency workflow run doubleSum --inputs '{"a": 2, "b": 3}'
```

The check reports no problems. The run prints `10`.

The workflow runs its steps in order. `sum` adds the two inputs, then `doubled`
multiplies that result by `2`. The `result` field chooses what the workflow
returns. If you leave it out, the workflow returns the last step's value.

You can also inspect the generated Agency program or list saved workflows:

```bash
agency workflow compile doubleSum
agency workflow list
```

A bare name looks in the current directory's `workflows` folder. You can also
pass a path such as `./my-project/workflows/doubleSum.json`. The directory
containing `workflows` is the project directory.

## Passing values between steps

```json
{
  "noteId": { "$ref": "steps.notes[0].id" },
  "title": { "$ref": "inputs.title" },
  "tags": ["shopping", { "$ref": "inputs.category" }]
}
```

This argument object combines literal values and references. References work
in a tool step's `args`, an LLM step's `context`, and the workflow's `result`.
You can nest them in objects and arrays.

| Reference | Value |
| --- | --- |
| `inputs.title` | The `title` input. |
| `steps.notes` | The value returned by the earlier `notes` step. |
| `steps.notes[0].id` | The first item's `id` in that value. |

A step can refer to inputs and earlier steps. A reference to itself or a later
step fails the check. Paths support property names and numeric array indexes.
They do not evaluate expressions.

If a function returns `Result<Note>`, use `steps.note.body` to read the successful
note's `body`. Agency unwraps the `Result` for you. If a tool step returns a
failure, the workflow stops and returns a failure naming that step.

You can choose a result assembled from several values:

```json
"result": {
  "sum": { "$ref": "steps.sum" },
  "doubled": { "$ref": "steps.doubled" }
}
```

## Adding an LLM step

Append this object to the first example's `steps` array:

```json
{
  "id": "explain",
  "kind": "llm",
  "prompt": "Explain how adding the two inputs and doubling their sum gives the result. Use one short sentence.",
  "context": [
    { "$ref": "inputs.a" },
    { "$ref": "inputs.b" },
    { "$ref": "steps.doubled" }
  ],
  "output": "{ explanation: string }"
}
```

Then change the workflow's result:

```json
"result": { "$ref": "steps.explain.explanation" }
```

`output` is an Agency type written as text. It sets the shape of the model's
response. Here, the response has an `explanation` string. Other examples include
`"string[]"` or `"{ title: string; items: string[] }"`.

The model receives the prompt followed by the context values, each with a
label. Strings keep their text, and other values become JSON. Prompt text is
literal: put changing values in `context` rather than trying to interpolate
references into the prompt. Include `context: []` when there is no context.

Each LLM step has its own conversation thread and receives no tools. It uses
the configured model unless you set the step's optional `model` and `provider`
fields. Running this version requires a configured model provider; see
[LLM calls](/guide/llm).

## Calling your own functions

Save this function in `tools.agency` in the project directory:

```ts
export def greet(name: string): string {
  return "Hello, ${name}!"
}
```

A workflow with `inputs: "{ name: string }"` can call it with this step:

```json
{
  "id": "greeting",
  "kind": "tool",
  "module": "./tools.agency",
  "tool": "greet",
  "args": { "name": { "$ref": "inputs.name" } }
}
```

Local module paths are relative to the project directory, not the `workflows`
folder. Inspect a local module with `agency workflow tools ./tools.agency`.

Declare parameter and return types so the workflow checker can check values
passed between functions. The checker reports problems with a step and field,
such as `step greeting, args.name`. A warning about an untyped return value
means that part of a reference can only be checked when the workflow runs.

Workflow programs compile in Agency's sandbox. Local modules and their imports
must stay inside the project directory. They may import other `.agency` files
and `std::` modules. JavaScript, TypeScript, `pkg::` imports, symlinks, and
compile-time splices are refused.

## Approvals and effects

```bash
agency workflow check myWorkflow
agency workflow run myWorkflow --inputs '{}' --policy ./policy.json
```

The check lists the effects each step can raise. When you run from the CLI,
Agency asks once about effects your policy does not cover. Answering yes
approves those effects for the whole run, with any interrupt data. Use a
[policy](/guide/policies) when approval should depend on a filename, directory,
or another value.

For example, a policy that approves reads from one directory counts as covering
`std::read`. The CLI does not ask about reads again. A read that matches no
approval rule is rejected. In a noninteractive process, uncovered effects stop
the run; cover them with `--policy`, `--approve`, or `--reject`.

The CLI handles the approvals needed to load and start the workflow. Your
policy can still reject those operations. See the
[workflow command reference](/cli/workflow#how-the-run-s-policy-is-built) for
the full rules.

### Declaring allowed effects

You can add a `raises` field to the workflow:

```json
"raises": ["FileRead", "std::write"]
```

The checker reports a problem when a tool step declares an effect outside this
list. Built-in [effect sets](/guide/effects-and-raises) such as `FileRead` expand
to their members. Set `raises` to `[]` to allow no reported tool effects. Omit
it, or use `["*"]`, to allow any.

This is a static check of the steps' effects. It excludes `std::guard` and the
effects used to load and start the workflow. It does not approve interrupts,
and static analysis can miss effects. Handlers and policies still decide
whether an action may run.

## Setting limits

Add limits to the workflow to cap its time and model spending:

```json
"limits": { "maxTime": 300000, "maxCost": 1 }
```

`maxTime` is in milliseconds, so this allows five minutes. `maxCost` is in
dollars. Both must be positive numbers. You can also add `limits` to an
individual step.

A step's limit cannot exceed the corresponding workflow limit. A step with
`maxTime` also needs a workflow-level `maxTime`. The workflow and step limits
are hard limits: a handler cannot extend them by approving a guard trip. See
[guards](/guide/guards) for how Agency measures time and cost.

## Using workflows from Agency

Keep the original two-step `doubleSum.json` for the following examples. Save
this program as `host.agency` beside the `workflows` folder:

```ts
import { loadWorkflow, checkWorkflow, runWorkflow } from "std::workflow"
import { add, multiply } from "std::math"

node main(): Result {
  const tools = [add, multiply]
  const entry = loadWorkflow("doubleSum", __dirname)?
  const warnings = checkWorkflow(entry.workflow, tools, __dirname)?
  printJSON(warnings)
  return runWorkflow(entry.workflow, { a: 2, b: 3 }, tools, __dirname)
}
```

Run it with interactive approval:

```bash
agency run --interactive host.agency
```

`loadWorkflow` returns a saved entry. Pass its `workflow` field to the workflow
functions. `checkWorkflow` returns a `Result` containing warnings on success.
On failure, `data.problems` contains the problems with their step, field, and
message. `runWorkflow` checks again before running, so a separate check is
useful when you want to inspect warnings ahead of time.

The `tools` argument lists the functions this workflow may call. Each function
must be an original, importable Agency definition. Partially applied or renamed
functions and tools made with `createTool` are refused. Pass a project directory
that contains any local functions the workflow uses.

The APIs raise interrupts for their operations. Loading raises
`std::workflow::scan`. Checking reads local tool modules with `std::read`.
Running asks with `std::workflow::run`, then `std::run` to start the subprocess.
The workflow's own interrupts reach the caller's handlers too.

You can answer these with [handlers](/guide/handlers) or a policy. When an
interrupt from a workflow step needs an interactive response, Agency checkpoints
the subprocess and resumes it after the response. Unlike this host program,
`agency workflow run` does not support interactive pause and resume during the
steps.

`compileWorkflow(workflow, tools, dir)` returns generated Agency source without
the full typecheck. Use `checkWorkflow` to validate it. Use
`catalog(tools, dir)` to get the function catalog as data when building an
editor or an agent that writes workflows.

## Saving workflows and offering them as tools

Save this as `save.agency` beside `host.agency`:

```ts
import { loadWorkflow, writeWorkflow } from "std::workflow"
import { add, multiply } from "std::math"

node main(): Result {
  const entry = loadWorkflow("doubleSum", __dirname)?
  return writeWorkflow(entry.workflow, [add, multiply], __dirname)
}
```

```bash
agency run --interactive save.agency
```

`writeWorkflow` checks the workflow and saves it to
`<dir>/workflows/<name>.json`. Saving an existing name replaces that file.
It asks with `std::workflow::save`, then `std::run` to derive the inputs schema
without running the steps. The file contains the workflow and a `meta` record
with the save time, writer, and inputs schema.

`loadWorkflow(name, dir)` loads one entry. `listWorkflows(dir)` loads the saved
entries in name order. Both ask with `std::workflow::scan` before reading saved
files. A project with no `workflows` folder lists no workflows. An invalid saved
file fails the listing with a message naming the file.

After saving, you can offer the workflows to a model. Save this as
`assistant.agency` in the same directory:

```ts
import { workflowTools } from "std::workflow"
import { add, multiply } from "std::math"

node main(): Result<string> {
  const tools = workflowTools(__dirname, [add, multiply])?
  const answer: string = llm("Use doubleSum with a = 2 and b = 3.", tools: tools)
  return success(answer)
}
```

```bash
agency run --interactive assistant.agency
```

The model sees one tool named `doubleSum`, with the workflow's description.
Its call arguments have the shape `{ "inputs": { "a": 2, "b": 3 } }`.
Calling it checks and runs the workflow with the usual approvals.

`workflowTools` uses the schemas saved by `writeWorkflow`. A hand-written file
without that metadata can run through the CLI, but must be saved with
`writeWorkflow` before `workflowTools` can use it. Loading the tools does not
check their steps against the supplied functions; each call performs that check.

To expose one workflow already in memory, use
`workflowTool(workflow, tools, dir)` instead. It checks the workflow and derives
the inputs schema immediately. Workflow names must not clash with names in
the supplied functions.

See [`std::workflow`](/stdlib/workflow) for the API reference and
[`agency workflow`](/cli/workflow) for command options.
