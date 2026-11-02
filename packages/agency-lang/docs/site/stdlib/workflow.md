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

  A workflow's `limits` are hard: the program rejects a trip from its own
  guards, so no caller can give it more budget. A tool's own guard is left
  to the tool, so a tool that uses `supervise()` keeps working, unless the
  caller's policy rejects `std::guard`, as the catch-all in
  `agency workflow run` does. A workflow's optional `raises` lists the
  effects it may raise, and `checkWorkflow` reports each step that raises
  another.

  `writeWorkflow` saves a checked workflow as `<dir>/workflows/<name>.json`;
  `loadWorkflow` and `listWorkflows` read saved workflows back.
  `workflowTool` makes a workflow one tool a model can call, and
  `workflowTools` makes one per saved workflow.

  `catalog` lists the tools a workflow may call, with their parameters,
  return types, and effects, for a GUI or a person writing a workflow.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L70))

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
  limits?: WorkflowLimits;
  /** The effects the workflow may raise, as in an Agency function's `raises` clause (docs/site/guide/effects-and-raises.md). Left out means anything. `[]` means nothing. A built-in set name such as `FileRead` stands for its members, and `"*"` means anything. `checkWorkflow` reports each step that raises an effect not listed. */
  raises?: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L78))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L92))

### WorkflowFailure

The data a refused workflow fails with.

```ts
/** The data a refused workflow fails with. */
export type WorkflowFailure = {
  problems: WorkflowProblem[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L99))

### CatalogParam

One parameter a workflow step can pass to a tool.

```ts
/** One parameter a workflow step can pass to a tool. */
export type CatalogParam = {
  name: string;
  /** The declared type as Agency text, such as `string[]` or `Note`. Null when none is declared. */
  type?: string;
  /** The default as Agency source, such as `0` or `null`. Null when the parameter has none, so a step must pass a value. */
  default?: string;
  /** The text of the docstring's `@param` entry for this parameter, or null. */
  description?: string;
  /** The JSON Schema a model sees for this parameter. */
  schema: Json
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L273))

### CatalogEntry

One tool a workflow may call.

```ts
/** One tool a workflow may call. */
export type CatalogEntry = {
  /** What a step's `module` field says: `std::math`, or `./notes.agency` relative to `dir`. */
  module: string;
  name: string;
  /** The docstring without its `@param` entries, or the empty string. */
  description: string;
  /** The parameters a step can pass. A function-typed parameter is left out. */
  params: CatalogParam[];
  /** The declared return type as Agency text. Null when none is declared. */
  returns?: string;
  /** What the tool can raise, as `describe` reports it. A tool that uses `guard` lists `std::guard`. `checkWorkflow`'s `raises` check leaves it out, since a guard trip is a question about budget, not a permission. */
  effects: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L286))

### WorkflowMeta

What a saved workflow's file records beside the workflow.

```ts
/** What a saved workflow's file records beside the workflow. */
export type WorkflowMeta = {
  /** When the workflow was last saved, as ISO text. */
  savedAt: string;
  /** What saved it, such as `writeWorkflow`. */
  savedBy: string;
  /** The JSON Schema of the workflow's `inputs` type, from the program's
    own `inputsSchema` node at save time; null for a workflow saved before
    schemas were recorded. */
  inputsSchema?: Json
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L442))

### WorkflowEntry

A saved workflow: its name, the file it is saved in, the workflow, and
  the record saved with it.

```ts
/** A saved workflow: its name, the file it is saved in, the workflow, and
  the record saved with it. */
export type WorkflowEntry = {
  name: string;
  path: string;
  workflow: Workflow;
  meta: WorkflowMeta
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L455))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L136))

### std::workflow::scan

Raised before saved workflows are read. `dir` is the real path of the
  project's `workflows` folder, and an "always" answer pins that folder.

```ts
/** Raised before saved workflows are read. `dir` is the real path of the
  project's `workflows` folder, and an "always" answer pins that folder. */
@alwaysUnder(dir)
effect std::workflow::scan {
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L484))

### std::workflow::save

Raised once before a workflow is saved, after its check passes. `dir`
  is the real path of the project's `workflows` folder. Saving a name that
  exists replaces that workflow, so an "always" answer pins the name as
  well as the folder.

```ts
/** Raised once before a workflow is saved, after its check passes. `dir`
  is the real path of the project's `workflows` folder. Saving a name that
  exists replaces that workflow, so an "always" answer pins the name as
  well as the folder. */
@alwaysUnder(dir)
@always(name)
effect std::workflow::save {
  dir: string;
  name: string;
  workflow: Workflow
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L494))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L205))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L257))

### catalog

```ts
catalog(tools: any[], dir: string = ""): Result<CatalogEntry[]>
```

List the tools a workflow may call, in the order given: each tool's module and name as a step names them, its description, its parameters with their types, defaults, descriptions, and JSON Schemas, and its return type. Reading a local tool's module raises `std::read`. A refused tool list fails with every problem in `data.problems`, as `checkWorkflow` does. A refused or failed read of a module fails with the read's own failure, which has no problems.

  @param tools - The functions the workflow may call
  @param dir - The directory a workflow's local modules are named relative to

The catalog starts with the same two steps as `checkWorkflow`, so it
  refuses the same tool lists and raises the same `std::read` prompts.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| tools | `any[]` |  |
| dir | `string` | "" |

**Returns:** `Result<CatalogEntry[]>`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L303))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L329))

### workflowTool

```ts
workflowTool(workflow: Workflow, tools: any[], dir: string = ""): Result
```

Make one tool that runs a workflow when called. The tool has the workflow's name and description, and its one parameter, `inputs`, has the workflow's inputs type. Refuses a workflow named like one of `tools` before anything else, since a model cannot be handed both; the tool loop still refuses a name clash with any other tool at the model call. Then checks the workflow and runs its program's `inputsSchema` node once in a subprocess, which raises `std::run`. A workflow with problems fails with every problem and starts nothing.

  @param workflow - The workflow the tool runs
  @param tools - The functions the workflow may call
  @param dir - The directory a workflow's local modules are named relative to

**Parameters:**

| Name | Type | Default |
|---|---|---|
| workflow | [Workflow](#workflow) |  |
| tools | `any[]` |  |
| dir | `string` | "" |

**Returns:** `Result`

**Throws:** `std::run`, `std::guard`, `std::read`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L377))

### workflowTools

```ts
workflowTools(dir: string, tools: any[]): Result<any[]>
```

One tool per workflow saved under a project directory, in name order, each built as `workflowTool` builds it, from the inputs schema saved with the workflow. Starts no subprocess, and does not check a saved workflow against `tools`: a workflow whose tools changed since it was saved fails when it is called, with the problems listed, and starts nothing. Raises one `std::workflow::scan` prompt, or none for a project with no `workflows` folder. Refuses a workflow whose name is already a tool's name in `tools`, and one saved before inputs schemas were recorded.

  @param dir - The project directory the workflows were saved under
  @param tools - The functions the workflows may call. A workflow may not share a name with one of them

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |
| tools | `any[]` |  |

**Returns:** `Result<any[]>`

**Throws:** `std::workflow::scan`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L414))

### writeWorkflow

```ts
writeWorkflow(
  workflow: Workflow,
  tools: any[],
  dir: string,
): Result<WorkflowEntry>
```

Save a workflow as `<dir>/workflows/<name>.json`, after the full check and one `std::workflow::save` prompt. It then runs the program's `inputsSchema` node once in a subprocess, which raises `std::run`, and saves the schema with the workflow. A workflow with problems is not saved and asks nothing. Saving a name that exists replaces it.

  @param workflow - The workflow to save. Its `name` names the file
  @param tools - The functions the workflow may call, for the check
  @param dir - The project directory, which must exist. A local tool's file must be under it, since the workflow imports the tool by a path relative to it

**Parameters:**

| Name | Type | Default |
|---|---|---|
| workflow | [Workflow](#workflow) |  |
| tools | `any[]` |  |
| dir | `string` |  |

**Returns:** `Result<WorkflowEntry>`

**Throws:** `std::workflow::save`, `std::run`, `std::guard`, `std::read`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L527))

### loadWorkflow

```ts
loadWorkflow(name: string, dir: string): Result<WorkflowEntry>
```

Load a saved workflow by name. Raises one `std::workflow::scan` prompt before reading it, and nothing else.

  @param name - The workflow's name
  @param dir - The project directory the workflow was saved under

**Parameters:**

| Name | Type | Default |
|---|---|---|
| name | `string` |  |
| dir | `string` |  |

**Returns:** `Result<WorkflowEntry>`

**Throws:** `std::workflow::scan`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L632))

### listWorkflows

```ts
listWorkflows(dir: string): Result<WorkflowEntry[]>
```

List the workflows saved under a project directory, in name order. Raises one `std::workflow::scan` prompt before reading anything, and nothing else. A project with no saved workflows lists none. A file that cannot be read as a saved workflow fails the listing, with a message naming it.

  @param dir - The project directory the workflows were saved under

**Parameters:**

| Name | Type | Default |
|---|---|---|
| dir | `string` |  |

**Returns:** `Result<WorkflowEntry[]>`

**Throws:** `std::workflow::scan`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L670))
