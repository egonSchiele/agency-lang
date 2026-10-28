---
name: "workflow"
description: "Turn a workflow, a JSON list of steps, into an Agency program."
---

# workflow

When you want an agent to do the same task the same way every time, a
  skill is only a suggestion: the agent reads it and then decides what to
  do. A workflow is a list of steps, as JSON, where each step calls a tool
  or asks a model, and a later step's arguments can point at an earlier
  step's result with `{ "$ref": "steps.note[0].id" }`. It is as fixed as
  code and as easy to show a person as a skill.

  A workflow is a thin layer over Agency: anything that needs behavior is
  an Agency function the workflow calls. It is not a second language: it
  has tool steps, LLM steps, and references, and nothing else.

  ```ts
  import { compileWorkflow } from "std::workflow"
  import { searchNotes } from "./notes.agency"

  const source = compileWorkflow(workflow, [searchNotes], __dirname)
  print(source)
  ```

## Types

### WorkflowLimits

Caps on one run of a workflow: `maxCost` in dollars and `maxTime` in
  milliseconds. The generated program wraps its steps in a guard with them.

```ts
/** Caps on one run of a workflow: `maxCost` in dollars and `maxTime` in
  milliseconds. The generated program wraps its steps in a guard with them. */
export type WorkflowLimits = {
  maxCost?: number;
  maxTime?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L39))

### Workflow

A workflow: a name, a description, the inputs as an Agency object type
  written as text, and the steps. `result` is a reference or a literal; the
  last step's value is returned without it.

```ts
/** A workflow: a name, a description, the inputs as an Agency object type
  written as text, and the steps. `result` is a reference or a literal; the
  last step's value is returned without it. */
export type Workflow = {
  format: number;
  name: string;
  description: string;
  inputs: string;
  steps: Json[];
  result?: Json;
  limits?: WorkflowLimits
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L47))

### WorkflowProblem

One thing wrong with a workflow, named by step and field. `step` and
  `field` are null only for a problem with the whole workflow.

```ts
/** One thing wrong with a workflow, named by step and field. `step` and
  `field` are null only for a problem with the whole workflow. */
export type WorkflowProblem = {
  step?: string;
  field?: string;
  message: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L59))

### WorkflowFailure

The data a refused workflow fails with.

```ts
/** The data a refused workflow fails with. */
export type WorkflowFailure = {
  problems: WorkflowProblem[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L66))

## Functions

### compileWorkflow

```ts
compileWorkflow(
  workflow: Workflow,
  tools: any[],
  dir: string = "",
): Result<string, WorkflowFailure>
```

Generate the Agency source text of a workflow's program. This returns text, not a compiled program. A workflow that is malformed, names a tool not in the list, or points a reference forward fails with every problem, each naming its step and field. Reading a local tool's module asks for approval.

  @param workflow - The workflow to generate a program for
  @param tools - The functions the workflow may call. A step may only name one of these
  @param dir - The directory a workflow's local modules are named relative to

**Parameters:**

| Name | Type | Default |
|---|---|---|
| workflow | [Workflow](#workflow) |  |
| tools | `any[]` |  |
| dir | `string` | "" |

**Returns:** `Result<string, WorkflowFailure>`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L127))

### checkWorkflow

```ts
checkWorkflow(
  workflow: Workflow,
  tools: any[],
  dir: string = "",
): Result<WorkflowProblem[], WorkflowFailure>
```

Check a workflow without running it, and report every problem by step and field. A wrong argument name, a missing argument, a wrong type, or a path into a step's value that does not exist is a type error in the generated program, reported on the step and argument it came from. Succeeds with the warnings, such as a tool that declares no return type. Reading a local tool's module asks for approval.

  @param workflow - The workflow to check
  @param tools - The functions the workflow may call. A step may only name one of these
  @param dir - The directory a workflow's local modules are named relative to

**Parameters:**

| Name | Type | Default |
|---|---|---|
| workflow | [Workflow](#workflow) |  |
| tools | `any[]` |  |
| dir | `string` | "" |

**Returns:** `Result<WorkflowProblem[], WorkflowFailure>`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L143))
