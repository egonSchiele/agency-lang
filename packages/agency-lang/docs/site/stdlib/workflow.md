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
  import { checkWorkflow, runWorkflow } from "std::workflow"
  import { searchNotes } from "./notes.agency"

  const problems = checkWorkflow(workflow, [searchNotes], __dirname)
  const result = runWorkflow(workflow, { noteTitle: "Groceries" }, [searchNotes], __dirname)
  ```

  `runWorkflow` checks the workflow, asks with `std::workflow::run`, and
  runs the program in a subprocess. Each step's interrupts reach the
  caller's handlers, so a policy decides what the workflow may do.

  `writeWorkflow` saves a checked workflow into a project directory as
  `<dir>/<name>/workflow.json` and `meta.json`; `loadWorkflow` and
  `listWorkflows` read them back.

## Types

### WorkflowLimits

Caps on one run of a workflow, or on one step: `maxCost` in dollars and
  `maxTime` in milliseconds, each a positive number. The generated program
  wraps the whole body, or that step, in a guard with them.

```ts
/** Caps on one run of a workflow, or on one step: `maxCost` in dollars and
  `maxTime` in milliseconds, each a positive number. The generated program
  wraps the whole body, or that step, in a guard with them. */
export type WorkflowLimits = {
  maxCost?: number;
  maxTime?: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L57))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L65))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L77))

### WorkflowFailure

The data a refused workflow fails with.

```ts
/** The data a refused workflow fails with. */
export type WorkflowFailure = {
  problems: WorkflowProblem[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L84))

### WorkflowMeta

What `meta.json` records about a saved workflow.

```ts
/** What `meta.json` records about a saved workflow. */
export type WorkflowMeta = {
  createdAt: string;
  createdBy: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L283))

### WorkflowEntry

A saved workflow: its name, its folder, the workflow, and its meta.json record.

```ts
/** A saved workflow: its name, its folder, the workflow, and its meta.json record. */
export type WorkflowEntry = {
  name: string;
  dir: string;
  workflow: Workflow;
  meta: WorkflowMeta
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L289))

## Effects

### std::workflow::run

```ts
@alwaysUnder(dir)
@always(name)
effect std::workflow::run {
  name: string;
  dir: string;
  inputs: Json
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L121))

### std::workflow::scan

```ts
@alwaysUnder(dir)
effect std::workflow::scan {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L311))

### std::workflow::save

```ts
@alwaysUnder(dir)
@always(name)
effect std::workflow::save {
  dir: string;
  name: string;
  workflow: Workflow
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L321))

## Functions

### compileWorkflow

```ts
compileWorkflow(
  workflow: Workflow,
  tools: any[],
  dir: string = "",
): Result<string, WorkflowFailure>
```

Generate the Agency source of a workflow's program. A malformed workflow fails with every problem, each naming its step and field.

  @param workflow - The workflow to generate a program for
  @param tools - The functions the workflow may call. A step may only name one of these
  @param dir - The directory a workflow's local modules are named relative to

The source is text, not a compiled program: hand it to `compile` or
  `typecheck` from `std::agency`, or to `checkWorkflow`, which does both and
  maps each error back to its step. Reading a local tool's module raises
  `std::read`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| workflow | [Workflow](#workflow) |  |
| tools | `any[]` |  |
| dir | `string` | "" |

**Returns:** `Result<string, WorkflowFailure>`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L176))

### checkWorkflow

```ts
checkWorkflow(
  workflow: Workflow,
  tools: any[],
  dir: string = "",
): Result<WorkflowProblem[], WorkflowFailure>
```

Check a workflow without running it. Fails with every problem, each naming its step and field; succeeds with the warnings, such as a tool that declares no return type.

  @param workflow - The workflow to check
  @param tools - The functions the workflow may call. A step may only name one of these
  @param dir - The directory a workflow's local modules are named relative to

Every problem the generator and the typechecker can find, in one pass,
  so an author fixes them together. A wrong argument name, a missing
  argument, a wrong type, or a path into a step's value that does not exist
  is a type error in the generated program, reported on the step and field
  it came from. Reading a local tool's module raises `std::read`.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| workflow | [Workflow](#workflow) |  |
| tools | `any[]` |  |
| dir | `string` | "" |

**Returns:** `Result<WorkflowProblem[], WorkflowFailure>`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L228))

### runWorkflow

```ts
runWorkflow(
  workflow: Workflow,
  inputs: Json,
  tools: any[],
  dir: string = "",
): Result<Json>
```

Run a workflow: check it, ask to run it, and run its program in a subprocess.

  @param workflow - The workflow to run
  @param inputs - The workflow's inputs, a value of its `inputs` type
  @param tools - The functions the workflow may call. A step may only name one of these
  @param dir - The directory a workflow's local modules are named relative to. Resolved to an absolute path, which is what an "always" answer to `std::workflow::run` pins, along with the workflow's name

Check, ask, run. The check compiles the program and the run uses it. The
  prompt comes after the check, so a workflow with problems asks nothing,
  and before `run`, so a rejection starts no process. `run` raises its own
  `std::run`. The subprocess wall clock is the workflow's `maxTime` plus 30
  seconds, or `run`'s default. The node's `Result` comes back as the data
  of `run`'s envelope; its failure names the step that stopped the workflow.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| workflow | [Workflow](#workflow) |  |
| inputs | [Json](validation.md#json) |  |
| tools | `any[]` |  |
| dir | `string` | "" |

**Returns:** `Result<Json>`

**Throws:** `std::workflow::run`, `std::run`, `std::guard`, `std::read`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L250))

### writeWorkflow

```ts
writeWorkflow(
  workflow: Workflow,
  tools: any[],
  dir: string,
): Result<WorkflowEntry>
```

Save a workflow into a project directory, as `<dir>/<name>/workflow.json` and `meta.json`, after the full check and one `std::workflow::save` prompt. A workflow with problems is not saved and asks nothing. Saving a name that exists replaces it.

  @param workflow - The workflow to save. Its `name` names the folder
  @param tools - The functions the workflow may call, for the check
  @param dir - The project directory, which must exist: the workflow is saved under it, and a local tool's file must be under it too, since the saved workflow imports the tool by a path relative to it

**Parameters:**

| Name | Type | Default |
|---|---|---|
| workflow | [Workflow](#workflow) |  |
| tools | `any[]` |  |
| dir | `string` |  |

**Returns:** `Result<WorkflowEntry>`

**Throws:** `std::workflow::save`, `std::read`

**Needs:** `fileRead`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L340))

### loadWorkflow

```ts
loadWorkflow(name: string, dir: string): Result<WorkflowEntry>
```

Load a saved workflow by name from a project directory. Raises one `std::workflow::scan` prompt for the workflow's folder before reading it, and nothing else.

  @param name - The workflow's name, which is its folder under `dir`
  @param dir - The project directory the workflow was saved under

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| dir | `string` |  |

**Returns:** `Result<WorkflowEntry>`

**Throws:** `std::workflow::scan`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L466))

### listWorkflows

```ts
listWorkflows(dir: string): Result<WorkflowEntry[]>
```

List the workflows saved in a project directory. Raises one `std::workflow::scan` prompt before reading anything, and nothing else. A directory that does not exist has no workflows. A folder whose files cannot be read fails the listing, with a message naming the folder.

  @param dir - The project directory the workflows were saved under

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `Result<WorkflowEntry[]>`

**Throws:** `std::workflow::scan`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L504))
