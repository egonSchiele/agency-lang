# ADI-254: `workflowTool` and `workflowTools`, a saved workflow as one tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The owner prefers one agent working inline, so do not use subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host hands a model one tool per workflow, so "do the meal plan thing" is one ordinary tool choice, and the model sees the workflow's inputs as a typed object in which an optional input is optional.

**Architecture:** `workflowTool` is `runWorkflow` with the workflow, the tools, and the directory bound by `.partial`, renamed to the workflow's name, described by the workflow's description, and given the workflow's inputs schema with `.withParamSchema`. `workflowTools` builds one such tool per saved workflow from the schema `writeWorkflow` stored, with no subprocess. The one new mechanism is how an optional input becomes optional: the generated program's `inputsSchema` node asks zod for the schema's input form, where a key with a default is not required, instead of its output form.

**Tech Stack:** TypeScript in `lib/runtime/schema.ts` and `lib/stdlib/workflow/render.ts`; Agency in `stdlib/workflow.agency`; vitest; one Agency execution test with mocked model calls.

**Spec:** `docs/superpowers/specs/2026-10-26-workflows-design.md`, sections "Offering a workflow as a tool" and "Public API", and decision 10. Linear ticket ADI-254. Read `docs/dev/stdlib/workflow.md` ("Saving and loading") before starting. The ticket says the schema is read from `meta.json`; since ADI-250 a saved workflow is one file, `<dir>/workflows/<name>.json`, with the schema under its `meta` key.

## Background for someone new to this codebase

### What a function value can do

Every Agency `def` compiles to an `AgencyFunction` (`lib/runtime/agencyFunction.ts`). It carries a `toolDefinition`, which is the name, description, and zod schema a model sees when the function is in an `llm(tools: [...])` call. Four methods derive a new function value from an old one, each returning a copy (`derive`, `agencyFunction.ts:235-237`):

- `.partial(name: value, ...)` binds parameters. The bound ones leave the schema and their `@param` lines leave the description (`:368-420`).
- `.rename(name)` changes the name the model sees (`:491-497`).
- `.describe(text)` replaces the description (`:449`).
- `.withParamSchema(name, jsonSchema)` replaces one unbound parameter's entry in the schema with the JSON Schema given (`:476-489`). A checkpoint keeps it: the function value records each schema in `paramSchemas`, and the reviver calls `.withParamSchema` again on revive (ADI-249).

A probe on a current build confirmed the chain this plan uses parses, typechecks, and runs from Agency, and that `tool.name` reads a function value's name:

```
const bound = runWorkflow.partial(workflow: workflow, tools: tools, dir: dir)
return bound.rename(workflow.name).describe(workflow.description).withParamSchema("inputs", inputsSchema)
```

A method chain must stay on one line or break after the dot; a line that starts with `.` does not parse.

The tool's schema then nests the workflow's inputs under the one parameter `inputs`:

```json
{ "type": "object",
  "properties": { "inputs": { "type": "object", "properties": { "a": { "type": "number" } }, "required": ["a"] } },
  "required": ["inputs"] }
```

### Where the inputs schema comes from, and the optional-input problem

Every generated workflow program has an `inputsSchema` node that returns `schema(Inputs).toJSONSchema()` (`lib/stdlib/workflow/render.ts:27`, `:43`). `writeWorkflow` runs it once in a subprocess at save time and stores the result as `meta.inputsSchema` (`stdlib/workflow.agency`, `_inputsSchema` and `writeWorkflow`). `Schema.toJSONSchema()` is `z.toJSONSchema(this.zodSchema)` (`lib/runtime/schema.ts:33-35`).

An optional field, `b?: number`, compiles to `z.union([z.number(), z.null()]).optional().default(null)` on the validation path (`optional-coalesce`, `lib/backends/typescriptGenerator/typeToZodSchema.ts:53-60`, used by `mapTypeToValidationSchema`, `:287-319`). zod's JSON Schema for that, in its default *output* form, keeps `b` in `required`, because after parsing the key is always present:

```json
{ "properties": { "a": { "type": "number" }, "b": { "default": null, "anyOf": [{ "type": "number" }, { "type": "null" }] } },
  "required": ["a", "b"], "additionalProperties": false }
```

So a model calling a tool built from this schema must send `b: null` to leave `b` out. The owner ruled that such a key is rewritten to optional.

zod has the notion already. Its *input* form describes what a caller may send, and a key with a default is not required there. On a current build, `z.toJSONSchema(s, { io: "input" })` for the same schema gives:

```json
{ "properties": { "a": { "type": "number" }, "b": { "default": null, "anyOf": [{ "type": "number" }, { "type": "null" }] } },
  "required": ["a"] }
```

`z.fromJSONSchema` of that parses `{ a: 1 }` as a success, which is what `.withParamSchema` needs. And `main(inputs: Inputs!)` accepts `{ a: 1 }` with `b` missing, because the validation schema coalesces a missing key to `null`. So the whole change is one argument: the generated node asks for the input form.

### Saved workflows

`loadWorkflow` and `listWorkflows` return a `WorkflowEntry`: `{ name, path, workflow, meta }`, with `meta.inputsSchema` the stored schema or `null` for a file saved before schemas were recorded (`stdlib/workflow.agency`, `WorkflowMeta`). `listWorkflows(dir)` raises one `std::workflow::scan` and reads every file under `<dir>/workflows`. `expandRoot` refuses an empty `dir` and resolves it to its real path; `runWorkflow` resolves `dir` with `resolve` and names that path in its `std::workflow::run` payload.

### Build and test commands

- After editing `stdlib/*.agency`, run `make > /tmp/adi254-make.log 2>&1`. It rebuilds the stdlib and regenerates `docs/site/stdlib/*.md`. Never edit those pages by hand.
- Unit tests: `pnpm test:run <files> > /tmp/adi254-unit.log 2>&1`, then read the file.
- One Agency test: `pnpm run agency test tests/agency/workflow/tool.test.json > /tmp/adi254-agency.log 2>&1`. The mocked model cases need `AGENCY_USE_TEST_LLM_PROVIDER=1`, which CI sets; set it locally too.
- Before each commit: `pnpm run typecheck`, and `npx prettier --write` on the TypeScript files you changed. Do not run `pnpm run fmt:ts`, which formats every worktree under the package.

## Global Constraints

- The public signatures are the spec's, except that `workflowTool` returns `Result<any>` (call 3): `workflowTool(workflow: Workflow, tools: any[], dir: string = ""): Result<any>` and `workflowTools(dir: string, tools: any[]): Result<any[]>`.
- The tool is built exactly as the spec writes it: `runWorkflow` with `.partial`, `.rename`, `.describe`, and `.withParamSchema("inputs", ...)`. Nothing is learned or extracted from the source (decision 10).
- `workflowTools` starts no subprocess. It reads each schema from the saved file.
- No new effect. `workflowTool` raises what `writeWorkflow`'s check and schema steps raise: `std::read` per local module and one `std::run`. `workflowTools` raises one `std::workflow::scan`.
- `Schema.toJSONSchema()` with no argument keeps its output unchanged.

## Calls I made

Each is a place the spec or the ticket leaves open. The owner can object to any of them.

1. **An optional input becomes optional through zod's input form, not a rewrite.** `Schema.toJSONSchema` gains an optional argument, `"input"` or `"output"`, passed to `z.toJSONSchema` as `io`. The generated `inputsSchema` node passes `"input"`. The alternative, a helper that drops from `required` every key whose schema has `default: null`, would hand-roll a rule zod already has. The key keeps `default: null` and its `anyOf` with `null`, so a model may still send `null`, and the program accepts both. The input form also leaves out `additionalProperties: false`, so the model is no longer told that an extra key is refused. Nothing parses a tool call's arguments against the tool's zod schema, and `main(inputs: Inputs!)` drops an unknown key as it did before, so what runs does not change; the `std::workflow::run` payload shows the extra key to whoever approves it, and the program ignores it.
2. **The change lands at save time.** `meta.inputsSchema` holds the input form from now on, so every reader of the file sees an optional key, not only the tool. A workflow saved before this change keeps its stored schema, with the optional key required; saving it again fixes it. `workflowTools` does not rewrite a stored schema.
3. **`workflowTool` returns `Result<any>`, not `any`.** It runs the check and the schema subprocess, and either can fail or be rejected. A failure returned as the tool would be a tool that fails on every call with no way to see why. The spec's Public API changes to match.
4. **A saved workflow with no stored schema is refused by `workflowTools`,** with a message naming it and saying to save it again with `writeWorkflow`. Starting a subprocess to compute it is what the ticket rules out.
5. **Both functions refuse a workflow whose name is one of the `tools` argument's names.** Two saved workflows cannot share a name, since each is one file. The check is one private helper, `nameTaken`, that `workflowTool` and `workflowTools` both call, so the two cannot disagree about a workflow. It compares against `tools`, the functions the workflow may call, which is often but not always the list the host hands `llm()`; the tool loop's `assertUniqueToolNames` (`lib/runtime/toolInvocation.ts:323`) stays the last guard for that list, and the docstrings say so. Refusing here returns a failure the host can read instead of a throw later.
6. **The tool's `dir` is `resolve(dir)`,** the same absolute path `runWorkflow` names in its `std::workflow::run` payload, so an "always" answer given to a direct `runWorkflow` call covers the tool's calls too.
7. **The tool's description is `workflow.description`, unchanged.** The model reads the inputs from the schema; the description says what the workflow does.
8. **A stale saved workflow fails when it is called, not when it is listed.** `workflowTools` does not check a saved workflow's steps against `tools`, so a workflow whose tool was renamed or removed since it was saved still becomes a tool. Each call runs `_checked` before its prompt, so the call fails with the problems listed and starts nothing. Checking at listing time would cost one compile per saved workflow and a `std::read` per local module. The docstring and the dev doc say which it is. The owner can rule the other way; the change would be one `_checked` call per entry in `workflowTools`.
9. **`listWorkflows` lists in name order.** `_glob` returns files in the file system's order, which differs between macOS and Linux. Sorting the names makes the tools `workflowTools` hands a model the same on every machine, and makes the listing test deterministic.

## Not in this ticket

- The ticket text says the schema is read from `meta.json`. The file layout changed in ADI-250. Update the ticket when linking the PR.
- `schema(T).toJSONSchema("input")` is now available to any Agency program. It is documented in the runtime's doc comment and nowhere else; the guide page on validation is user-facing and out of scope here.

## Review Focus

These are the inputs the spec implies but no test in the ticket exercises. Each one gets a test in the task named.

1. A workflow with an optional input: the tool's schema lists it under `properties` and not under `required`. (Task 2)
2. A workflow that fails the check: `workflowTool` fails with the problems and raises nothing. (Task 2)
3. A saved workflow with no stored schema: `workflowTools` fails naming it, and names `writeWorkflow`. (Task 2)
4. The `std::workflow::run` payload of a call the model makes carries the inputs the model sent. (Task 2)
5. `Schema.toJSONSchema()` with no argument is unchanged, so `@jsonSchema` tests and every other caller keep their output. (Task 1)

---

### Task 1: The inputs schema's input form

**Files:**
- Modify: `lib/runtime/schema.ts` (`toJSONSchema`, lines 26-35)
- Modify: `lib/stdlib/workflow/render.ts` (both scaffolds, lines 27 and 43)
- Modify: `lib/stdlib/workflow/render.test.ts` (the scaffold expectation at line 52)
- Modify: `lib/stdlib/workflow/index.test.ts` (`MEAL_PLAN_SOURCE` spells out the whole generated program; its `inputsSchema` node at lines 80-81)
- Modify: `tests/agency/workflow/save.agency` and `save.test.json` (`savedMetaHasInputsSchema`)
- Test: `lib/runtime/schema.test.ts`

**Interfaces:**
- Produces: `Schema.toJSONSchema(io: "input" | "output" = "output"): unknown`. Its doc comment says: the output form describes a parsed value, where a key with a default is always present and so required; the input form describes what a caller may send, where such a key is optional. Agency code reaches it as `schema(T).toJSONSchema("input")`; the checker types the result as `any` whatever the argument (`lib/typeChecker/synthesizer.ts:1380-1385`, confirmed by a probe).

- [ ] **Step 1: Write the failing test**

In `schema.test.ts`, inside `describe("Schema")`:

```ts
it("toJSONSchema: a key with a default is required in the output form and optional in the input form", () => {
  const schema = new Schema(
    z.object({ a: z.number(), b: z.union([z.number(), z.null()]).optional().default(null) }),
  );
  const required = (form: unknown) => (form as { required: string[] }).required;
  expect(required(schema.toJSONSchema())).toEqual(["a", "b"]);
  expect(required(schema.toJSONSchema("input"))).toEqual(["a"]);
});
```

Run `pnpm test:run lib/runtime/schema.test.ts`. The test fails: `toJSONSchema` takes no argument, and the second call returns the output form.

- [ ] **Step 2: Add the argument**

`toJSONSchema(io: "input" | "output" = "output")` returns `z.toJSONSchema(this.zodSchema, { io })`. Replace the doc comment with the one in Interfaces.

- [ ] **Step 3: Ask for the input form from the generated program**

In `render.ts`, both scaffolds' `inputsSchema` node returns `schema(Inputs).toJSONSchema("input")`. Update the expected line in `render.test.ts:52` and in `index.test.ts:81`. Put one comment above the first scaffold's node: a key with a default is optional in the input form, so an optional input is optional in the tool a workflow becomes.

- [ ] **Step 4: Pin the stored schema's new shape**

In `save.agency`, `savedMetaHasInputsSchema` keeps its five values. Change the comment above it: an optional input is a key that is not required and may be null, which is the input form of the schema. In `save.test.json`, its `expectedOutput` becomes `["string","number",true,["noteTitle","a"],["noteTitle","a"]]` and its `description` says the optional input is not required.

- [ ] **Step 5: Run, typecheck, commit**

`make`, then `pnpm test:run lib/runtime/schema.test.ts lib/stdlib/workflow/render.test.ts lib/stdlib/workflow/index.test.ts` and `pnpm run agency test tests/agency/workflow/save.test.json`. Also run `pnpm run agency test tests/agency/validation/jsonSchemaWithDescription.test.json`, a caller of the no-argument form. All pass. Typecheck, prettier on the two TypeScript files, and commit with the message in a file: `Schema.toJSONSchema takes the form: an optional input is optional in a workflow's schema`.

---

### Task 2: `workflowTool` and `workflowTools`

**Files:**
- Modify: `stdlib/workflow.agency` (two exported defs, one private def, the module doc comment)
- Create: `tests/agency/workflow/tool.agency` and `tests/agency/workflow/tool.test.json`

**Interfaces:**
- Consumes: `_checked`, `_inputsSchema`, `listWorkflows`, `resolve` from `std::path`, and `WorkflowEntry`, all already in `workflow.agency`.
- Produces, in `stdlib/workflow.agency`:

```
/** The name of a tool in `tools` that `name` would collide with, or null.
  A model cannot be handed two tools with one name. */
def nameTaken(name: string, tools: any[]): string | null

/** The tool: runWorkflow with the workflow, the tools, and the directory
  bound, under the workflow's name and description, with the inputs schema
  as the type of its one parameter. */
def toolFor(workflow: Workflow, tools: any[], dir: string, inputsSchema: Json): any

@capabilities(fileRead, fileWrite, subprocess)
export def workflowTool(workflow: Workflow, tools: any[], dir: string = ""): Result<any>

@capabilities(fileRead)
export def workflowTools(dir: string, tools: any[]): Result<any[]>
```

- [ ] **Step 1: Write the failing Agency test**

`tests/agency/workflow/tool.agency`:

```
// A workflow as one tool: runWorkflow bound to the workflow, under its
// name, with its inputs schema. The model calls in modelCallsTheTool are
// mocked; no other node calls a model.
import { workflowTool, workflowTools, writeWorkflow, Workflow } from "std::workflow"
import { add, multiply } from "std::math"
import { mkdir, remove } from "std::fs"
import { keys } from "std::object"
import { Json } from "std::validation"
import { getMutable, setMutable } from "../../helpers/mutableVar.js"

// Its own folder: CI runs test files in parallel, and save.agency writes
// under test-output too.
const OUT = __dirname + "/test-output/tool"
const TOOLS = [add, multiply]

/** A checkpoint is written when this is raised with no handler in the
  program, which is how schemaSurvivesACheckpoint pauses. */
effect test::pause {
  reason: string
}

def doubleSum(name: string): Workflow {
  return {
    format: 1,
    name: name,
    description: "Add two numbers and double the sum.",
    inputs: "{ a: number; b: number }",
    steps: [
      { id: "sum", kind: "tool", module: "std::math", tool: "add", args: { a: { "$ref": "inputs.a" }, b: { "$ref": "inputs.b" } } },
      { id: "doubled", kind: "tool", module: "std::math", tool: "multiply", args: { a: { "$ref": "steps.sum" }, b: 2 } }
    ],
    result: { "$ref": "steps.doubled" }
  }
}

/** `b` is optional, so the tool's schema must not require it. */
def withOptional(name: string): Workflow {
  return {
    format: 1,
    name: name,
    description: "Add one to a.",
    inputs: "{ a: number; b?: number }",
    steps: [
      { id: "sum", kind: "tool", module: "std::math", tool: "add", args: { a: { "$ref": "inputs.a" }, b: 1 } }
    ]
  }
}

/** The check refuses this: `subtract` is not in TOOLS. */
def badWorkflow(name: string): Workflow {
  return {
    format: 1,
    name: name,
    description: "Subtract.",
    inputs: "{ a: number }",
    steps: [{ id: "diff", kind: "tool", module: "std::math", tool: "subtract", args: { a: { "$ref": "inputs.a" }, b: 1 } }]
  }
}

def cleanup(name: string) {
  remove(OUT + "/workflows/${name}.json") with approve
}

/** The failure's message, or "" for a success. */
def errorOf(result: Result<any>): string {
  if (result is failure(err)) {
    return "${err}"
  }
  return ""
}

/** The JSON Schema the model sees for the tool's `inputs` parameter. This
  is the output form of the tool's own schema, which is what the tool loop
  sends; `b` is still not required there, because `fromJSONSchema` read the
  input form the workflow stored. */
def inputsSchemaOf(tool: any): Json {
  return tool.toolDefinition.schema.toJSONSchema().properties.inputs
}

/** Builds the tool, recording every effect raised in "effects" and each
  payload under its effect's name. */
def buildTool(workflow: Workflow): Result<any> {
  setMutable("effects", [])
  handle {
    return workflowTool(workflow, TOOLS, OUT)
  } with (intr) {
    getMutable("effects", []).push(intr.effect)
    setMutable(intr.effect, intr.data)
    return approve()
  }
}

node toolShape(): Json {
  const built = buildTool(doubleSum("doubleSum"))
  if (built is failure(err)) {
    return "failed: ${err}"
  }
  const tool = built.value
  const schema = tool.toolDefinition.schema.toJSONSchema()
  return [
    tool.name,
    tool.toolDefinition.description,
    schema.required,
    inputsSchemaOf(tool).required,
    getMutable("effects", [])
  ]
}

node optionalInputIsOptional(): Json {
  const built = buildTool(withOptional("withOptional"))
  if (built is failure(err)) {
    return "failed: ${err}"
  }
  const inputs = inputsSchemaOf(built.value)
  return [inputs.required, keys(inputs.properties)]
}

node badWorkflowIsRefused(): Json {
  const built = buildTool(badWorkflow("bad"))
  return [isFailure(built), errorOf(built) =~ re/subtract/, getMutable("effects", [])]
}

/** A workflow named like one of its tools cannot be handed to a model
  beside it, so workflowTool refuses it as workflowTools does. */
node workflowToolRefusesAClash(): Json {
  const built = buildTool(doubleSum("add"))
  return [isFailure(built), errorOf(built) =~ re/"add"/, getMutable("effects", [])]
}

node modelCallsTheTool(): Json {
  const built = buildTool(doubleSum("doubleSum"))
  if (built is failure(err)) {
    return "failed: ${err}"
  }
  setMutable("effects", [])
  let answer = ""
  handle {
    answer = llm("Double the sum of 2 and 3.", { tools: [built.value] })
  } with (intr) {
    getMutable("effects", []).push(intr.effect)
    setMutable(intr.effect, intr.data)
    return approve()
  }
  const run = getMutable("std::workflow::run", {})
  return [answer, getMutable("effects", []), run.name, run.inputs]
}

node schemaSurvivesACheckpoint(): Json {
  const built = buildTool(doubleSum("doubleSum"))
  if (built is failure(err)) {
    return "failed: ${err}"
  }
  const tool = built.value
  // No handler here: the raise reaches the test runner, which writes a
  // checkpoint with `tool` as a live local and approves.
  return interrupt test::pause("pause with the tool in a local", { reason: "checkpoint" })
  return inputsSchemaOf(tool).required
}

/** Saves `workflow` under OUT with every prompt approved. */
def save(workflow: Workflow): Result<any> {
  mkdir(OUT) with approve
  return writeWorkflow(workflow, TOOLS, OUT) with approve
}

/** Lists the tools under `dir`, recording every effect raised in "effects". */
def listTools(dir: string, tools: any[]): Result<any[]> {
  setMutable("effects", [])
  handle {
    return workflowTools(dir, tools)
  } with (intr) {
    getMutable("effects", []).push(intr.effect)
    return approve()
  }
}

node savedWorkflowsBecomeTools(): Json {
  cleanup("toolDoubleSum")
  cleanup("toolOptional")
  const savedOne = save(doubleSum("toolDoubleSum"))
  const savedTwo = save(withOptional("toolOptional"))
  const listed = listTools(OUT, TOOLS)
  cleanup("toolDoubleSum")
  cleanup("toolOptional")
  if (savedOne is failure || savedTwo is failure || listed is failure) {
    return ["failed", errorOf(savedOne), errorOf(savedTwo), errorOf(listed)]
  }
  const optional = find(listed.value, \tool -> tool.name == "toolOptional")
  return [
    map(listed.value, \tool -> tool.name),
    inputsSchemaOf(optional).required,
    getMutable("effects", [])
  ]
}

node nameClashIsRefused(): Json {
  cleanup("toolDoubleSum")
  const saved = save(doubleSum("toolDoubleSum"))
  const listed = listTools(OUT, [add, multiply.rename("toolDoubleSum")])
  cleanup("toolDoubleSum")
  if (saved is failure) {
    return "failed: ${errorOf(saved)}"
  }
  return [isFailure(listed), errorOf(listed) =~ re/toolDoubleSum/]
}

node olderSaveIsRefused(): Json {
  const listed = listTools(__dirname + "/fixtures/saved/olderOne", TOOLS)
  return [isFailure(listed), errorOf(listed) =~ re/olderOne/, errorOf(listed) =~ re/writeWorkflow/]
}

node emptyProjectHasNoTools(): Json {
  mkdir(OUT) with approve
  cleanup("toolDoubleSum")
  cleanup("toolOptional")
  const listed = listTools(OUT, TOOLS)
  return map(listed catch ["failed"], \tool -> tool.name)
}
```

`tool.test.json` has one case per node, each `"type": "exact"`. The two that raise outside a handler, `schemaSurvivesACheckpoint` and `modelCallsTheTool`, need more:

| node | expectedOutput | extra |
|---|---|---|
| `toolShape` | `["doubleSum","Add two numbers and double the sum.",["inputs"],["a","b"],["std::run"]]` | |
| `optionalInputIsOptional` | `[["a"],["a","b"]]` | |
| `badWorkflowIsRefused` | `[true,true,[]]` | |
| `workflowToolRefusesAClash` | `[true,true,[]]` | |
| `modelCallsTheTool` | `["done",["std::workflow::run","std::run"],"doubleSum",{"a":2,"b":3}]` | `"useTestLLMProvider": true`, `"llmMocks": [{ "toolCalls": [{ "name": "doubleSum", "args": { "inputs": { "a": 2, "b": 3 } } }] }, { "return": "done" }]` |
| `schemaSurvivesACheckpoint` | `["a","b"]` | `"interruptHandlers": [{ "action": "approve" }]` |
| `savedWorkflowsBecomeTools` | `[["toolDoubleSum","toolOptional"],["a"],["std::workflow::scan"]]` | |
| `nameClashIsRefused` | `[true,true]` | |
| `olderSaveIsRefused` | `[true,true,true]` | |
| `emptyProjectHasNoTools` | `[]` | |

The order in `savedWorkflowsBecomeTools` is the listing's order, which Step 2 makes name order. The effects list in `modelCallsTheTool` starts after `buildTool` cleared it: a call of the tool raises `std::workflow::run` and then `run`'s `std::run`, and `_checked` raises nothing for a workflow over `std::math`. `tests/agency/workflow/test-output/` is gitignored already.

Run `make`, then the test. It fails to compile because `workflowTool` and `workflowTools` are not exported.

- [ ] **Step 2: Implement the three defs**

After `catalog` and before the saving section in `workflow.agency`:

`toolFor(workflow, tools, dir, inputsSchema)` is the chain in the background, in two statements as the probe wrote it. Its doc comment is the one in Interfaces.

`nameTaken(name, tools)`: `find(tools, \tool -> tool.name == name)`, and that tool's name or null. The refusal both callers build from it: `` `workflow "${name}" has the same name as a tool the host passed; rename one of them` ``.

`workflowTool`: `const where = resolve(dir)`; the clash check first, since it needs no read; `_checked(workflow, tools, where)`, returning `failure(checked.error, checked.data)` on failure as `runWorkflow` does; `_inputsSchema(checked.value.program)`, returned as it came on failure; then `success(toolFor(workflow, tools, where, inputsSchema.value))`. Its docstring is a tool description, so write it for a model:

```
"""
Make one tool that runs a workflow when called. The tool has the workflow's name and description, and its one parameter, `inputs`, has the workflow's inputs type. Checks the workflow first, then runs its program's `inputsSchema` node once in a subprocess, which raises `std::run`. A workflow with problems fails with every problem and starts nothing. A workflow named like one of `tools` is refused, since a model cannot be handed both; the tool loop still refuses a name clash with any other tool at the model call.

@param workflow - The workflow the tool runs
@param tools - The functions the workflow may call
@param dir - The directory a workflow's local modules are named relative to
"""
```

`workflowTools`: `listWorkflows(dir)`, returned as it came on failure. Then, with `const where = resolve(dir)`, one entry at a time: an entry whose `meta.inputsSchema` is null fails with `` `${entry.name} was saved before inputs schemas were recorded; save it again with writeWorkflow` ``; an entry `nameTaken` refuses fails with the refusal above; otherwise it becomes `toolFor(entry.workflow, tools, where, entry.meta.inputsSchema)`. Build the list with `map` over the entries to a `Result<any>` each and `find(..., isFailure)` for the first failure, as `listWorkflows` does with its entries; no loop that pushes. Its docstring:

```
"""
One tool per workflow saved under a project directory, in name order, each built as `workflowTool` builds it, from the inputs schema saved with the workflow. Starts no subprocess, and does not check a saved workflow against `tools`: a workflow whose tools changed since it was saved fails when it is called, with the problems listed, and starts nothing. Raises one `std::workflow::scan` prompt, or none for a project with no `workflows` folder. Refuses a workflow whose name is already a tool's name in `tools`, and one saved before inputs schemas were recorded.

@param dir - The project directory the workflows were saved under
@param tools - The functions the workflows may call. A workflow may not share a name with one of them
"""
```

In `listWorkflows`, sort the names before building entries: `const names = sortBy(map(filter(fileNames.value, isVisible), workflowName), \name -> name)`, and add "in name order" to its docstring. `sortBy` is in `std::index` (`stdlib/index.agency:550`).

Add one sentence to the module doc comment after the `writeWorkflow` sentence: "`workflowTool` makes a workflow one tool a model can call, and `workflowTools` makes one per saved workflow."

- [ ] **Step 3: Build, run, check, commit**

`make`, then the Agency test, with `AGENCY_USE_TEST_LLM_PROVIDER=1`. All ten cases pass. Run `pnpm test:run lib/stdlibCapabilities.test.ts`: `workflowTool` reaches `_inputsSchema`, so it carries `fileWrite` and `subprocess` as `writeWorkflow` does; `workflowTools` reaches only reads. Then `pnpm run agency test tests/agency/workflow/save.test.json` once more, since the file changed in Task 1 and this task shares its fixtures. Typecheck, `pnpm run lint:structure`, and commit: `std::workflow: workflowTool and workflowTools`.

---

### Task 3: Docs

**Files:**
- Modify: `docs/dev/stdlib/workflow.md` (a new section "Offering a workflow as a tool" after "The catalog", the optional-input paragraph in "Saving and loading", and "Not built yet")
- Modify: `docs/superpowers/specs/2026-10-26-workflows-design.md` ("Offering a workflow as a tool" and "Public API")
- Modify: the `workflow.md` line in `CLAUDE.md` and in `.claude/skills/agency-stdlib-docs/SKILL.md`. The skill file is ignored by `.gitignore:4` and tracked anyway, so stage it with `git add -f`.

- [ ] **Step 1: Write the dev doc section**

State the mechanism and the rules, and leave out the history:

- the chain, and that the tool's one parameter `inputs` has the workflow's inputs type, nested, so a model sends `{ "inputs": { ... } }`;
- `workflowTool` runs the check and the schema subprocess, so it raises what `writeWorkflow` raises before its write, and fails as `runWorkflow` fails;
- `workflowTools` reads the stored schema and starts no subprocess; the two refusals, that both functions make the clash check against the `tools` argument through one helper and the tool loop remains the last guard for the list the host builds, and that a stale saved workflow fails when called, not when listed;
- the listing is in name order, so the tool list is the same on every machine;
- `dir` is `resolve(dir)`, the path `runWorkflow` pins, so one "always" answer covers both;
- the schema survives a checkpoint through `paramSchemas` (one sentence, pointing at checkpointing.md).

Replace the "Saving and loading" paragraph that begins "An optional input becomes a required key that may be null" with the new rule: the node asks for zod's input form, where a key with a default is not required, so `required` is `["a"]` for `{ a: number; b?: number }` and `b` keeps `default: null` and may be null. Say which form `Schema.toJSONSchema()` gives with no argument, and that the input form carries no `additionalProperties: false`, with the consequence from call 1. In the paragraph above it, the node now "returns `schema(Inputs).toJSONSchema("input")`". Remove "Not built yet"; every function in the spec's MVP now exists.

- [ ] **Step 2: Update the spec**

In "Public API", `workflowTool(...)` returns `Result<any>`. In "Offering a workflow as a tool", add one sentence: an optional input is optional in the tool's schema, through the input form of the stored schema (ADI-254). In "The generated program", the scaffold's `inputsSchema` node (line 259) calls `toJSONSchema("input")`.

- [ ] **Step 3: Update the index line**

Add "and a workflow as one tool through `workflowTool` and `workflowTools`" to the end of the `workflow.md` line in both files. Keep the addition that short.

- [ ] **Step 4: Commit**

Commit the four files with the message `docs: a workflow as one tool`.

---

### Task 4: PR

- [ ] **Step 1: Check the diff against `docs/dev/contributing/anti-patterns.md`.** Watch for a loop that pushes where `map` and `find` do, and a second place that builds the chain.
- [ ] **Step 2: Reread every comment and doc line you added.** Cut implementation notes and history.
- [ ] **Step 3: Push and open the PR**, with its body written to a file. Title: `std::workflow: a workflow as one tool (ADI-254)`. The body shows the tool's schema for `doubleSum`, explains the input-form change in one paragraph with the before and after `required` lists, says that a file saved between ADI-251 (2026-10-31) and this change keeps the optional key in `required` until it is saved again, lists the nine calls above so the owner can object to each, and the tests.
- [ ] **Step 4: Link the PR on ADI-254,** and fix the ticket's `meta.json` wording. The owner merges.

## Self-review notes

- Ticket tests: "a model call, mocked, picks the workflow tool and the workflow runs with the given inputs" is `modelCallsTheTool`, which checks the `std::workflow::run` payload's name and inputs. "The tool's inputs schema is still there after a pause and resume" is `schemaSurvivesACheckpoint`; the pattern, a live local across a raise the runner answers, is the one `tests/agency/renamed-ref-checkpoint.agency` uses for the same reviver. "A workflow named like a host tool is refused by `workflowTools`" is `nameClashIsRefused`.
- Spec coverage: the chain (Task 2), the schema from the stored file for a saved workflow (Task 2), the clash refusal in both functions (Task 2), the checkpoint (Task 2 test), and the owner's optional-input ruling (Task 1).
- Review round 1 (2026-11-01) applied: the `modelCallsTheTool` effects list, the test's own output folder and name-ordered listing, the `index.test.ts` scaffold line, the clash helper shared by both functions, the stale-workflow rule stated rather than checked, the `additionalProperties` note, "at most one" scan prompt, the output-form comment in the test, and the older-saves note for the PR body.
- Type consistency: `toolFor` takes `(workflow, tools, dir, inputsSchema)` in every call; `inputsSchemaOf` reads `properties.inputs` of the tool's schema, which the probe showed is where `.withParamSchema("inputs", ...)` puts it.
- Every Agency snippet's shape was checked against a probe on a current build: the chain, `tool.name` on an `any[]`, `schema(T).toJSONSchema("input")`, and a custom effect with one field.
