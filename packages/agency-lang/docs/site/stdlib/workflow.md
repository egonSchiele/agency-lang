---
name: "workflow"
description: "Check, run, and save workflows described as JSON steps."
---

# workflow

Use a workflow when an agent should do the same task the same way every
time. A skill is a set of instructions that the agent reads and then decides
how to follow. A workflow is a fixed list of steps, so it runs the same way
on every call, and a person can still read it as easily as a skill.

A workflow has tool steps, LLM steps, and references from one step to an
earlier step's result. Anything else belongs in an Agency function that a
tool step calls.

```ts
import { add } from "std::math"
import { runWorkflow, Workflow } from "std::workflow"

node main() {
  const workflow: Workflow = {
    format: 1,
    name: "sum",
    description: "Add two numbers.",
    inputs: "{ a: number; b: number }",
    steps: [{
      id: "total",
      kind: "tool",
      module: "std::math",
      tool: "add",
      args: { a: { "$ref": "inputs.a" }, b: { "$ref": "inputs.b" } }
    }]
  }
  return runWorkflow(workflow, { a: 2, b: 3 }, [add])
}
```

Each step calls a supplied tool or asks a model. References can read inputs
or earlier step results. `checkWorkflow` checks the generated Agency program
without running the workflow. `runWorkflow` checks, requests approval, and
runs it in a subprocess whose interrupts reach the caller's handlers.

Pass original exported Agency functions as tools. Renamed, partially applied,
runtime-built, and package tools cannot be imported into a workflow. Local
tool files must be under `dir`.

Use `writeWorkflow` to save under `<dir>/workflows`, then `loadWorkflow` or
`listWorkflows` to read saved workflows. `workflowTool` and `workflowTools`
expose workflows as tools for an LLM. `catalog` describes available tool
parameters, return types, and effects for workflow authors.

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L80))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L88))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L102))

### WorkflowFailure

The data a refused workflow fails with.

```ts
/** The data a refused workflow fails with. */
export type WorkflowFailure = {
  problems: WorkflowProblem[]
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L109))

### CheckedWorkflow

What `checkWorkflowWithSchemas` reports for a workflow that passed.

```ts
/** What `checkWorkflowWithSchemas` reports for a workflow that passed. */
export type CheckedWorkflow = {
  /** What the check could not settle until the workflow runs. */
  warnings: WorkflowProblem[];
  /** The JSON Schema of the workflow's `inputs` type, in the input form: an input with a default is optional. */
  inputsSchema: Json;
  /** The JSON Schema of each LLM step's `output` type, by step id. Tool steps are not here. */
  outputSchemas: Record<string, Json>
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L268))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L305))

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
  effects: string[];
  /** True for a `handoff def`, so a picker can tell an agent from a function. A step calls it like any tool. */
  handoff: boolean
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L318))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L478))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L491))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L145))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L520))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L530))

## Functions

### compileWorkflow

```ts
compileWorkflow(
  workflow: Workflow,
  tools: any[],
  dir: string = "",
): Result<string, WorkflowFailure>
```

Generate Agency source for a workflow without running it.
  Failures identify the step and field with a problem.

Use the generated source to inspect what a workflow will do, or pass it to
`compile` or `typecheck` from `std::agency`. Use `checkWorkflow` to run both
checks and report diagnostics against the workflow's steps and fields.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| workflow | [Workflow](#workflow) |  |  |
| tools | `any[]` |  | Original exported Agency functions available to the workflow's steps. |
| dir | `string` | "" | Directory containing any local tool modules and resolving their paths. |

**Returns:** `Result<string, WorkflowFailure>`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L208))

### checkWorkflow

```ts
checkWorkflow(
  workflow: Workflow,
  tools: any[],
  dir: string = "",
): Result<WorkflowProblem[], WorkflowFailure>
```

Check a workflow without executing its steps, returning warnings on success.

Use this before presenting or saving a workflow. Errors identify their step
and field. Success contains warnings for values that cannot be fully checked
until runtime, such as references into a tool result with no declared type.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| workflow | [Workflow](#workflow) |  |  |
| tools | `any[]` |  | Original exported Agency functions available to the workflow's steps. |
| dir | `string` | "" | Directory containing any local tool modules and resolving their paths. |

**Returns:** `Result<WorkflowProblem[], WorkflowFailure>`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L256))

### checkWorkflowWithSchemas

```ts
checkWorkflowWithSchemas(
  workflow: Workflow,
  tools: any[],
  dir: string = "",
): Result<CheckedWorkflow, WorkflowFailure>
```

Check a workflow and return its warnings with the JSON Schemas of its inputs and of each LLM step's output.

Use this where the check's warnings and the schemas are needed together,
such as a host that saves workflows itself and shows a later step what an
LLM step produces. It compiles once and runs the program's `workflowSchemas`
node in one subprocess, which raises `std::run`. A workflow with problems
fails with them, as `checkWorkflow` does, and starts no process.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| workflow | [Workflow](#workflow) |  |  |
| tools | `any[]` |  | Original exported Agency functions available to the workflow's steps. |
| dir | `string` | "" | Directory containing any local tool modules and resolving their paths. |

**Returns:** `Result<CheckedWorkflow, WorkflowFailure>`

**Throws:** `std::run`, `std::guard`, `std::read`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L285))

### catalog

```ts
catalog(tools: any[], dir: string = ""): Result<CatalogEntry[]>
```

Describe workflow tools with their parameters, schemas, return types, and effects.

Use this to populate a workflow editor or inspect what arguments a step can
pass. Entries follow the supplied tool order. Invalid tool lists return
problems in failure data; a rejected or failed module read returns its own
failure instead.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| tools | `any[]` |  | Original exported Agency functions to describe. |
| dir | `string` | "" | Directory containing any local tool modules and resolving their paths. |

**Returns:** `Result<CatalogEntry[]>`

**Throws:** `std::read`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L341))

### runWorkflow

```ts
runWorkflow(
  workflow: Workflow,
  inputs: Json,
  tools: any[],
  dir: string = "",
): Result<Json>
```

Check a workflow, request approval, and execute its steps in a subprocess.

Validation completes before run approval or subprocess startup. Step
failures identify the step that stopped the workflow. Each step's interrupts
still reach the caller's handlers.

Workflow and step limits are hard caps: the generated program rejects their
guard trips. A tool's own guard retains its handlers, so it can extend its
own budget within those caps. A caller policy that rejects `std::guard`
also rejects that extension.

An "always" run approval pins the resolved directory and workflow name.
It does not pin the inputs or the workflow's contents.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| workflow | [Workflow](#workflow) |  |  |
| inputs | [Json](validation.md#json) |  | A value matching the workflow's inputs type. |
| tools | `any[]` |  | Original exported Agency functions available to the workflow's steps. |
| dir | `string` | "" | Directory containing local tool modules, defaulting to the working directory. |

**Returns:** `Result<Json>`

**Throws:** `std::workflow::run`, `std::run`, `std::guard`, `std::read`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L371))

### workflowTool

```ts
workflowTool(workflow: Workflow, tools: any[], dir: string = ""): Result
```

Build an LLM-callable tool for a checked workflow.

The returned tool uses the workflow's name and description. Its `inputs`
parameter has the workflow's input schema. Building it checks the workflow
and runs a schema node in a subprocess; calling it later runs the workflow.
A name shared with a supplied tool is refused.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| workflow | [Workflow](#workflow) |  |  |
| tools | `any[]` |  | Original exported Agency functions the workflow may call, with names distinct from the workflow. |
| dir | `string` | "" | Directory containing local tool modules, defaulting to the working directory. |

**Returns:** `Result`

**Throws:** `std::run`, `std::guard`, `std::read`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L418))

### workflowTools

```ts
workflowTools(dir: string, tools: any[]): Result<any[]>
```

Build one LLM-callable tool per saved workflow, in name order.

Use saved input schemas to build tools without starting a subprocess.
Saved workflows are checked against the current tools when called.
A missing schema requires saving the workflow again with `writeWorkflow`.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| dir | `string` |  | Nonempty project directory holding the workflows folder. |
| tools | `any[]` |  | Original exported Agency functions the workflows may call, with names distinct from the workflows. |

**Returns:** `Result<any[]>`

**Throws:** `std::workflow::scan`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L453))

### writeWorkflow

```ts
writeWorkflow(
  workflow: Workflow,
  tools: any[],
  dir: string,
): Result<WorkflowEntry>
```

Check and save a workflow as `<dir>/workflows/<name>.json` after approval.
  An existing workflow with that name is replaced.

Checks the workflow before requesting save approval. It then derives the
input schema in a subprocess and saves it alongside the workflow.
Neither a rejected save nor a rejected schema run writes the workflow.
Saving an existing name replaces its file.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| workflow | [Workflow](#workflow) |  |  |
| tools | `any[]` |  | Original exported Agency functions available to the workflow's steps. |
| dir | `string` |  | Existing project directory containing any local tool modules. |

**Returns:** `Result<WorkflowEntry>`

**Throws:** `std::workflow::save`, `std::run`, `std::guard`, `std::read`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L584))

### loadWorkflow

```ts
loadWorkflow(
  name: string,
  dir: string,
): Result<WorkflowEntry> raises <std::workflow::scan>
```

Read a saved workflow by name.

The saved workflow's name must match its filename. Loading reads the file
and checks its shape; it does not check the steps against available tools.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| name | `string` |  | Saved workflow identifier, excluding path syntax. |
| dir | `string` |  | Nonempty project directory holding the workflows folder. |

**Returns:** `Result<WorkflowEntry>`

**Throws:** `std::workflow::scan`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L678))

### listWorkflows

```ts
listWorkflows(dir: string): Result<WorkflowEntry[]> raises <std::workflow::scan>
```

List saved workflows in name order.

A project without a workflows folder returns an empty list. An unreadable
or invalid saved file fails the listing with a message naming it.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| dir | `string` |  | Nonempty project directory holding the workflows folder. |

**Returns:** `Result<WorkflowEntry[]>`

**Throws:** `std::workflow::scan`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/workflow.agency#L717))
