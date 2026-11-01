# ADI-251: Store a saved workflow's inputs schema in `meta.json` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The owner prefers one agent working inline, so do not use subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `writeWorkflow` saves a workflow, `meta.json` also holds the JSON Schema of the workflow's `inputs` type, so `workflowTools` (ADI-254) can build a typed tool from files alone.

**Architecture:** The generated program already has an `inputsSchema` node that returns `schema(Inputs).toJSONSchema()` (`lib/stdlib/workflow/render.ts:26`). `writeWorkflow` runs that node once with `run` from `std::agency`, on the program `_checked` already compiled, after the `save` prompt and before the writes. The result goes into `WorkflowMeta.inputsSchema`. A `meta.json` without the field reads back as `null`, the way the toolbox treats a tool saved before schemas were recorded.

**Tech Stack:** Agency in `stdlib/workflow.agency`; `run` from `std::agency`; the Agency execution test from ADI-250.

**Spec:** `docs/superpowers/specs/2026-10-26-workflows-design.md`, decision 24 and the sections "Offering a workflow as a tool" and "Saving a workflow"; Linear ticket ADI-251. Branch from ADI-250's branch; this is a stacked PR.

## Background for someone new to this codebase

- **Why a subprocess.** An Agency type becomes a JSON Schema only in compiled code, through `schema(T).toJSONSchema()`. The generator writes an `inputsSchema` node into every program for exactly this (`docs/dev/stdlib/workflow.md`, "Why the scaffold is fixed text"; `resolve.ts:41` reserves the name). Running a node of a compiled program means a child process and a `std::run` prompt. Doing it once at save time is decision 24: `workflowTools` then reads files instead of starting one child per workflow each time a host builds its tool list.
- **The precedent.** `requestSchemaOf` in `stdlib/toolbox.agency:1327` runs the tool's `requestSchema` node with `runFile` and stores the result as `ToolMeta.requestSchema`, "null for a tool saved before schemas were recorded". `saveTool` (line 1336) calls it after the save gate and before writing `meta.json`.
- **How `run` returns.** `run(compiled: program, node: "inputsSchema")` (`stdlib/agency.agency:178`) raises `std::run`, starts the child, and succeeds with an envelope whose `.data` is what the node returned. `runWorkflow` shows the unwrap: `ran.value.data`. A rejected `std::run` makes `run` return a failure, so `writeWorkflow` fails and writes nothing.
- **What ADI-250 built.** `writeWorkflow` is check, ask, write. `_checked` returns `{ program, warnings, wallClock }`, and `program` is the `CompiledProgram` handle `run` takes. `entryFor` reads `meta.json` through `MetaFile`, with `presentFields` over `DEFAULT_META`.
- **Build and run.** `make` after editing the stdlib. `pnpm run agency test tests/agency/workflow/save.test.json > /tmp/adi251.log 2>&1`, then read the file.

## What `schema()` gives for an optional field

Checked on a current build during plan review: `schema(T).toJSONSchema()` for `type T = { a: number; b?: number }` is

```json
{"type":"object",
 "properties":{"a":{"type":"number"},
               "b":{"default":null,"anyOf":[{"type":"number"},{"type":"null"}]}},
 "required":["a","b"],
 "additionalProperties":false}
```

An optional field becomes a required key that may be null. That is how Agency compiles `?`, and this ticket records what the compiler gives, so a model calling the tool `workflowTool` builds (ADI-254) must send `b: null` to leave `b` out. Whether "required but nullable" is the contract the owner wants is a question for ADI-254, noted on the Linear ticket; changing it is a compiler change, not this ticket.

## Global Constraints

- `WorkflowMeta.inputsSchema: Json | null`, the field name matching the node that produced it. `DEFAULT_META.inputsSchema` is `null`.
- The schema is computed from the program `_checked` compiled. The workflow is never compiled twice.
- Order in `writeWorkflow`: check, `std::workflow::save`, `std::run`, write. A workflow with problems raises nothing; a rejected `save` starts no process; a rejected `std::run` writes nothing.
- The child runs with `run`'s default limits. The `inputsSchema` node calls no tool and no model, so the workflow's own `limits` do not apply to it.
- `meta.json` is written once, with the schema in it. There is no second write to add it.

## Review Focus

1. A `meta.json` saved before this change (no `inputsSchema` key) loads with `inputsSchema: null` and `listWorkflows` does not fail on it. (Task 1)
2. A rejected `std::run` leaves no folder behind. (Task 1)
3. An `inputs` type with an optional field: the stored schema is what the compiler gives, a required key with a `null` member in its `anyOf`. (Task 1)

---

### Task 1: The schema in `meta.json`

**Files:**
- Modify: `stdlib/workflow.agency` (`WorkflowMeta`, `MetaFile`, `DEFAULT_META`, `writeWorkflow`, a new `_inputsSchema`)
- Modify: `tests/agency/workflow/save.agency`, `save.test.json`
- Create: `tests/agency/workflow/fixtures/saved/olderOne/workflow.json` (the `doubleSum` workflow from `save.agency` with `"name": "olderOne"`) and `olderOne/meta.json` holding `{ "createdAt": "2026-10-30T00:00:00.000Z", "createdBy": "writeWorkflow" }`

**Interfaces:**
- Consumes: `_checked`, `writeWorkflow`, `entryFor`, `DEFAULT_META`, `MetaFile` from ADI-250.
- Produces:

```
export type WorkflowMeta = {
  createdAt: string;
  createdBy: string;
  inputsSchema: Json | null
}

/** The JSON Schema of the program's `Inputs` type, from its `inputsSchema` node. */
@hidden
@capabilities(fileWrite, subprocess)
export def _inputsSchema(program: CompiledProgram): Result<Json>
```

  `const INPUTS_SCHEMA_NODE = "inputsSchema"` beside the file-name constants.

- [ ] **Step 1: Write the failing tests**

Append to `save.agency`. `doubleSum` reads `inputs.a` and `inputs.b`, so a second builder with its own `inputs` type is simpler than patching it:

```
/** One `add` step over typed inputs: the ticket's `noteTitle`, which no
  step reads (an unread input is allowed), and an optional field. */
def typedInputs(name: string): Workflow {
  return {
    format: 1,
    name: name,
    description: "Add one to a.",
    inputs: "{ noteTitle: string; a: number; b?: number }",
    steps: [
      { id: "sum", kind: "tool", module: "std::math", tool: "add", args: { a: { "$ref": "inputs.a" }, b: 1 } }
    ]
  }
}

node savedMetaHasInputsSchema(): Json {
  cleanup("typed")
  const saved = runSave(typedInputs("typed"))
  const loaded = loadWorkflow("typed", OUT) with approve
  cleanup("typed")
  if (saved is failure || loaded is failure) {
    return ["failed", errorOf(saved), errorOf(loaded)]
  }
  const schema = loaded.value.meta.inputsSchema
  const nullable = some(schema.properties.b.anyOf, \member -> member.type == "null")
  return [
    schema.properties.noteTitle.type,
    schema.properties.a.type,
    nullable,
    schema.required,
    saved.value.meta.inputsSchema.required
  ]
}

node olderMetaLoadsWithNullSchema(): Json {
  const saved = __dirname + "/fixtures/saved"
  const loaded = loadWorkflow("olderOne", saved) with approve
  if (loaded is failure(err)) {
    return "failed: ${err}"
  }
  return [loaded.value.meta.inputsSchema, loaded.value.meta.createdBy]
}

node rejectedRunWritesNothing(): Json {
  cleanup("norun")
  setMutable("effects", [])
  let result: Result<WorkflowEntry> = failure("not run")
  handle {
    result = writeWorkflow(doubleSum("norun"), TOOLS, OUT)
  } with (intr) {
    getMutable("effects", []).push(intr.effect)
    if (intr.effect == "std::run") {
      return reject("no subprocess")
    }
    return approve()
  }
  const written = exists("norun", OUT)
  cleanup("norun")
  return [isFailure(result), written, getMutable("effects", [])]
}
```

Cases in `save.test.json`:

| node | expectedOutput |
|---|---|
| `savedMetaHasInputsSchema` | `["string","number",true,["noteTitle","a","b"],["noteTitle","a","b"]]` |
| `olderMetaLoadsWithNullSchema` | `[null,"writeWorkflow"]` |
| `rejectedRunWritesNothing` | `[true,false,["std::workflow::save","std::run"]]` |

And change the existing `effectsInOrder` expectation to `["std::workflow::save","std::run"]`.

Note `olderMetaLoadsWithNullSchema` also exercises `listWorkflows` indirectly: the `notAWorkflow` fixture from ADI-250 sits in the same `fixtures/saved` directory, so `notAWorkflowFailsToLoadAndList` still fails on that folder and the `olderOne` folder must load cleanly on its own.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm run agency test tests/agency/workflow/save.test.json > /tmp/adi251-t1.log 2>&1; grep -n "PASS\|FAIL\|✓\|✗" /tmp/adi251-t1.log | head -30`
Expected: the three new cases and `effectsInOrder` fail.

- [ ] **Step 3: Implement**

In `stdlib/workflow.agency`:

- Add `inputsSchema: Json | null` to `WorkflowMeta` with a doc comment: the JSON Schema of the workflow's `inputs` type, as the program's own `inputsSchema` node reported it at save time; null for a workflow saved before schemas were recorded. `Json` is `any`, so the `| null` is for the reader and the shape check does not inspect the schema; a `meta.json` with garbage there passes the load and is refused by `z.fromJSONSchema` when `workflowTool` uses it. Add `inputsSchema?: Json` to `MetaFile` and `inputsSchema: null` to `DEFAULT_META`.
- Add `_inputsSchema(program)`:

```
@hidden
@capabilities(fileWrite, subprocess)
export def _inputsSchema(program: CompiledProgram): Result<Json> {
  const ran = run(compiled: program, node: INPUTS_SCHEMA_NODE)
  if (ran is failure(runErr)) {
    return failure("could not derive the inputs schema: ${runErr}")
  }
  return success(ran.value.data)
}
```

- In `writeWorkflow`, between the `save` interrupt and the folder creation: `const inputsSchema = _inputsSchema(checked.value.program)`, return its failure, and put `inputsSchema: inputsSchema.value` into `meta`. Add `subprocess` to `writeWorkflow`'s `@capabilities`.
- Update `writeWorkflow`'s docstring: it runs the program's `inputsSchema` node once in a subprocess, which raises `std::run`, and stores the result in `meta.json`.

- [ ] **Step 4: Build, run, check**

Run: `make > /tmp/adi251-make.log 2>&1; pnpm run agency test tests/agency/workflow/save.test.json > /tmp/adi251-t1.log 2>&1; tail -40 /tmp/adi251-t1.log`
Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
pnpm run typecheck && pnpm run fmt:ts && pnpm run lint:structure
git add stdlib/workflow.agency tests/agency/workflow/save.agency tests/agency/workflow/save.test.json tests/agency/workflow/fixtures/saved/olderOne docs/site/stdlib/workflow.md
git commit -F /tmp/adi251-c1.txt
```

Commit message: `std::workflow: store the inputs schema in meta.json at save time`.

---

### Task 2: Docs

**Files:**
- Modify: `docs/dev/stdlib/workflow.md`, the "Saving and loading" section from ADI-250
- Modify: the `workflow.md` index line in `CLAUDE.md` and `.claude/skills/agency-stdlib-docs/SKILL.md`

- [ ] **Step 1: Add a paragraph** to "Saving and loading": why the schema is computed at save time and not when the tool list is built (decision 24), the order of the two prompts, why the child runs with `run`'s default limits, the `null` rule for an older `meta.json`, that the shape check does not inspect the schema and where a bad one is refused, and what the compiler gives for an optional input (required, nullable) with what that means for a model calling the tool. Remove "the inputs schema in `meta.json`" from "Not built yet".
- [ ] **Step 2: Extend the index line** with "the inputs schema computed at save time".
- [ ] **Step 3: Commit**

```bash
git add docs/dev/stdlib/workflow.md CLAUDE.md .claude/skills/agency-stdlib-docs/SKILL.md
git commit -F /tmp/adi251-c2.txt
```

Commit message: `docs: the inputs schema in meta.json`.

---

### Task 3: PR

- [ ] **Step 1: Anti-pattern pass** over the diff. The schema has one producer (`_inputsSchema`) and one consumer (`meta`); nothing else reads the node.
- [ ] **Step 2: Push and open the PR** with its base set to ADI-250's branch, description in a file. Title: `std::workflow: inputs schema in meta.json (ADI-251)`. Say it is stacked on ADI-250, what `meta.json` gains, the prompt order, and the `null` rule.
- [ ] **Step 3: Link the PR on ADI-251**, move it to In Review. After ADI-250 merges, retarget this PR to main and merge main in (never rebase a pushed branch).

## Self-review notes

- Ticket tests: the schema names `noteTitle` as a string. `typedInputs` carries it as an unread input beside the `a` that `add` consumes, so the test needs no local module.
- `_inputsSchema` is `@hidden` and exported so `workflowTool` (ADI-254) can call it for a workflow that was never saved, which the spec allows ("For a saved workflow it is read from `meta.json`").
- The test for a `std::run` rejection pins that the save prompt comes first: a person who says no to the save never sees a `std::run` prompt, and one who says yes to the save and no to the run has nothing on disk.
