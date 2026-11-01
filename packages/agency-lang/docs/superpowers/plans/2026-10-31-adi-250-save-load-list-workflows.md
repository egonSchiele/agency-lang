# ADI-250: `writeWorkflow`, `loadWorkflow`, `listWorkflows` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The owner prefers one agent working inline, so do not use subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workflow can be saved into a directory, loaded back by name, and listed, with one `std::workflow::scan` prompt before a directory is read and one `std::workflow::save` prompt before anything is written.

**Architecture:** All new code is Agency in `stdlib/workflow.agency`, following `stdlib/toolbox.agency`'s read and save paths: the directory is resolved once to its real spelling, the effects carry that spelling, and the reads and writes that fulfil an approved prompt use the non-interrupt primitives `_read` and `_write`. `writeWorkflow` runs `_checked` (the compile and typecheck `runWorkflow` already uses) before it asks, so a workflow with problems asks nothing and is never written. One small TypeScript export, `_workflowNameProblem`, lets `loadWorkflow` refuse a name that is not an identifier with parse's own message.

**Tech Stack:** Agency stdlib conventions, `std::shell`'s `exists`, `std::object`'s `filterEntries`, `agency-lang/stdlib-lib/builtins.js`'s `_read` and `_write`, `agency-lang/stdlib-lib/fs.js`'s `_realDir` and `_mkdir`, `agency-lang/stdlib-lib/shell.js`'s `_glob`, Agency execution tests in `tests/agency/workflow/`, vitest for the one TypeScript test.

**Spec:** `docs/superpowers/specs/2026-10-26-workflows-design.md`, sections "Saving a workflow" and "Public API", decision 23, and Linear ticket ADI-250. Read `docs/dev/stdlib/workflow.md` and `docs/dev/stdlib/toolbox.md` first.

## Background for someone new to this codebase

- **The module today.** `stdlib/workflow.agency` has `compileWorkflow`, `checkWorkflow`, and `runWorkflow`, built on `_checked(workflow, tools, dir)`, which generates the program, typechecks it, and compiles it, and fails with every problem by step and field. `runWorkflow` resolves `dir` to an absolute path first and raises `std::workflow::run` with that path, because an "always" answer pins the text in the payload (`docs/dev/stdlib/workflow.md`, "Running a workflow").
- **How the toolbox reads and writes a directory.** `stdlib/toolbox.agency` is the model for this ticket. `expandRoot(dir)` (line 269) refuses an empty string and returns `_realDir(dir)`, the real spelling. `listTools` raises `std::toolbox::scan { dir }` once, then reads each tool's files with `_read(root, "name/file", 0, 0)`, which raises nothing. `std::skills` finds its skill folders the same way, with `_glob(root, sub, "*/SKILL.md", max)` after its scan prompt (`scanEntries`, `stdlib/skills.agency:289`), so one approval covers the whole listing; the toolbox's `ls` call, which raises a second prompt, is the odd one out, and this ticket follows the skills module. `metaFacts` (line 323) shows how a JSON file is read, parsed, and checked against a type with `!`: a missing file is the default record, a file that is not JSON or has the wrong shape is a failure. `askToSave` (line 1302) raises `std::toolbox::save` once, and the writes that follow use `_write` with no further prompt.
- **Effects and "always".** `@alwaysUnder(dir)` above an `effect` declaration means an "always" answer to that prompt pins the directory in its `dir` field, as a `dir/**` glob. `lib/typeChecker/alwaysTag.stdlib.test.ts` holds one row per stdlib effect saying which fields are pinned; a new effect without a row fails that test.
- **Validation with `!`.** `const file: MetaFile! = parsed.value` checks a JSON value against an Agency type at run time and gives a `Result` (`docs/site/guide/validation.md`). That is how `workflow.json` becomes a `Workflow` value the check can trust.
- **The name is already an identifier.** Parse refuses a workflow whose `name` is not an identifier or starts with two underscores (`identifier("name")` in `lib/stdlib/workflow/parse.ts:225`). `writeWorkflow` runs the check first, so by the time it builds a directory name from `workflow.name`, the name has no slash, no dot, and no `..`. `loadWorkflow` gets its name from the caller, not from a checked workflow, so it checks the name itself with the same rule.
- **Where tests write.** Agency tests under `tests/agency/` write into `__dirname + "/test-output"`, which `.gitignore` excludes (`**/test-output/`). `tests/agency/toolbox/writeTool.agency` shows the pattern: a `cleanup(name)` that removes the folder with `remove(...) with approve`, a handler that counts the save prompts and can reject one, and `exists(path, OUT)` to check what was written.
- **Tools for the tests.** `tests/agency/workflow/run.agency` uses `add` and `multiply` from `std::math`, so the check reads no local module and raises no `std::read`. Use the same workflow, `doubleSum`, here.
- **Build and run.** `make` after any change to `stdlib/*.agency` (it rebuilds the stdlib and regenerates `docs/site/stdlib/workflow.md`; never hand-edit that page). Run one Agency test with `pnpm run agency test tests/agency/workflow/save.test.json > /tmp/adi250.log 2>&1` and read the file.

## Global Constraints

- Public signatures exactly as the spec's "Public API": `writeWorkflow(workflow: Workflow, tools: any[], dir: string): Result<WorkflowEntry>`, `loadWorkflow(name: string, dir: string): Result<WorkflowEntry>`, `listWorkflows(dir: string): Result<WorkflowEntry[]>`. `dir` has no default: an empty string is refused with a message naming the parameter.
- Effects as the spec declares them: `std::workflow::scan { dir: string }` and `std::workflow::save { dir: string; name: string; workflow: Workflow }`, both `@alwaysUnder(dir)`, and `save` also `@always(name)` (decision 2 above). `dir` in each payload is the real spelling of the workflows directory (`_realDir`), never the text the caller passed.
- `save` is raised once per `writeWorkflow` call, after the check and before the first write. A rejection writes nothing and fails the call. A workflow that fails its check raises no prompt at all.
- The folder layout is `<dir>/<name>/workflow.json` and `<dir>/<name>/meta.json`, with `name` the workflow's own `name` field (decision 23). Both files are written with `JSON.stringify(value, null, 2)`.
- `meta.json` fields follow the toolbox's names: `createdAt` (ISO text from `format(now())`), and `createdBy`. `inputsSchema` is added by ADI-251, not here.
- `writeWorkflow` returns the entry it wrote without reading the directory back, so it raises no `scan`.
- After a `scan` approval, every read that fulfils it uses a non-interrupt primitive: `_glob` for the listing, `_read` for the files. `listWorkflows` raises `scan` and nothing else. `_glob` does not read `.gitignore` files unless asked (`walkDir`'s `respectGitignore` option), and `listWorkflows` does not ask.
- No new code under `lib/runtime/`. The one TypeScript change is an export from `lib/stdlib/workflow/`.

## Two decisions for the owner

The plan review raised these. The plan proceeds on the answer given here; say the word and it changes.

1. **`dir` is both where workflows are saved and the directory a local tool's module path is relative to.** `_checked(workflow, tools, root)` hands `root` to `_toolRefs`, which writes each local tool's import relative to it and refuses a tool whose file is outside it (`lib/stdlib/workflow/tools.ts:56-64`, `120-129`). The spec says the same directory does both jobs ("Tools and modules", "Saving a workflow"), so this plan follows it: a project's workflows are saved as subfolders inside the project, beside the tool modules, and `listWorkflows` on the project directory finds them. Every test here uses `std::math` tools, so nothing in the tests shows this. The docstrings and the dev doc say it plainly ("the project directory: workflows are saved under it, and a local tool's file must be under it too"). If the owner wants a dedicated workflows directory instead, `writeWorkflow` needs a second directory argument for the modules, and `meta.json` must record it so a loaded workflow can be checked again. That is a spec change.
2. **`std::workflow::save` carries `@always(name)` as well as `@alwaysUnder(dir)`.** Saving over an existing name overwrites it (call 1 below), and with only a directory pin a model calling `writeWorkflow` as a tool could replace any saved workflow in that directory with no prompt. Pinning the name too makes an "always" answer mean "this workflow, in this directory", the pin `std::workflow::run` already has. The other way, refusing an existing name and leaving replacement to the TUI, is a one-line change to `writeWorkflow` and the `saveTwiceOverwrites` test if the owner prefers it.

## Calls I made

Marked so the owner can check them while reading. Each is a place the spec is silent.

1. **Saving over an existing workflow overwrites it.** Saving is how a workflow gets edited (the TUI in ADI-255 re-saves), and the `save` prompt shows the name, so the person sees which one is replaced. The toolbox refuses an existing name because a tool is published once; a workflow is not.
2. **A workflow folder that cannot be read fails `listWorkflows`**, with a message naming the folder and the reason, instead of a `broken` field on the entry as the toolbox has. The spec's `WorkflowEntry` has no `broken` field and `workflow` is required. A person then fixes or deletes that one folder.
3. **`createdBy` is the fixed text `"writeWorkflow"`.** The ticket says `meta.json` records "by what" the workflow was saved. Nothing else saves one yet. When the designer (ADI-259) or the TUI saves, they can get a parameter then.
4. **The two writes are not atomic.** The toolbox stages a draft and publishes it with one rename because a tool has four files and model calls between them. A workflow is two small files written back to back with no prompt between them. If the second write fails, the call fails and says so.

## Review Focus

Inputs the spec implies and no test in the ticket exercises. Each gets a test in the task named.

1. `listWorkflows` on a directory that does not exist yet: an empty list, not a failure, as the toolbox does. (Task 3)
2. `loadWorkflow("../x", dir)` or any name that is not an identifier: a failure with parse's message, and no `scan` prompt. (Task 3)
3. `loadWorkflow` of a name whose folder is missing: a failure naming the name and directory. (Task 3)
4. A `workflow.json` that is valid JSON but not a workflow (missing `steps`): `loadWorkflow` fails with the shape message, and `listWorkflows` on that directory fails naming the folder. (Task 3)
5. Saving a workflow twice: the second save overwrites, the folder is listed once. (Task 2)

---

### Task 1: The name check, exported

**Files:**
- Modify: `lib/stdlib/workflow/parse.ts` (export `nameMessage`, or a wrapper of it)
- Modify: `lib/stdlib/workflow/index.ts` (re-export)
- Test: `lib/stdlib/workflow/parse.test.ts`

**Interfaces:**
- Produces: `_workflowNameProblem(name: string): string | null`, exported from `lib/stdlib/workflow/index.ts`. Null for a name that may be a workflow folder; otherwise the message parse gives for the workflow's `name` field.

- [ ] **Step 1: Write the failing test**

In `parse.test.ts`:

```ts
describe("_workflowNameProblem", () => {
  it("accepts an identifier and refuses anything else with parse's message", () => {
    expect(_workflowNameProblem("updateMealPlan")).toBeNull();
    expect(_workflowNameProblem("../x")).toBe('name "../x" is not an identifier');
    expect(_workflowNameProblem("__x")).toMatch(/reserved/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:run lib/stdlib/workflow/parse.test.ts > /tmp/adi250-t1.log 2>&1; tail -15 /tmp/adi250-t1.log`

- [ ] **Step 3: Implement**

In `parse.ts`, `export function _workflowNameProblem(name: string): string | null { return nameMessage("name", name); }`. Re-export it from `index.ts` beside `_toolRefs`.

- [ ] **Step 4: Run it to verify it passes, then commit**

```bash
pnpm run typecheck && pnpm run fmt:ts
git add lib/stdlib/workflow/parse.ts lib/stdlib/workflow/parse.test.ts lib/stdlib/workflow/index.ts
git commit -F /tmp/adi250-c1.txt
```

Commit message: `std::workflow: export the name check for loadWorkflow`.

---

### Task 2: `writeWorkflow` and the `save` effect

**Files:**
- Modify: `stdlib/workflow.agency`
- Modify: `lib/typeChecker/alwaysTag.stdlib.test.ts` (two rows, beside `std::workflow::run`)
- Create: `tests/agency/workflow/save.agency`, `tests/agency/workflow/save.test.json`

**Interfaces:**
- Produces, in `stdlib/workflow.agency`:

```
export type WorkflowMeta = {
  createdAt: string;
  createdBy: string
}

export type WorkflowEntry = {
  name: string;
  dir: string;
  workflow: Workflow;
  meta: WorkflowMeta
}

@alwaysUnder(dir)
effect std::workflow::scan {
  dir: string
}

@alwaysUnder(dir)
@always(name)
effect std::workflow::save {
  dir: string;
  name: string;
  workflow: Workflow
}

export def writeWorkflow(workflow: Workflow, tools: any[], dir: string): Result<WorkflowEntry>
```

  plus the private pieces Task 3 reuses: `WORKFLOW_FILE`, `META_FILE`, `MAX_WORKFLOWS` (500, as the toolbox), `expandRoot(dir: string): Result<string>`, and `DEFAULT_META`.

- `dir` on the returned entry is `"${root}/${name}"`, the workflow's own folder, as the toolbox's `ToolEntry.dir` is.

- [ ] **Step 1: Add the `alwaysTag` rows and watch them fail**

In `lib/typeChecker/alwaysTag.stdlib.test.ts`, beside the `std::workflow::run` row:

```ts
  // A directory of saved workflows: reading it pins the directory. Saving
  // pins the workflow's name too, since a save replaces a workflow of
  // that name, so "always" means this workflow in this directory.
  "std::workflow::scan": ["dir/**"],
  "std::workflow::save": ["name", "dir/**"],
```

Run: `pnpm test:run lib/typeChecker/alwaysTag.stdlib.test.ts > /tmp/adi250-t2a.log 2>&1; tail -15 /tmp/adi250-t2a.log`
Expected: fails, the effects do not exist yet.

- [ ] **Step 2: Write the failing Agency test**

`tests/agency/workflow/save.agency`:

```
// Saving a workflow: the full check runs first, one std::workflow::save
// prompt gates the writes, and a saved workflow loads and lists back.
// No node here calls a model.
import { writeWorkflow, loadWorkflow, listWorkflows, Workflow, WorkflowEntry } from "std::workflow"
import { add, multiply } from "std::math"
import { remove } from "std::fs"
import { exists } from "std::shell"
import { resolve } from "std::path"
import { Json } from "std::validation"
import { getMutable, setMutable } from "../../helpers/mutableVar.js"

const OUT = __dirname + "/test-output"
const TOOLS = [add, multiply]

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

/** A workflow the check refuses: `subtract` is not in TOOLS. */
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
  remove(OUT + "/${name}") with approve
}

/** The failure's message, or "" for a success. */
def errorOf(result: Result<any>): string {
  if (result is failure(err)) {
    return "${err}"
  }
  return ""
}

/** Saves `workflow`, recording every effect raised in "effects" and each
  payload under its effect's name. A null `saveVerdict` rejects the save. */
def runSave(workflow: Workflow, saveVerdict: string | null = "approve"): Result<WorkflowEntry> {
  setMutable("effects", [])
  handle {
    return writeWorkflow(workflow, TOOLS, OUT)
  } with (intr) {
    getMutable("effects", []).push(intr.effect)
    setMutable(intr.effect, intr.data)
    if (intr.effect == "std::workflow::save" && saveVerdict == null) {
      return reject("cancelled by the test")
    }
    return approve()
  }
}

node saveThenLoadAndList(): Json {
  cleanup("doubleSum")
  const saved = runSave(doubleSum("doubleSum"))
  const loaded = loadWorkflow("doubleSum", OUT) with approve
  const listed = listWorkflows(OUT) with approve
  const files = [exists("doubleSum/workflow.json", OUT), exists("doubleSum/meta.json", OUT)]
  cleanup("doubleSum")
  if (saved is failure || loaded is failure || listed is failure) {
    return ["failed", saved catch null, loaded catch null, listed catch null]
  }
  const names = map(listed.value, \entry -> entry.name)
  return [
    saved.value.name,
    saved.value.dir == resolve(OUT) + "/doubleSum",
    saved.value.meta.createdBy,
    loaded.value.workflow.steps.length,
    loaded.value.meta.createdAt == saved.value.meta.createdAt,
    names,
    files
  ]
}

node savePayload(): Json {
  cleanup("shown")
  runSave(doubleSum("shown"))
  cleanup("shown")
  const payload = getMutable("std::workflow::save", null)
  return [payload.dir == resolve(OUT), payload.name, payload.workflow.description]
}

node effectsInOrder(): Json {
  cleanup("ordered")
  runSave(doubleSum("ordered"))
  cleanup("ordered")
  return getMutable("effects", [])
}

node badWorkflowAsksNothingAndWritesNothing(): Json {
  cleanup("bad")
  const result = runSave(badWorkflow("bad"))
  const written = exists("bad", OUT)
  return [isFailure(result), getMutable("effects", []), written]
}

node rejectedSaveWritesNothing(): Json {
  cleanup("rejected")
  const result = runSave(doubleSum("rejected"), null)
  const written = exists("rejected", OUT)
  return [isFailure(result), written]
}

node saveTwiceOverwrites(): Json {
  cleanup("twice")
  runSave(doubleSum("twice"))
  const second: Workflow = { ...doubleSum("twice"), description: "Second save." }
  const saved = runSave(second)
  const loaded = loadWorkflow("twice", OUT) with approve
  const listed = listWorkflows(OUT) with approve
  cleanup("twice")
  const count = filter(listed catch [], \entry -> entry.name == "twice").length
  let description = ""
  if (loaded is success(entry)) {
    description = entry.workflow.description
  }
  return [isSuccess(saved), description, count]
}

node emptyDirIsRefused(): boolean {
  const result = writeWorkflow(doubleSum("x"), TOOLS, "") with approve
  return errorOf(result) =~ re/dir/
}
```

`save.test.json`, one case per node, all `"type": "exact"`:

| node | expectedOutput |
|---|---|
| `saveThenLoadAndList` | `["doubleSum",true,"writeWorkflow",2,true,["doubleSum"],[true,true]]` |
| `savePayload` | `[true,"shown","Add two numbers and double the sum."]` |
| `effectsInOrder` | `["std::workflow::save"]` |
| `badWorkflowAsksNothingAndWritesNothing` | `[true,[],false]` |
| `rejectedSaveWritesNothing` | `[true,false]` |
| `saveTwiceOverwrites` | `[true,"Second save.",1]` |
| `emptyDirIsRefused` | `true` |

`saveThenLoadAndList` and `saveTwiceOverwrites` need `loadWorkflow` and `listWorkflows` from Task 3, and the file imports both, so it does not compile until the names exist. Task 2 Step 4 adds them as stubs; Task 3 replaces the stubs. The `effectsInOrder` expectation changes in ADI-251, when the schema subprocess adds `std::run` after the save.

- [ ] **Step 3: Run it to verify it fails**

Run: `make > /tmp/adi250-make.log 2>&1; pnpm run agency test tests/agency/workflow/save.test.json > /tmp/adi250-t2.log 2>&1; tail -30 /tmp/adi250-t2.log`
Expected: compile error, `writeWorkflow` is not exported.

- [ ] **Step 4: Implement `writeWorkflow`**

In `stdlib/workflow.agency`, add the imports (`now`, `format` from `std::date`; `exists` from `std::shell`; `filterEntries` from `std::object`; `_glob` from `agency-lang/stdlib-lib/shell.js`; `_read`, `_write` from `agency-lang/stdlib-lib/builtins.js`; `_realDir`, `_mkdir` from `agency-lang/stdlib-lib/fs.js`; `_workflowNameProblem` from the workflow index), the constants, the two types, and the two effects with a comment above each saying what it gates and why `dir` is the real spelling. Then:

```
// Every entry point takes the workflows directory the same way. An empty
// string is refused because the file primitives would resolve it to the
// process cwd. The real spelling is what every prompt names, so one
// "always" answer covers the reads and writes that fulfil it.
@capabilities(fileRead)
def expandRoot(dir: string): Result<string> {
  if (dir == "") {
    return failure("dir must name the workflows directory; got an empty string")
  }
  return try _realDir(dir)
}

@capabilities(fileRead, fileWrite)
export def writeWorkflow(workflow: Workflow, tools: any[], dir: string): Result<WorkflowEntry> {
  """
  Save a workflow into a project directory, as `<dir>/<name>/workflow.json` and `meta.json`, after the full check and one `std::workflow::save` prompt. A workflow with problems is not saved and asks nothing. Saving a name that exists replaces it.

  @param workflow - The workflow to save. Its `name` names the folder
  @param tools - The functions the workflow may call, for the check
  @param dir - The project directory: the workflow is saved under it, and a local tool's file must be under it too, since the saved workflow imports the tool by a path relative to it
  """
  ...
}
```

The body in order: `expandRoot`; `_checked(workflow, tools, root)`, returning its failure with `failure(checked.error, checked.data)` as `checkWorkflow` does; the `save` interrupt with `{ dir: root, name: workflow.name, workflow: workflow }`; build `meta: WorkflowMeta = { createdAt: format(now()), createdBy: "writeWorkflow" }`; create the folder with `try _mkdir("${root}/${workflow.name}")` (the host's `mkdir` is recursive, so an existing folder is not an error and needs no check); `try _write(root, "${workflow.name}/${WORKFLOW_FILE}", JSON.stringify(workflow, null, 2), "overwrite")` then the same for `META_FILE`; return `success({ name: workflow.name, dir: "${root}/${workflow.name}", workflow: workflow, meta: meta })`.

The writes after the prompt go in a `destructive { }` region, as `writeToolFile` in the toolbox does, so a retry after the first write cannot be mistaken for a fresh call.

Also add the two Task 3 exports as stubs, each returning `failure("not built")` with the Task 3 signature and no docstring yet, so `save.agency` compiles. Task 3 replaces them.

- [ ] **Step 5: Build, run, and check**

Run: `make > /tmp/adi250-make.log 2>&1; pnpm test:run lib/typeChecker/alwaysTag.stdlib.test.ts > /tmp/adi250-t2a.log 2>&1; pnpm run agency test tests/agency/workflow/save.test.json > /tmp/adi250-t2.log 2>&1; tail -40 /tmp/adi250-t2.log`
Expected: the `alwaysTag` test passes; `savePayload`, `effectsInOrder`, `badWorkflowAsksNothingAndWritesNothing`, `rejectedSaveWritesNothing`, and `emptyDirIsRefused` pass; `saveThenLoadAndList` and `saveTwiceOverwrites` fail on the stubs until Task 3.

- [ ] **Step 6: Commit**

```bash
pnpm run typecheck && pnpm run fmt:ts
git add stdlib/workflow.agency lib/typeChecker/alwaysTag.stdlib.test.ts tests/agency/workflow/save.agency tests/agency/workflow/save.test.json
git commit -F /tmp/adi250-c2.txt
```

Commit message: `std::workflow: writeWorkflow and the save effect`.

---

### Task 3: `loadWorkflow`, `listWorkflows`, and the `scan` effect

**Files:**
- Modify: `stdlib/workflow.agency`
- Modify: `tests/agency/workflow/save.agency`, `save.test.json` (the Review Focus nodes)
- Create: `tests/agency/workflow/fixtures/saved/notAWorkflow/workflow.json` holding `{ "format": 1, "name": "notAWorkflow" }` and no `meta.json`

**Interfaces:**
- Consumes: `expandRoot`, `WORKFLOW_FILE`, `META_FILE`, `MAX_WORKFLOWS`, `DEFAULT_META`, the `scan` effect from Task 2; `_workflowNameProblem` from Task 1.
- Produces:

```
export def loadWorkflow(name: string, dir: string): Result<WorkflowEntry>
export def listWorkflows(dir: string): Result<WorkflowEntry[]>
```

  and the private `entryFor(root: string, name: string): Result<WorkflowEntry>`, which ADI-251 extends.

- [ ] **Step 1: Add the failing tests**

Append to `save.agency`:

```
node missingDirListsNothing(): Json {
  const listed = listWorkflows(__dirname + "/no-such-dir") with approve
  return [isSuccess(listed), (listed catch []).length]
}

node badNameIsRefusedBeforeAsking(): Json {
  setMutable("effects", [])
  let result: Result<WorkflowEntry> = failure("not run")
  handle {
    result = loadWorkflow("../x", OUT)
  } with (intr) {
    getMutable("effects", []).push(intr.effect)
    return approve()
  }
  return [isFailure(result), errorOf(result) =~ re/not an identifier/, getMutable("effects", [])]
}

node missingWorkflowFails(): boolean {
  const result = loadWorkflow("noSuchWorkflow", OUT) with approve
  return errorOf(result) =~ re/noSuchWorkflow/
}

node notAWorkflowFailsToLoadAndList(): Json {
  const saved = __dirname + "/fixtures/saved"
  const loaded = loadWorkflow("notAWorkflow", saved) with approve
  const listed = listWorkflows(saved) with approve
  return [isFailure(loaded), isFailure(listed), errorOf(listed) =~ re/notAWorkflow/]
}

// Compares against resolve(OUT), which equals _realDir(OUT) only when no
// path segment is a symlink. run.agency relies on the same thing for the
// run payload.
node scanPayloadIsTheWorkflowFolder(): Json {
  cleanup("scanned")
  runSave(doubleSum("scanned"))
  setMutable("effects", [])
  handle {
    loadWorkflow("scanned", OUT)
  } with (intr) {
    setMutable(intr.effect, intr.data)
    return approve()
  }
  cleanup("scanned")
  return getMutable("std::workflow::scan", null).dir == resolve(OUT) + "/scanned"
}
```

Cases in `save.test.json`:

| node | expectedOutput |
|---|---|
| `missingDirListsNothing` | `[true,0]` |
| `badNameIsRefusedBeforeAsking` | `[true,true,[]]` |
| `missingWorkflowFails` | `true` |
| `notAWorkflowFailsToLoadAndList` | `[true,true,true]` |
| `scanPayloadIsTheWorkflowFolder` | `true` |

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm run agency test tests/agency/workflow/save.test.json > /tmp/adi250-t3.log 2>&1; tail -40 /tmp/adi250-t3.log`

- [ ] **Step 3: Implement**

Follow `metaFacts`, `entryFor`, `isToolDir`, `toolNames`, and `listTools` in `stdlib/toolbox.agency:307-440`, with these differences:

- `readJsonFile(root: string, path: string): Result<Json>`: `_read`, then `try JSON.parse`, each failure naming the file. Used for both files.
- `entryFor(root, name)`: `workflow.json` is required; read it and check `const file: Workflow! = parsed`. `meta.json` is optional: missing means `DEFAULT_META` (`createdAt: ""`, `createdBy: ""`), present and wrong means a failure. Validation fills a missing optional field with null, and null would win over the default in a spread, so keep only the present fields with `filterEntries(file.value, isPresent)` from `std::object`, where `isPresent(value: Json, key: string): boolean` is `value != null` (a named def, as `tests/agency/stdlib/object-filterEntries.agency` passes one), and spread that over `DEFAULT_META`. Every failure message from `entryFor` starts with the workflow's name, so a caller can return it as it is.
- `loadWorkflow(name, dir)`: `_workflowNameProblem(name)` first, failing with its message and raising nothing; then `expandRoot`; then `if (!exists(name, root))` fail with `"no workflow named ${name} in ${root}"`; then `interrupt std::workflow::scan("Read the saved workflow ${name}?", { dir: "${root}/${name}" })`; then `entryFor`. Put a comment on the `exists` check: it runs before the prompt so a missing workflow fails with a message instead of asking first, the one check `ls`, `grep`, and `glob` make before their interrupt (`docs/dev/stdlib/grep-flags.md`).
- `listWorkflows(dir)`: `expandRoot`; a root that does not exist is `success([])`; `interrupt std::workflow::scan(..., { dir: root })`; then `try _glob(root, ".", "*/${WORKFLOW_FILE}", MAX_WORKFLOWS + 1)` (`"."` is how `_glob` spells the root itself; `relativeTo` in `lib/stdlib/shell.ts:299` special-cases it), which finds exactly the folders that hold a workflow file, and the too-many check as `toolNames` does it. The folder name is the path's first segment: `map(paths, \path -> path.split("/")[0])`. A glob `*` compiles to `[^/]*` (`shell.ts:651`), which matches a dot-led name, so keep `filter(names, \name -> !name.startsWith("."))`, as `isToolDir` does. Then `const entries = map(names, \name -> entryFor(root, name))`, `const broken = find(entries, \entry -> isFailure(entry))`, return `broken` if it is not null, otherwise `success(map(entries, \entry -> entry.value))`.
- Both carry `@capabilities(fileRead)` and docstrings saying they raise one `std::workflow::scan` prompt and nothing else.

- [ ] **Step 4: Build, run, check**

Run: `make > /tmp/adi250-make.log 2>&1; pnpm run agency test tests/agency/workflow/save.test.json > /tmp/adi250-t3.log 2>&1; tail -40 /tmp/adi250-t3.log`
Expected: every case passes, including the two from Task 2.

- [ ] **Step 5: Commit**

```bash
pnpm run typecheck && pnpm run fmt:ts && pnpm run lint:structure
git add stdlib/workflow.agency tests/agency/workflow/save.agency tests/agency/workflow/save.test.json tests/agency/workflow/fixtures/saved
git commit -F /tmp/adi250-c3.txt
```

Commit message: `std::workflow: loadWorkflow, listWorkflows, and the scan effect`.

---

### Task 4: Docs

**Files:**
- Modify: `docs/dev/stdlib/workflow.md`
- Modify: `CLAUDE.md` (the `workflow.md` line in the docs index) and `.claude/skills/agency-stdlib-docs/SKILL.md` (the same line)
- Modify: `docs/site/stdlib/workflow.md` is regenerated by `make`; do not edit it.

- [ ] **Step 1: Add a section "Saving and loading" to the dev doc**, after "Running a workflow". Mechanism and rule only: the folder layout; that `dir` is the project directory, doing both jobs, and what follows for where workflows live; why `save` pins the name as well as the directory; why the directory is realpathed once and both prompts carry that spelling; the order in `writeWorkflow` (check, ask, write) and why the check comes first; why the name needs no check on save and one on load; the overwrite rule; why the listing uses `_glob` after one `scan` prompt, as `std::skills` does, rather than the toolbox's second `std::ls` prompt; what `listWorkflows` does with a folder it cannot read; and that `meta.json` is optional on read.
- [ ] **Step 2: Fix the paragraph under "Running a workflow"** that says the `@always(name)` rule means "this workflow by name" only once workflows are loaded by name, "which the spec leaves to part 3". Now that `loadWorkflow` exists, say that a workflow loaded with `loadWorkflow` has the name of its folder, and one the caller built still has whatever name it was given.
- [ ] **Step 3: Update "Not built yet"** to list `workflowTool`, `workflowTools`, `catalog`, and the inputs schema in `meta.json`.
- [ ] **Step 4: Update the index line** in `CLAUDE.md` and the skill file to mention saving and loading, the two effects, and the overwrite rule.
- [ ] **Step 5: Commit**

```bash
git add docs/dev/stdlib/workflow.md CLAUDE.md .claude/skills/agency-stdlib-docs/SKILL.md docs/site/stdlib/workflow.md
git commit -F /tmp/adi250-c4.txt
```

Commit message: `docs: saving and loading workflows`.

---

### Task 5: PR

- [ ] **Step 1: Anti-pattern pass** over the diff against `docs/dev/contributing/anti-patterns.md`. Watch for: a loop that builds a list where `map` and `filter` do; two places that know the file names (only the constants may); any read or write after the prompt that goes through an interrupt-raising function instead of `_read`/`_write`.
- [ ] **Step 2: Push and open the PR** with the description in a file. Title: `std::workflow: writeWorkflow, loadWorkflow, listWorkflows (ADI-250)`. The description lists the three functions, the two effects and what an "always" answer pins, the four calls above so the owner can object to each, and the test file.
- [ ] **Step 3: Link the PR on ADI-250**, move it to In Review. The owner merges. ADI-251's branch is cut from this one.

## Self-review notes

- Spec coverage: "Saving a workflow" (layout, `writeWorkflow` runs the full check, the two effects with `@alwaysUnder(dir)`, `save` raised once before anything is written) and the three "Public API" signatures are all in Tasks 2 and 3. The inputs schema in `meta.json` is ADI-251.
- Ticket tests: round trip (`saveThenLoadAndList`), failed check writes nothing and asks nothing (`badWorkflowAsksNothingAndWritesNothing`), rejected save writes nothing (`rejectedSaveWritesNothing`), `alwaysTag` rows (Task 2, Step 1).
- Type consistency: `WorkflowEntry.dir` is the workflow's folder in both `writeWorkflow` and `entryFor`; `entryFor` returns a `Result` in Task 3 and ADI-251 keeps that.
- Found in review, not fixed here: `_checked` rebuilds a failed local-module read with `_workflowFailure(signatures.error)` (`stdlib/workflow.agency:152-155`), which drops the failure's `rejected` flag, so a rejected `std::read` reads to the model as an ordinary error (PR #1318 explains the flag). `writeWorkflow` inherits it. It is a one-line change to an existing function, filed as its own Linear ticket under the Workflows project rather than folded in here.
- `expandRoot` is three lines that `stdlib/toolbox.agency` also has. Lifting it into a module both import would touch the toolbox, which this ticket leaves alone; worth a small follow-up once `std::skills` (which has the same `_realDir` step four times) is in the same change.
