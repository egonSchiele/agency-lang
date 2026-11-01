---
title: Workflow
description: Documents the `agency workflow` commands, which list the tools a workflow may call, check a saved workflow, print the program it becomes, and list a project's saved workflows.
---

# Workflow

A workflow is a JSON list of steps, each of which calls a tool or asks a model (see [`std::workflow`](/stdlib/workflow)). The `agency workflow` commands work with saved workflows from the command line, without writing a host program.

## Naming a workflow

A saved workflow is one file, `<project>/workflows/<name>.json`, as `writeWorkflow` writes it. Each step's `module` is a path relative to the project directory.

`check` and `compile` take either the path to that file or a bare name. A bare name means `./workflows/<name>.json`:

```
agency workflow check workflows/updateMealPlanFromNote.json
agency workflow check updateMealPlanFromNote
```

A path must end in `workflows/<name>.json`, and the project directory is the folder that holds `workflows`. A file you write by hand needs the shape `writeWorkflow` writes, with `meta` left out:

```json
{ "workflow": { "format": 1, "name": "updateMealPlanFromNote", ... } }
```

## `tools`

Prints what each tool in a module takes, returns, and can raise. A source is an `.agency` file in the project or a `std::` module:

```text
$ agency workflow tools ./src/agent/lists.agency
./src/agent/lists.agency
  findLists(query: string): Result<ListSummary[]>
    Find lists whose title matches the query.
  addListItems(listId: string, items: string[], section: string): Result<string>
    Add items to a section of a list.
    raises test::lists::add
```

`--dir` names the project directory a local module is relative to, `.` by default. `--json` prints `std::workflow`'s `catalog` value as it is.

## `check`

Prints the workflow's problems, or the effects it can raise:

```text
$ agency workflow check updateMealPlanFromNote
workflows/updateMealPlanFromNote.json: no problems
can raise:
  std::read          step text (readNote)
  test::lists::add   step add (addListItems)
```

```text
$ agency workflow check broken
workflows/broken.json has 1 problem:
  step text, args.id: reference "steps.notes[0].id" names no step
```

`--json` prints `checkWorkflow`'s value, the list of warnings, as it is.

## `compile`

Prints the Agency program the workflow turns into.

```
agency workflow compile updateMealPlanFromNote
```

## `list`

Prints the workflows saved in a project, each with its inputs and description. The project directory is `.` unless you name another.

```text
$ agency workflow list
updateMealPlanFromNote { noteTitle: string }
  Copy this week's meal plan from the groceries note to the weekly meal plan list.
```

`--json` prints `listWorkflows`'s value as it is.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The command did what it was asked. |
| 1 | The workflow has problems, or `std::workflow` refused. |
| 2 | The command line is wrong: a missing file, a path not under `workflows`, or a `tools` source that cannot be read. |

## Limits

- A tool's module may import other local `.agency` files in the project. It may not import a TypeScript file, because a workflow's program runs in the sandbox, which refuses them. The commands report such a module on the step's `module` field.
- The commands compile each tool's module, which writes a `.js` file beside it, as `agency run` does. After `agency workflow check`, you will see `src/agent/lists.js` beside `src/agent/lists.agency`.
