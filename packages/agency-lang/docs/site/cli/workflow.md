---
title: Workflow
description: Documents the `agency workflow` commands, which list the tools a workflow may call, check a saved workflow, print the program it becomes, list a project's saved workflows, and run one.
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

`--dir` names the project directory a local module is relative to, `.` by default. `--json` prints the catalog as JSON (see [JSON output](#json-output)).

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

`--json` prints `checkWorkflow`'s value, the list of warnings, as JSON (see [JSON output](#json-output)).

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

`--json` prints `listWorkflows`'s value as JSON (see [JSON output](#json-output)).

## JSON output

With `--json`, every command prints one shape. On success:

```json
{ "success": true, "value": ... }
```

`value` is the `std::workflow` function's value: the catalog for `tools`, the warnings for `check`, and the saved workflows for `list`. On failure:

```json
{ "success": false, "error": "workflows/broken.json has 1 problem: ...", "step": null, "problems": [ ... ] }
```

`problems` is there only when the workflow has problems, each with its `step`, `field`, and `message`.

## `run`

Runs a saved workflow:

```
agency workflow run updateMealPlanFromNote --inputs '{"noteTitle": "Groceries"}' --policy ./mine.json
```

`--inputs` is the workflow's inputs as JSON, `{}` when left out. On success the command prints the workflow's value: a string as itself, anything else as indented JSON. On failure it prints the failure, which names the step that stopped the workflow. `--json` prints `{ "success": true, "value": ... }` or `{ "success": false, "error": ..., "step": ... }`, and nothing else goes to standard output.

### What `run` asks you

Before anything runs, the command works out which effects the workflow's steps can raise. An effect is covered when your policy has any rule for it, or a `"*"` rule. The command lists the effects your policy does not cover and asks once:

```text
Your policy does not cover these interrupts:
  test::lists::add   step add (addListItems)
  std::read          step text (readNote)
Approve all of them for this run? [y/N]
```

If you answer no, nothing runs. If there is no terminal to ask in, the command prints the list, then this, and runs nothing:

```text
Run this in a terminal to approve them, or cover them with --policy, --approve, or --reject.
```

There is no `--yes` flag. To run without a prompt, cover the effects in your policy.

### How the run's policy is built

1. **Your policy, unchanged.** It approves exactly what it says. If it approves reads from one folder only, a read from any other folder is rejected.
2. **The start prompts.** Typing the command is consent to start the workflow, so the command approves the prompts raised before the first step: reading the saved workflow, reading each tool's module, `std::workflow::run` for this workflow, and `std::run` for its program. These rules come after your rules for each effect, so your rules decide first. A policy that rejects every read therefore stops the run before it starts.
3. **What you accepted.** Each effect you approved at the prompt is approved for this run.

Then everything else is rejected. An interrupt the analysis missed matches no approval, so it is rejected and its step fails. It is never approved without you having seen it.

If your policy has a `"*"` rule, the command adds nothing and does not ask. You wrote a rule for everything, so it decides everything.

### Flags

| Flag | What it does for a workflow |
| --- | --- |
| `--policy`, `--approve`, `--reject` | Your part of the run's policy. |
| `--model`, `--local` | The model the workflow's LLM steps use. |
| `--max-cost`, `--max-time` | The run's budget. See the limits below. |
| `--log-file`, `--observability` | Where the run's log events go, including the workflow program's own. |

The other `agency run` flags are left out. `-i` needs the program to own the terminal, which a workflow run does not give it yet. A trace covers one process, and the workflow's program runs in another. The workflow's program always compiles strictly and in the sandbox, so `--strict`, `--agency-only`, and `--refuse-splices` would change nothing.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The command did what it was asked. |
| 1 | The workflow has problems, `std::workflow` refused, the run failed, or you declined to run it. |
| 2 | The command line is wrong: a missing file, a path not under `workflows`, a `tools` source that cannot be read, or `--inputs` that is not JSON. |

## Limits

- A tool's module may import other local `.agency` files in the project. It may not import a TypeScript file, because a workflow's program runs in the sandbox, which refuses them. The commands report such a module on the step's `module` field.
- The commands compile each tool's module, which writes a `.js` file beside it, as `agency run` does. After `agency workflow check`, you will see `src/agent/lists.js` beside `src/agent/lists.agency`.
- `--max-time` does not stop a run while it waits on the workflow's program, which runs in its own process. `agency run --max-time` has the same gap when its program calls `runWorkflow`. To cap a workflow's time, set `limits.maxTime` in the workflow itself.
- A run stopped by a budget exits 1, with the error the run printed. `agency run` exits 3 for the same stop.

