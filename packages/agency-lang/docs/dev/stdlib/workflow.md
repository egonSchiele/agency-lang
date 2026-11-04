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

A tool whose return type says nothing about the value gets a warning when a step argument, a context value, or the `result` references that step: no declared type, `any`, or `Json`. Such a reference can only be checked at run time. A step nothing references gets no warning, since there is nothing to check. The message names the tool and why its value is untyped, such as `weather returns Result, so a reference into its value is checked only when the workflow runs`. Like every problem's message, it leaves out the step, which goes in `step`. A `Result<Json>` gets the same warning, because a reference into the step reads `.value`, which is `Json`. So does a bare `Result`, whose value has no type. The list is `UNTYPED` in `resolve.ts`, and `valueType` strips the `Result` wrapper before the lookup.

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

   `name` is a field of the workflow value the caller passed. A caller, or a model calling `runWorkflow` as a tool, can give a new workflow a name the user already approved "always", and that workflow skips this one prompt. Every step still raises its own effects, and `std::run` still asks. `loadWorkflow` refuses a file whose workflow's name differs from the file name, so a loaded workflow runs under its file's name. One the caller built has whatever name it was given.
3. **Run.** It calls `run` from `std::agency` on the compiled program's `main` with `{ inputs }`. `run` raises its own `std::run`. The wall clock is the workflow's `maxTime` plus 30 seconds (`wallClockFor` in `limits.ts`), or `null`, which lets `run` apply its own default. The workflow code does not restate that default. `run` succeeds with an envelope whose `data` is what `main` returned, so `runWorkflow` returns that `Result`: the last step's value, or the failure that stopped the workflow, which names the step.

## Saving and loading

`writeWorkflow(workflow, tools, dir)` saves a workflow as one file, `<dir>/workflows/<name>.json`:

```json
{ "workflow": { "format": 1, "name": "mealPlan", ... },
  "meta": { "savedAt": "2026-10-31T12:00:00.000Z", "savedBy": "writeWorkflow",
            "inputsSchema": { "type": "object", ... } } }
```

`loadWorkflow(name, dir)` reads one file back and `listWorkflows(dir)` reads them all. Each returns a `WorkflowEntry`: the name, the file's path, the workflow, and `meta`.

`dir` is the project directory, and it must exist. A local tool's import path is written relative to it, so a local tool whose file is outside `dir` is refused by the check (`toolRefs` in `tools.ts`). Saved workflows go in its `workflows` folder, so a listing only reads files `writeWorkflow` wrote.

`writeWorkflow` checks, asks, then writes:

1. `withoutNullOptionals`, which drops `result`, `limits`, and `raises` when they are null. A shape check (`Workflow!`) fills each absent optional field with null, and the generator reads null as absent. Without this step, a workflow that went through `loadWorkflow` or the designer would be saved with `"limits": null` that no one wrote.
2. `_checked`, the generate, typecheck, and compile `runWorkflow` also runs. A workflow with problems fails here and raises nothing. The check also proves `name` is an identifier, so it is safe in a file name.
3. `std::workflow::save`. A rejection writes nothing.
4. `_inputsSchema`, which runs the program's `workflowSchemas` node with `run` from `std::agency` and keeps the inputs schema. `run` raises `std::run`, and a rejection writes nothing.
5. One `_write` of the file, inside a `destructive { }` region. `_write` raises no prompt of its own.

So a save asks twice. `std::run` has no `@always` tag, so an "always" answer to `save` does not cover it, and its prompt names the program's module and the node `workflowSchemas`, not the workflow. The `recommended` policy approves `std::run`; under `minimal` or `--interactive`, every save shows both prompts.

Saving a name that exists replaces it, which is how a workflow is edited. So `save` is tagged `@always(name)` as well as `@alwaysUnder(dir)`: an "always" answer covers this workflow in this folder. With only the folder pinned, a model calling `writeWorkflow` as a tool could replace any saved workflow there without a prompt.

`listWorkflows` and `loadWorkflow` raise one `std::workflow::scan` for the `workflows` folder. The reads after it use `_glob` and `_read`, which raise nothing. The glob asks for one more than `MAX_WORKFLOWS`, so a folder with too many is refused rather than cut short.

`loadWorkflow` builds a file name from the name its caller passes, so it first checks that name with parse's rule (`_workflowNameProblem`): `../x` fails before anything is read. It then checks the file exists, so a missing workflow fails without a prompt, as `ls`, `grep`, and `glob` do (`grep-flags.md`).

Every payload's `dir` is the real spelling from `_realDir`, because an "always" answer pins text.

`meta.inputsSchema` is the JSON Schema of the workflow's `inputs` type. Only compiled code can turn an Agency type into a JSON Schema, so every generated program has a `workflowSchemas` node that returns `{ inputs, outputs }`: `schema(Inputs).toJSONSchema("input")`, and for each LLM step `schema(Step_<id>_output).toJSONSchema()` under the step's id. `_workflowSchemas` runs it in one subprocess; `_inputsSchema` is that run keeping only `inputs`, on the program `_checked` compiled, once, at save time, so `workflowTools` can build typed tools from the files with no child process per workflow. The child gets `run`'s default limits: the node calls no tool and no model, so the workflow's `limits` do not apply. A file with no `inputsSchema` reads back as `null`. `Json` is `any`, so the load does not check the schema; `z.fromJSONSchema` refuses a bad one when `workflowTool` uses it.

The node asks zod for the schema's input form, which describes what a caller may send. Agency compiles `b?: number` to a key with a default of `null`, and a key with a default is not required in the input form. So for `inputs: "{ a: number; b?: number }"`, `required` is `["a"]`, and `b` is `{ "default": null, "anyOf": [{ "type": "number" }, { "type": "null" }] }`: a model may leave `b` out or send `null`. `Schema.toJSONSchema()` with no argument gives the output form, which describes a parsed value, so there `b` is required.

### `checkWorkflowWithSchemas`

A host that saves workflows itself, as BMO does in a table, needs from one compile what `writeWorkflow` gets in two of its steps: the warnings and the inputs schema. It also needs what an LLM step produces, so an editor can offer a later step the fields of that output. `checkWorkflowWithSchemas(workflow, tools, dir)` is `_checked` followed by `_workflowSchemas`, and returns `{ warnings, inputsSchema, outputSchemas }`. `outputSchemas` is keyed by step id and holds only LLM steps: a tool step's result type is the tool's declared return type, which `catalog` reports as text. An output schema is the output form of the step's type, the value a later step reads. A workflow with problems fails with them before any process starts, so the function raises `std::run` only for a workflow that passed. A rejected or failed run is returned as it came, with `rejected` set and no `problems`, so a host can tell a refusal from a workflow problem the way `catalog` lets it tell a refused read; only the node's own failure becomes a problem. In practice the node does not fail: `parseTypeText` refuses a `regex` anywhere in `inputs` or an LLM step's `output`, naming the field, because JSON Schema cannot express one and the node would fail with zod's message instead of a step and field. It also refuses a type name the program has no binding for, such as `Note` copied from a tool's signature: the program imports its tools and `Json` and nothing else, so the name passes the typecheck and fails in the node with `is not defined` (#1378). A model that copies a type name from the catalog sees that problem inside the draft loop. Writing a union of literals out does not get it through yet: the lowering binds each argument to an inferred `const`, and an inferred declaration widens literal types, so `"screen" | "text"` reaches the call as `string`. That is a separate problem in `lower.ts`, with its own issue. Before this export existed, BMO called `_checked` and `_inputsSchema`, two underscore names a release could rename.

The node is named `workflowSchemas`, so a tool of that name would shadow it and is refused through `PROGRAM_NAMES` (`resolve.ts`), which is checked against the tool a step calls; step ids are always prefixed and can never collide. `inputsSchema` stays in the list although no generated node has that name now, so no tool list refused before passes now.

The input form has no `additionalProperties: false`, so the model is not told that an extra key is refused. Nothing parses a tool call's arguments against the tool's schema, and `main(inputs: Inputs!)` drops an unknown key, so an extra key changes nothing that runs. It does show in the `std::workflow::run` payload. A file saved before the input form was used keeps `b` in `required` until it is saved again.

A loaded file is checked against `{ workflow: Workflow; meta?: ... }` with `!`. Missing `meta` fields take their defaults. A file whose workflow's `name` differs from the file name is refused: `std::workflow::run` names a workflow by its own `name`, so a copied file that kept the old name would run under the old name's "always" answer. A file that fails any check fails `listWorkflows`, with a message that starts with its name.

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

### Every limit is hard

A trip raises `std::guard`, and a handler that approves it gives the guard more budget. So without anything else, a caller's handler or policy could raise a workflow's limits. The scaffold prevents that. It labels the guard around the body with the workflow's name, and wraps `main`'s body in a handler that rejects a trip from any of the workflow's own guards:

```
export node main(inputs: Inputs!): Result {
  handle {
    return guard(label: "updateMealPlanFromNote", time: 300000, cost: 1) {
      ...the steps...
    }
  } with (guardTrip) {
    if (guardTrip.effect == "std::guard" && ["updateMealPlanFromNote", "add"].includes(guardTrip.data.label)) {
      return reject()
    }
    return pass()
  }
}
```

`lower` writes the list as `guardLabels`: the workflow's name when it has limits, and the id of each step with limits, which is its guard's label. Both are identifiers, so render writes them with `JSON.stringify` as Agency string literals.

Every handler in the chain is consulted, and a rejection wins over any approval. So no caller can extend the workflow's guard or a step's. This is what the `@guarded` decorator does for the function it wraps: it rejects a trip with its own label and passes on every other. A `return` inside a `handle` block returns from the enclosing function, so the steps' checks and the final `return success(...)` work unchanged. `guardTrip`, `reject`, and `pass` are in `PROGRAM_NAMES`, so no tool can shadow them.

The handler passes on a trip from a guard inside a tool. A tool's guard sits inside the step's guard and the workflow's, so a caller who extends it is still stopped at the workflow's limits. What a caller can extend is only the tool's own budget, up to the workflow's, which is what they can do when they call that tool directly. A tool that extends its own guard keeps working too. `supervise()` does that at each check:

```
supervise(every: 5m, maxTime: 30m, check: myCheck) {
  return codingAgent(task, maxTime: 30m)
}
```

A tool's own trip still travels up the chain, so a caller whose policy rejects `std::guard`, as the catch-all in `agency workflow run` does, stops the tool at its first check. A tool guard whose label matches a step id is rejected too, which is the safe direction for a collision. An earlier version rejected every `std::guard`, which stopped `supervise` at its first check and bought nothing.

The tests are in `tests/agency/workflow/runMealPlan.agency`. In `stepLimitIsHard` and `workflowLimitIsHard`, the caller approves every trip with more time, and the workflow still stops. In `toolExtendsItsOwnGuard`, a tool extends its own 100 ms guard, and the workflow finishes. Their tool is `busyEcho`, which works for a second without sleeping. A time trip during `sleep()` skips every handler (ADI-137), so a tool that sleeps passes these tests with or without the scaffold's handler.

### Guarded LLM steps

A guarded LLM step is the same `thread` block inside the guard, with `return <reply>` as its last line instead of an assignment: a `return` inside the thread returns from the guard block, so the guard's `Result` holds the typed reply. The last line is a checked text token on the `llmThread` shape, because a code hole filled with code that names the reply would make template hygiene rename the binder.

## What a workflow may raise

A workflow may list the effects it is allowed to raise, in a `raises` field. It works like an Agency function's `raises` clause (`docs/site/guide/effects-and-raises.md`):

| `raises` | Meaning |
| --- | --- |
| left out, or null | The workflow may raise anything. |
| `[]` | It may raise nothing. |
| `["std::read", "FileWrite"]` | It may raise at most these. |
| `["*"]` | It may raise anything. |

A name of a built-in set from `std::effectSets` stands for every effect in the set. `expandEffectNames` in `lib/runtime/effectSets.ts` does that expansion, and the `--approve` and `--reject` flags use the same function. A bare `interrupt("...")` raises the effect named `unknown`, so a workflow that calls a tool with one allows it by listing `"unknown"`. Only the built-in sets expand. A set a user declared with `effectSet` is read as one effect name, because a workflow does not name the module that declares it.

Parse checks the shape: a list whose entries are `*` or effect names (`EFFECT_NAME` in `types.ts`). The check itself is a rule in `resolve.ts`. The effects of each tool step come from `stepEffects` in `effects.ts`, which reads each tool's `effects` as `describe` reports them and drops `std::guard`, since the program rejects its own guard trips. Each effect outside the list is a problem on that step's `tool` field, the field the author would change:

```text
step add, tool: addListItems raises "test::lists::add", which the workflow's raises does not allow
```

The check lives in `resolve`, not in the type checker's AG3013, for two reasons. AG3013 would point at `main`, not at the step. And it would count `std::guard`, which `stepEffects` leaves out.

Like Agency's own `raises`, this is static analysis made before the workflow runs. It can miss an effect, such as one raised through a function passed as a value (`docs/dev/compiler/effect-propagation.md`). It never reports an effect the tool cannot raise. The safety while running comes from the caller's handlers and policy.

## Interrupts and checkpoints

The generator raises nothing itself. `compileWorkflow` and `checkWorkflow` raise `std::read` once for each local module they read. `runWorkflow` raises `std::workflow::run`, then `run` raises `std::run`. `writeWorkflow` raises `std::workflow::save`, then `run` raises `std::run` for the inputs schema. `workflowTool` raises `std::read` for each local module and `std::run` for the inputs schema. `loadWorkflow`, `listWorkflows`, and `workflowTools` raise `std::workflow::scan`.

The generated program is ordinary Agency, and it runs in a child process. Each step raises the interrupts its tool raises, and they go up the parent's handler chain, so the caller's handlers and policy answer them. One that no handler answers pauses the child, which saves a checkpoint and exits. The interrupt then surfaces to the user like any other, and a resume starts a fresh child from the checkpoint at the step's line. `tests/agency/workflow/runMealPlan.agency` pins this: the last step's interrupt is left to the test runner to approve, and the resume finishes the workflow. The test does not show that the resume skipped the LLM step. Each child builds its own mock client from the full mock list, so a repeated model call would be answered too.

## Tool modules

`toolRefs` in `tools.ts` turns the host's function values into the module text an import uses. A function value whose module id is under `stdlib/` becomes `std::<name>`. Any other tool is local. Its import path comes from its source file, the absolute path of the `.agency` file it was defined in (`sourceFile`, see [agency-function.md](../language/agency-function.md)), written relative to the workflow's `dir`:

```
dir:         /proj/agent
sourceFile:  /proj/agent/tools/notes.agency
module text: ./tools/notes.agency
```

A relative `dir` is read against the working directory at run time. The source file does not depend on the working directory, so a host finds its tools wherever it runs from. A local tool whose source file is outside `dir` is refused. A tool with no source file is refused too. Four kinds of function value reach this check with none: one from a module compiled by an older Agency, which recompiling fixes; one from a program `run` compiled for a subprocess; a block; and the stub a checkpoint revives for a function whose module the process never loaded.

A tool's module may import other local `.agency` files inside `dir`. `_signatures` reads the module with `read`, which raises the one `std::read` prompt, and then calls `describe(text, dir: dir, filename: module)`. With a path, `describe` checks the module's imports as a sandboxed compile checks them, and then resolves them against the module's own folder, so effects that come through a local helper are counted. The imported files are read without prompts of their own, as `_checked`'s type check already reads them. Text with no path cannot resolve a relative import, and before this a tool whose module imported a helper could not be used in any workflow.

A tool whose module imports TypeScript works only when the host names the module's directory in `sandbox.trustedModules`. `describeGroup` and `_checked` call `_describeTrusted`, `_typecheckTrusted`, and `_compileTrusted` from `lib/stdlib/workflow/trusted.ts`, which pass the host's list; the public `describe`, `typecheck`, and `compile` pass none. A tool loaded from the trusted `compiled` directory records a source file beside its compiled file, so `toolRefs` maps it back to the `source` directory. See [trusted-modules.md](../runtime/trusted-modules.md).

One limit remains. A return type that names a type alias imported from another file is not recognized as a `Result`, because `describe` resolves aliases only in the module's own file. The strict type check in `_checked` catches the mistakes this causes.

The module text is written into an import line, so it must match `MODULE_PATH`. A partial, a renamed function, a tool built by `createTool`, a runtime builtin, and a package tool are refused. Every tool that is refused is reported, as one problem each, so an author fixes the whole list at once. Two tools with the same name are refused next, in a problem that names both modules: an import line names a tool by its name, and renaming is refused, so the fix is to rename one def in its file.

## The catalog

`catalog(tools, dir)` describes each tool a workflow may call. Here is the entry for `round` from `std::math`:

```json
{
  "module": "std::math",
  "name": "round",
  "description": "Round a number to a given number of decimal places. With no precision it\n  rounds to a whole number.",
  "params": [
    { "name": "num", "type": "number", "default": null,
      "description": "The number to round", "schema": { "type": "number" } },
    { "name": "precision", "type": "number", "default": "0",
      "description": "The number of decimal places. Defaults to 0.",
      "schema": { "anyOf": [{ "type": "number" }, { "type": "null" }], "description": "Default: 0" } }
  ],
  "returns": "number",
  "effects": []
}
```

The entry joins two sources. `describe` reads the tool's module. It gives the description, the return type, and each parameter's `type`, `default`, and `description`, which is the text of the parameter's `@param` entry. The tool's function value gives each parameter's `schema`, the JSON Schema a model sees for it.

`effects` is what the tool can raise, as `describe` reports it. It keeps `std::guard` for a tool that uses `guard`, because an entry describes the tool, not a workflow. `stepEffects` drops `std::guard`, because a guard trip is a question about budget, not a permission. So `agency workflow tools` can list `std::guard` for a tool that `agency workflow check` never lists for a workflow that calls it.

`type`, `default`, and `returns` are Agency text, written the way the signature writes them, so a reader can compare one tool's `returns` with another tool's parameter `type`. `returnSchema` is the same return type as a JSON Schema, with a `Result` unwrapped to its success type, since that is what a reference into the step reads. The compiler emits it as a thunk on every exported def beside the parameter schema (`returnSchemaFor` in `typescriptBuilder.ts`), from the declared type, so it needs no subprocess and costs nothing at module load; an alias of `Result` is looked through the way `describe`'s `returnsResult` does. A tool with no declared return type, one that returns a function, or one whose type holds a `regex` (which JSON Schema cannot express) has null. So does a tool whose schema would print an alias its module never imports by name, such as `_signatures` here: `Record<string, ExportInfo>` inlines `ExportInfo`, whose body names `ExportParam`, and the generated code has no binding for it (issue #1371), so the compiler emits no schema rather than one that fails at load. A schema that prints an imported alias by name, such as `Result<Outer>`, is fine whatever `Outer`'s body names, since the declaring module supplies the body. A `default` of null means a step must pass the parameter. A function-typed parameter, such as a block, is not in the tool's schema, and the catalog leaves it out, because a step's arguments are JSON values. The entry's `description` is the docstring with every `@param` entry removed, including one whose name matches no parameter. `handoff` is true for a `handoff def`, taken from what `describe` reports, so a picker can show an agent apart from a function; a step calls either the same way, as an ordinary call. One consequence worth knowing: an LLM step runs inside `thread { }` and starts with an empty conversation, but a tool step's call goes straight into `main`'s body, so two agent steps in one workflow append to the same thread and the second sees the first's prompt and answer. That predates the catalog marking agents; wrapping tool steps in `thread { }` in `lower.ts` is the follow-up.

`catalog` starts with the same two steps as `checkWorkflow`: `_toolRefs`, then `_signatures`. So it refuses the same tool lists, with every problem in `data.problems`, and it raises one `std::read` for each local module and nothing for a `std::` module. A failed or rejected read is returned as it came. It keeps its `rejected` flag and has no `data.problems`, which is how a caller tells it from a refused tool list. Entries keep the tool list's order.

## Offering a workflow as a tool

`workflowTool(workflow, tools, dir)` makes a workflow one tool a model can call. The tool is `runWorkflow` with three of its four parameters bound:

```
const bound = runWorkflow.partial(workflow: workflow, tools: tools, dir: dir)
const named = bound.rename(workflow.name).describe(workflow.description)
return named.withParamSchema("inputs", inputsSchema)
```

The tool's one parameter is `inputs`, with the workflow's inputs type nested inside it, so a model sends `{ "inputs": { "a": 2, "b": 3 } }`. Each call is a `runWorkflow` call: it checks the workflow, raises `std::workflow::run`, and runs the program in a subprocess.

`workflowTool` gets the schema the way `writeWorkflow` does. It runs `_checked`, then runs the program's `workflowSchemas` node once with `_inputsSchema`. So it raises `std::read` for each local module and one `std::run`. A workflow with problems fails with them, as it does in `runWorkflow`, and raises nothing.

`workflowTools(dir, tools)` makes one tool per saved workflow, from the schema stored in each file, so it starts no subprocess. It raises the one `std::workflow::scan` that `listWorkflows` raises, or none when the project has no `workflows` folder. The listing is in name order, so the tool list is the same on every machine. Two kinds of saved workflow are refused, and the first one fails the whole call:

- one saved before schemas were recorded, whose `meta.inputsSchema` is null. The message says to save it again with `writeWorkflow`.
- one whose name is a name in `tools`.

`workflowTools` does not check a saved workflow's steps against `tools`. A workflow whose tool was renamed or removed after it was saved still becomes a tool. Each call runs the check before its prompt, so the call fails with the problems listed and starts nothing.

Both functions refuse a workflow named like one of `tools`, through one helper, `nameClashProblem`. A model cannot be handed two tools with one name, and the refusal returns a failure the host can read. `tools` is the list of functions the workflow may call. The host may hand `llm()` a different list, so the tool loop's `assertUniqueToolNames` (`lib/runtime/toolInvocation.ts`) is still the last check for that list.

The tool's `dir` is `resolve(dir)`, the absolute path `runWorkflow` names in its `std::workflow::run` payload. An "always" answer given to a direct `runWorkflow` call therefore covers the tool's calls too.

The tool keeps its schema across a checkpoint: `.withParamSchema` records the schema in the function value's `paramSchemas`, and the reviver applies it again (see [checkpointing.md](../runtime/checkpointing.md)).

## Designing a workflow

`designWorkflow(request, tools, dir)` turns a sentence into a saved workflow. A model drafts the workflow, the check's problems go back to the model until a draft passes, a person reviews the draft, and `writeWorkflow` saves it.

```
designWorkflow(request, tools, dir)
  │
  ├─ describeTools(tools, dir)    read each local tool module once
  ├─ savedWorkflowNames(root)     the names already saved
  │
  │  ┌─ round (up to maxRounds, 3 by default) ─────────────────┐
  │  │  draftFrom: up to 6 attempts, no person involved          │
  │  │    llm(brief) → JSON.parse → Workflow! → drop nulls       │
  │  │    → _checkedWith + name check, one problem list          │
  │  │    a failure becomes the next attempt's DraftProblem      │
  │  │                                                           │
  │  │  std::workflow::review                                    │
  │  │    accept or a bare approval → writeWorkflow              │
  │  │    feedback text → next round                             │
  │  │    an edited workflow → attemptDraft on it                │
  │  │        passes → writeWorkflow, no model call              │
  │  │        fails → next round, with its problems              │
  │  └───────────────────────────────────────────────────────────┘
  └─ Result<WorkflowEntry>
```

**The brief.** `workflowDesignBrief(request, entries, problem)` has three parts: `DESIGN_TUTORIAL`, the catalog entries rendered as text, and the request with the rules. The tutorial is the guide cut down to what a model writes. Its first example is the bare workflow object, not the saved file's `{ "workflow": ... }`, and it has no limits section, because the rules forbid both and small models copy examples. It says nothing about file names, because a designer never names a file. It is a `"""` string, so a literal `${` in it is written `\${`. Its local-file example is named `welcome`, a name no test uses. The language server finds stdlib functions by matching `export def <name>` anywhere in a stdlib file, strings included (`getStdlibIndex` in `lib/lsp/codeAction.ts`), so the example would otherwise be offered as an import for a real `greet`. A `DraftProblem` (the previous draft as text and what was wrong with it) adds a revision section at the end.

**Why the reply is text.** The model replies with `{ workflowJson: string }`, and the designer parses the string. `Workflow` has `Json` fields, which become open schemas, and Anthropic and OpenAI refuse open schemas in a structured reply. The call passes `validationRetries: 1` through `llmOptions`, so the client asks once more when a reply is not `{ workflowJson }`. A reply still the wrong shape after that ends the call: the provider is at fault, not the draft.

**One attempt.** `attemptDraft` is the one place that knows the stages: parse, `Workflow!`, `withoutNullOptionals`, then `_checkedWith` and the name check, whose problems are reported together. Every failure is a `DraftProblem` holding the text as the model wrote it, so the next attempt sees its own draft and what was wrong with it. Six attempts per round, the same as `designTool`'s `CHECK_ATTEMPTS`. A check problem is a fact the person cannot act on, so they only see a draft that passed. A failed attempt prints one line with its number and nothing from the problems: they quote what the model wrote, and a name such as `"a\u001b[2Jb"` passes the string check and reaches the identifier message with its escape decoded, which would clear the terminal.

**Reading the tools once.** `_checked` describes the tools again on every call, and describing a local module reads it with `std::read`. With 3 rounds of 6 attempts that would be up to 18 rounds of read prompts in an interactive run, and as many `describe` calls. So `describeTools` computes the import references, the signatures, and the catalog entries once, and the attempts call `_checkedWith(workflow, refs, signatures, dir)`. `_checked` and `_checkedWith` share `checkCompiled`, the typecheck and compile. `catalog` is `describeTools` returning its entries. The typecheck still reads the local files, without prompts, as it always has. `writeWorkflow` runs the full `_checked` once more before its save prompt.

**Taken names.** The model picks the name, and saving a name that exists replaces that workflow. A designed workflow is always a new one, so `designWorkflow` lists the names already saved (`savedWorkflowNames`) and a draft with one of them goes back to the model. The name is compared before the check runs, and a taken name is reported in the same problem list as the check's problems, so a draft that is wrong in both ways is fixed in one attempt. Names are compared ignoring case. On a case-insensitive disk, which macOS uses by default, saving `DoubleSum` writes into an existing `doubleSum.json`, and that file then fails to load, because the name inside no longer matches the file name, and `listWorkflows` fails with it. The names are read again at the start of each round and after each review answer, because a review can wait for hours, even across a restart from a checkpoint. If a workflow was saved under the draft's name in the meantime, accepting sends the draft back to the model with that problem, and the saved one is kept. The window between that last read and the write is still there, since `writeWorkflow` replaces a file by design; closing it would need a create-only save mode. The listing reads file names only, and no saved file, so it raises no `std::workflow::scan`, in the same way `loadWorkflow` calls `exists` before its prompt. `listWorkflows` uses the same function after its prompt.

**The review.** `std::workflow::review` carries the draft, the previous round's draft (null on the first round), the check's warnings, the attempt count, and `round` and `maxRounds`. Feedback given in the last round is never drafted, so a host can say so. The raise is assigned to a variable, so it expects a value. Who may answer it with a rule depends on whether a person is there:

- `cliPolicyHandler` never lets a policy rule approve it (`policy.agency`, the `expectsValue` check), and `agency run --interactive` sends it to the value prompt even when an approve rule matches (`makeRunPolicyHandler` and `buildDecider`, #1374). So with a person present, the person answers.
- In a run with nobody to ask, an approve rule answers it with no value, and that accepts the draft: `agency run --approve std::workflow::review` without `--interactive`, `agency remote call` the same way, a serve host's policy, and `agency serve mcp`, whose `applyPolicy` (`lib/serve/mcp/interruptLoop.ts`) answers every surfaced interrupt from its policy store. The rule said approve, so it is not turned into a no. The MCP client can add that rule itself with `agencyAddRule`, as it can for any effect.

A given answer survives an outer approval with no value. When several handlers approve one interrupt, the default merge lets the outermost value win, a valueless `approve()` included, so an outer `--approve` or a handler that approves everything would replace the feedback a person typed at `cliPolicyHandler` with nothing, and the draft they asked to change would be saved. `std::workflow::review` has its own entry in the merge table (`keepGivenAnswer` in `lib/runtime/effectMerge.ts`): `outer ?? inner`, the rule cross-process merges already use. An outer approval that carries a value still wins.

The save is the interrupt a policy is meant to pin. The answer is read by `reviewAnswer`:

- null or true (a bare `approve()`: null when a handler answers in the same process, true after a pause, because the generated code sets an assignment-position raise's variable to true for an approval with no value) or `"accept"`: save. The word is matched after trimming and lowercasing, so `" Accept"` typed at the prompt saves too, and does not spend a round as feedback.
- a string: feedback. The next round's `DraftProblem` is this draft as JSON and the feedback. Blank feedback fails the call.
- any other value that is not an object, such as a number: the call fails, with a message that lists the answers.
- an object: an edited workflow, kept as JSON text and checked by `attemptDraft`, the same stages a model's draft goes through, `Workflow!` included. If it passes, it is saved with no model call. If it fails, a wrong shape as much as a check problem, its problems start the next round, and the person sees the model's version, not their own edit. An edit with a missing `description` therefore costs a round, not the call.

A rejected review fails the call and writes nothing. Accepting raises two interrupts, the review and then `writeWorkflow`'s save.

Under `cliPolicyHandler`, the prompt renders the review in `renderWorkflowDraft` (`policy.agency`): the draft as JSON on the first round, a diff against the previous draft after that, and the warnings under either. The diff keeps whitespace, unlike a code diff: in JSON a space inside a string is a real change, and `"annual  report.txt"` and `"annual report.txt"` name different files. `PROMPT_HIDDEN_FIELDS` keeps the three from printing again in the prompt's table. There, `a` approves with no value, which `reviewAnswer` reads as accept, and typed text is feedback (`typedValue`). A run with no `cliPolicyHandler` in its chain, such as plain `agency run --interactive`, gets the runtime's value prompt (`terminalValuePrompt`), which prints the payload as raw JSON, both drafts in full from round 2 on, and takes the typed line as the answer, so an `a` typed there is feedback. That is why the guide's example installs `cliPolicyHandler`.

**`draftWorkflow`, for hosts that save elsewhere.** A host with its own storage, such as BMO, calls `draftWorkflow(request, tools, dir, revise)`. It is `describeTools` and `draftFrom` with no review and no save, and it raises nothing of its own beyond the reads. It cannot know the host's saved names, so the host passes them, and its tool names, as `takenNames`; a clash is fixed in the attempt loop like a check problem (#1377). The host runs its own review and passes the person's feedback back as `revise`. Each attempt's model call runs in its own `thread { }`: the brief carries the previous draft and its problems, so the attempt needs no history, and a host that drafts from inside a conversation keeps that conversation as it was (#1376).

**`ExportParam` in the import line.** `std::workflow` imports `ExportParam` from `std::agency` without naming it. `DescribedTools` and `_checkedWith`'s parameter hold `Record<string, ExportInfo>`, and the schema the compiler builds for them inlines `ExportInfo`'s definition, which refers to `ExportParam` by name. The compiler keeps that name but does not import it, so without the import the module fails to load with `ExportParam is not defined`. This is a compiler bug, not anything about `std::workflow`: any alias that holds an imported type naming another imported alias hits it. Remove the import, and this paragraph, when it is fixed.
