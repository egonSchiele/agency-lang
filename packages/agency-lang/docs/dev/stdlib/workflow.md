# `std::workflow`

A workflow is a JSON list of steps. Each step calls a tool or asks a model, and a later step's arguments can point at an earlier step's value. `compileWorkflow` turns a workflow into an Agency program. `checkWorkflow` typechecks and compiles that program and reports each problem by step and field. Nothing runs a workflow yet.

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

A string-literal type in that text may not hold a backslash or a line break. The compiler writes such a value between quotes without escaping it, so a backslash would end the string early in the compiled TypeScript. #1293 fixes the compiler; this refusal can go when it lands.

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

A tool with no declared return type, or `any`, gets a warning. References into its value are only checked at run time.

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

## Interrupts and checkpoints

The generator raises nothing itself. `compileWorkflow` and `checkWorkflow` raise `std::read` once for each local module they read. The generated program is ordinary Agency: each tool step raises the interrupts its tool raises, and a paused program resumes at its line like any other.

## Tool modules

`toolRefs` in `tools.ts` turns the host's function values into the module text an import uses. A function value's `module` is a path relative to the working directory it was compiled in. A path under `stdlib/` becomes `std::<name>`. Any other path is rewritten relative to the workflow's `dir`, resolved against the working directory at run time, so a host that runs in a different directory from the one it compiled in can get "outside the workflow directory", or a path to the wrong file.

The module text is written into an import line, so it must match `MODULE_PATH`. A partial, a renamed function, a tool built by `createTool`, a runtime builtin, and a package tool are refused.

## Not built yet

The spec covers these: `runWorkflow`, offering a workflow as a tool (`workflowTool`, `workflowTools`), `catalog`, saving and loading workflows, and the `std::workflow::run`, `scan`, and `save` effects.
