# `std::workflow`

A workflow is a JSON list of steps. Each step calls a tool or asks a model, and a later step's arguments can point at an earlier step's value. `compileWorkflow` turns a workflow into an Agency program. `checkWorkflow` typechecks and compiles that program and reports each problem by step and field. `runWorkflow` checks a workflow, asks, and runs its program in a subprocess.

The format, and the two rules that keep it small, are in `docs/superpowers/specs/2026-10-26-workflows-design.md`.

Here is one step, and the code it becomes:

```json
{
  "id": "text",
  "kind": "tool",
  "module": "./notes.agency",
  "tool": "readNote",
  "args": { "id": { "$ref": "steps.note[0].id" } }
}
```

```
const step_text_id = step_note.value[0].id
const step_text = readNote(id: step_text_id)
if (step_text is failure) {
  return failure("step text (readNote): ${step_text.error}", { step: "text", cause: step_text })
}
```

The program's `main` takes `inputs: Inputs!`. The `!` makes the node check its argument against the `Inputs` type before the first step runs, so `{ noteTitle: 5 }` fails with a message naming `inputs` before any step runs.

## The four stages

The generator is four pure functions in `lib/stdlib/workflow/`, one file each:

1. `parse.ts` checks the JSON's shape and returns a typed `Workflow`. The shape is a zod schema. The rules zod cannot state, such as a name being an identifier or a reference path being well formed, are refinements on it. Every issue becomes a problem named by step and field, from the issue's path.
2. `resolve.ts` checks the workflow against the host's tools and their signatures. It finds a tool the host did not pass, a reference to a later step or an unknown input, and generated names that collide. Its output holds every fact the next stage needs.
3. `lower.ts` turns each generated statement into a template fragment that records the step and field it belongs to.
4. `render.ts` prints each fragment, places the prints in a fixed scaffold, and works out which lines each fragment covers from the same prints.

`index.ts` runs the four in order and holds the helpers `stdlib/workflow.agency` imports. The Agency side reads each local tool module with `read`, which raises `std::read`, and passes what `describe` says about it to the stages as data.

## How workflow text enters the program

Workflow text reaches the generated source through three doors:

1. **A value** (an argument, the prompt, a context label) goes through `literal()` in `shapes.ts`, which calls `liftValue`. That turns the value into a literal node and never parses it. It happens before `fill`, because `fill` grafts a value shaped like a `Code` fragment as code.
2. **A name** (a step id, tool name, argument name, input name) passes `isIdentifier` in parse. `statement()` in `shapes.ts` checks it again before writing it into a shape. Every generated statement comes from the `SHAPES` table through `statement()`.
3. **Type text** (`inputs`, and an LLM step's `output`) goes through `typeText.ts`. It is parsed as `type <Name> = <text>` with the real type parser; the result must be exactly one type alias with that name, and the line written into the program is that alias printed by `signatureOf`, the printer `describe` uses. Parse runs this check and reads the input names from the same parse, so a nested property is never an input. Render prints from the same parse.

Type text may not carry a `@validate` or `@jsonSchema` tag. A `@validate` names a function the generated program would call, and the workflow would be choosing it from the tools it imports.

An LLM step is a `let` of the output type, then a `thread` block that makes the call and assigns it:

```
let step_meals: Step_meals_output = null as Step_meals_output
thread {
  const step_meals_reply: Step_meals_output = llm("..." + step_meals_context1_text)
  step_meals = step_meals_reply
}
```

A `thread` block's value is its message list. A `return` inside the block returns from the enclosing node, so `const x = thread { return llm(...) }` would end `main` with the model's raw text. Only the type on an `llm()` call's own declaration gives the call a structured-output schema. A type on an outer `const` does not reach it. So the reply is a typed `const` inside the block, the step's local is a `let` declared before it, and the cast on `null` is the one way to declare a `let` of the output type with no value yet. The reply local, `step_<id>_reply`, is a generated name like any other.

An LLM step's context values reach the model as text. Each one is bound to a local, then a second local holds what the model reads: the string itself when the value is a string, so a note body keeps its line breaks, and `JSON.stringify` of it otherwise. The prompt is the step's text followed by a label and that text local for each context value. The text local is a generated name like any other, `step_<id>_context<n>_text`, so `declaredBy` lists it and a step id that would coincide with it is refused.

A reference becomes an expression built from a generated name, `.value`, and a path that matched `REF_PATH`. A list or object argument that holds a reference is built by `list()` and `record()` from generated hole names. Its keys are written as names, so an object that holds a reference must have identifier keys.

## Why the scaffold is fixed text

When a filler mentions a name the template binds, `fill` renames the template's binder. A node parameter counts as a binder. Filling a hole inside `node main(inputs: Inputs)` with statements that read `inputs` would rename the parameter to `__hyg1_inputs` and leave the body's `inputs` unbound. So `SCAFFOLD` and `GUARDED_SCAFFOLD` in `render.ts` are string constants, and the body goes into them with one regex pass.

The fragments are templates too, so the same rule applies to them. Two rules in resolve keep `fill` from renaming anything:

1. Every name the body declares comes from `names(id)` and starts with `step_` or `Step_`. A step named `failure` declares `step_failure`, which shadows nothing.
2. Generated names are all different from each other and from every imported tool. Resolve refuses a workflow where two collide, such as a step `note` with an argument `query` next to a step `note_query`.

Resolve also refuses a tool whose name the scaffold or the shapes use, such as `failure`, `llm`, or `inputs`. Importing it would shadow that name.

## Return types and the failure check

Every tool step is followed by a check that stops the workflow on a failure and names the step. Every tool gets the check, because Agency turns a thrown error into a failure, so a tool typed `string[]` can still fail.

Whether a tool returns a `Result` comes from the `returnsResult` flag `describe` prints. `describe` resolves the declared return type through the module's own aliases, so `def find(): NoteResult` with `type NoteResult = Result<Note>` counts. The flag decides two things:

1. A reference into a step that returns a `Result` adds `.value`. A reference into a plain value does not.
2. A tool not typed `Result` gets the `checkPlain` shape, whose message reads `(step_x as any).error`, because a plain type has no `.error`.

A tool whose return type says nothing about the value gets a warning: no declared type, `any`, or `Json`. References into its value are only checked at run time. A `Result<Json>` gets the same warning, because a reference into the step reads `.value`, which is `Json`. So does a bare `Result`, whose value has no type. The list is `UNTYPED` in `resolve.ts`, and `valueType` strips the `Result` wrapper before the lookup.

`describe` can read a return type only from source it can see. It cannot read a `pkg::` module from a re-export line, or a local file a tool module re-exports from, so both are refused: a package tool in `toolRefs`, and a re-exported name in `_pickSignatures`.

## Line ranges and diagnostics

Every argument is bound to its own `const` before the call:

```
const step_note_query = inputs.noteTitle
const step_note = searchNotes(query: step_note_query)
```

A type error in an argument then lands on that argument's line. `render.ts` counts the lines of each fragment's print and records the range each one covers. The type declarations and the `return success(...)` line get ranges too, owned by `inputs`, a step's `output`, and `result`. `problemsFromDiagnostics` finds the range that holds a diagnostic's line. A diagnostic's line is 0-based and the ranges are 1-based.

A diagnostic about a type alias can come with no line. Its `params.context` names the alias, and `typeOwners` maps that name to `inputs` or the step's `output`.

A diagnostic on the call line belongs to the field `args`. When its code is one of the argument diagnostics in `ARGUMENT_DIAGNOSTICS` (`problems.ts`), the field becomes `args.<argument>`, with the argument read from the payload field that table names: `name` for the name the call wrote, `param` for the parameter a mistyped argument was matched to. The message text is never parsed.

`checkWorkflow` runs `typecheck` before `compile`. A strict compile reports type errors too, but as one message with no line, so it runs second.

## Running a workflow

`runWorkflow(workflow, inputs, tools, dir)` does three things in order:

1. **Check.** `_checked` is the body `checkWorkflow` also uses: generate, typecheck, compile. It keeps the compiled program, so a run never compiles twice. A workflow with problems fails here and asks nothing.
2. **Ask.** It raises `std::workflow::run` with the workflow's name, `dir`, and the inputs. The effect is tagged `@alwaysUnder(dir)` and `@always(name)`, so an "always" answer pins the directory and the workflow's name. The inputs are shown for the person to read. They are not pinned, since they change with every run. A rejection returns before any process starts, so `std::run` is never raised.

   `dir` is resolved to an absolute path first, and the check and the run use that same path. A relative `dir` would pin text that names a different directory under a different working directory. The default `""` would pin the pattern `{,/**}`, which matches every absolute path and not the run it was given for. `read` in `std::index` raises its resolved directory for the same reason.

   `name` is a field of the workflow value the caller passed. A caller, or a model calling `runWorkflow` as a tool, can give a new workflow a name the user already approved "always", and that workflow skips this one prompt. Every step still raises its own effects, and `std::run` still asks. A workflow from `loadWorkflow` has the name of its folder. One the caller built has whatever name it was given.
3. **Run.** It calls `run` from `std::agency` on the compiled program's `main` with `{ inputs }`. `run` raises its own `std::run`. The wall clock is the workflow's `maxTime` plus 30 seconds (`wallClockFor` in `limits.ts`), or `null`, which lets `run` apply its own default. The workflow code does not restate that default. `run` succeeds with an envelope whose `data` is what `main` returned, so `runWorkflow` returns that `Result`: the last step's value, or the failure that stopped the workflow, which names the step.

## Saving and loading

`writeWorkflow(workflow, tools, dir)` saves a workflow as two files:

```
<dir>/<name>/workflow.json   the workflow, as given
<dir>/<name>/meta.json       { createdAt, createdBy, inputsSchema }
```

`name` is the workflow's own `name` field. `loadWorkflow(name, dir)` reads one folder back and `listWorkflows(dir)` reads them all. Each returns a `WorkflowEntry`: the name, the folder, the workflow, and the meta record.

**`dir` is the project directory.** It is where the workflow folders go, and it is also the directory a local tool's import path is written relative to (`toolRefs` in `tools.ts`). A local tool whose file is outside `dir` is refused by the check. So a project's workflows are saved as folders inside the project, beside its tool modules. `dir` must already exist, because the check reads the tool modules from it. Only the workflow's own folder is created.

**`writeWorkflow` checks, asks, then writes.**

1. The check is `_checked`, the same generate, typecheck, and compile `runWorkflow` runs. A workflow with problems fails here and raises nothing. The check also proves `name` is an identifier, so it is safe to use as a folder name.
2. It raises `std::workflow::save` with the directory, the name, and the workflow. A rejection writes nothing.
3. It runs the program's `inputsSchema` node once with `run` from `std::agency`, which raises `std::run`. A rejection writes nothing.
4. It creates the folder and writes both files with `_write`, which raises nothing more. The writes sit in a `destructive { }` region.

Saving a name that already exists replaces it. Saving is how a workflow gets edited. The prompt names the workflow, so the person sees which one is replaced. Because a save can replace a workflow, `std::workflow::save` is tagged `@always(name)` as well as `@alwaysUnder(dir)`. An "always" answer means "this workflow, in this directory". With the directory pin alone, a model calling `writeWorkflow` as a tool could replace any saved workflow there with no prompt.

**Reading raises one prompt.** `std::workflow::scan` is tagged `@alwaysUnder(dir)`. `listWorkflows` raises it with the directory and `loadWorkflow` with the workflow's folder. The reads that follow use `_glob` and `_read`, which raise nothing, as `std::skills` does. The toolbox's `listTools` raises a second prompt for its `ls`; this module does not. `_glob` matches `*/workflow.json` and is asked for one more than `MAX_WORKFLOWS`, so a directory with too many is refused instead of cut short. A glob `*` matches a name starting with a dot, so dot folders are dropped by hand.

**Checks before the prompt.** `loadWorkflow` takes its name from the caller, not from a checked workflow, so it checks the name with parse's own rule (`_workflowNameProblem`) before anything else. A name such as `../x` fails with no prompt. It then checks the folder exists, so a missing workflow fails with a message instead of asking first. `ls`, `grep`, and `glob` make the same check before their interrupt (`docs/dev/stdlib/grep-flags.md`). `listWorkflows` on a directory that does not exist returns an empty list.

**The real spelling.** `dir` is resolved once with `_realDir`, and both prompts and every read and write use that spelling. An "always" answer pins text, so the text must be the directory that is actually read and written.

**What a load returns.** `workflow.json` is required and is checked against `Workflow` with `!`. `meta.json` is optional: a missing file gives the default record, and a present file with the wrong shape is a failure. The shape check fills a missing optional field with `null`. For `meta.json`, only the fields the file has are kept, over the defaults. For `workflow.json`, the entry holds the file's own value and not the checked one, because `result: null` is a literal result to the generator: a loaded workflow would return `null` in place of its last step.

**The inputs schema.** An Agency type becomes a JSON Schema only in compiled code, so every generated program has an `inputsSchema` node that returns `schema(Inputs).toJSONSchema()`. `_inputsSchema` runs it on the program `_checked` already compiled, so the workflow is never compiled twice. It runs once, at save time, so `workflowTools` can build typed tools from the files alone, with no child process per workflow each time a host builds its tool list. The child runs with `run`'s default limits: the node calls no tool and no model, so the workflow's own `limits` do not apply.

A `meta.json` with no `inputsSchema` key, saved before the field existed, reads back with `inputsSchema: null`. `Json` is `any`, so the shape check does not look inside the schema. A `meta.json` with a bad schema loads, and `z.fromJSONSchema` refuses it when `workflowTool` uses it.

An optional input becomes a required key that may be null. For `inputs: "{ a: number; b?: number }"` the stored schema is:

```json
{"type":"object",
 "properties":{"a":{"type":"number"},
               "b":{"default":null,"anyOf":[{"type":"number"},{"type":"null"}]}},
 "required":["a","b"],
 "additionalProperties":false}
```

That is how Agency compiles `?`. A model calling a tool built from this schema must send `b: null` to leave `b` out.

**A broken folder fails the listing.** A folder whose `workflow.json` cannot be read, is not JSON, or is not a workflow fails `listWorkflows`, with a message that starts with the folder's name. `WorkflowEntry` has no field for a broken entry, so the person fixes or removes that folder.

## Limits and the step guard

A workflow's `limits` and a step's `limits` take the same two fields, `maxCost` in dollars and `maxTime` in milliseconds, and pass the same rules in parse: each is a positive finite number, and `maxTime` is at most `MAX_TIME` in `limits.ts`, which is `run`'s wall clock ceiling less the 30-second headroom, so the subprocess wall clock never exceeds the ceiling. A guard reads a negative number as "no limit", which is why zero and negatives are refused. A limit must also print as a plain decimal, `PLAIN_DECIMAL` in `limits.ts`: `0.0000001` prints as `1e-7`, which is not an Agency number literal, so parse refuses it and the `limits` token check accepts only that form.

A step's limit may be no larger than the workflow's, because the guard around `main` would trip first and its failure names no step. A step's `maxTime` also needs a workflow `maxTime`: the subprocess wall clock comes from the workflow's `maxTime`, so without one the process is killed at `run`'s default, again naming no step. A step `maxCost` needs no workflow `maxCost`, since nothing else caps cost. Parse refuses a step limit that could not trip, in a message that says what to set.

The workflow's limits become the guard around `main`'s body, written into the scaffold by render. A step's limits become a guard around that one step, named after it:

```
const step_add = guard(label: "add", time: 120000, cost: 0.5) {
  return addListItems(items: step_add_items, listId: step_add_listId, section: step_add_section)
}
if (step_add is failure) {
  return failure("step add (addListItems): ${step_add.error}", { step: "add", cause: step_add })
}
```

Both guards write their limits through `guardArgs` in `shapes.ts`, the one place a limit becomes code. Render joins its pieces for the workflow guard; lower prefixes each with `, ` for a step guard, and the `limits` token check accepts only that form.

A guard always gives a `Result`: a `Result` the block returns passes through, and any other value is wrapped in `success(...)`. So a step with limits holds a `Result` whatever its tool returns. Resolve records this as `holdsResult`, true when the tool returns a `Result` or the step has limits, and lower reads a reference into such a step through `.value`. A trip raises `std::guard` first. A rejection makes the guard return a failure, and the step's ordinary check turns that into the workflow's failure, naming the step and carrying the guard's failure as `cause`.

A guarded LLM step is the same `thread` block inside the guard, with `return <reply>` as its last line instead of an assignment: a `return` inside the thread returns from the guard block, so the guard's `Result` holds the typed reply. The last line is a checked text token on the `llmThread` shape, because a code hole filled with code that names the reply would make template hygiene rename the binder.

## Interrupts and checkpoints

The generator raises nothing itself. `compileWorkflow` and `checkWorkflow` raise `std::read` once for each local module they read. `runWorkflow` raises `std::workflow::run`, then `run` raises `std::run`. `writeWorkflow` raises `std::workflow::save`, then `run` raises `std::run` for the inputs schema, and `loadWorkflow` and `listWorkflows` raise `std::workflow::scan`.

The generated program is ordinary Agency, and it runs in a child process. Each step raises the interrupts its tool raises, and they go up the parent's handler chain, so the caller's handlers and policy answer them. One that no handler answers pauses the child, which saves a checkpoint and exits. The interrupt then surfaces to the user like any other, and a resume starts a fresh child from the checkpoint at the step's line. `tests/agency/workflow/runMealPlan.agency` pins this: the last step's interrupt is left to the test runner to approve, and the resume finishes the workflow. The test does not show that the resume skipped the LLM step. Each child builds its own mock client from the full mock list, so a repeated model call would be answered too.

## Tool modules

`toolRefs` in `tools.ts` turns the host's function values into the module text an import uses. A function value's `module` is a path relative to the working directory it was compiled in. A path under `stdlib/` becomes `std::<name>`. Any other path is rewritten relative to the workflow's `dir`, resolved against the working directory at run time, so a host that runs in a different directory from the one it compiled in can get "outside the workflow directory", or a path to the wrong file.

The module text is written into an import line, so it must match `MODULE_PATH`. A partial, a renamed function, a tool built by `createTool`, a runtime builtin, and a package tool are refused. Every tool that is refused is reported, as one problem each, so an author fixes the whole list at once. Two tools with the same name are refused next, in a problem that names both modules: an import line names a tool by its name, and renaming is refused, so the fix is to rename one def in its file.

## Not built yet

The spec covers these: offering a workflow as a tool (`workflowTool`, `workflowTools`) and `catalog`.
