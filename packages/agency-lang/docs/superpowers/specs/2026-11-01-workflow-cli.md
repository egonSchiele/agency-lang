# `agency workflow`: commands for checking and running workflows

Linear: ADI-255 (milestone 2 of the Workflows project). The workflow format and the `std::workflow` functions are in `docs/superpowers/specs/2026-10-26-workflows-design.md` and `docs/dev/stdlib/workflow.md`. Read both first.

## The problem

Everything in `std::workflow` is a function you call from Agency code. To try a workflow today, you write a host program that imports the tools and calls `checkWorkflow` or `runWorkflow`. You can't ask "what can a workflow call?", "is this workflow right?", "what does it turn into?", or "run it" from the command line.

## What ships, in order

1. **Hard limits, `raises`, and tool modules that import local files**, which are changes to `std::workflow` and `describe`. Plan: `docs/superpowers/plans/2026-11-01-workflow-hard-limits-and-raises.md`.
2. **`agency workflow tools`, `check`, `compile`, and `list`.** Plan: `docs/superpowers/plans/2026-11-01-workflow-cli-basic-commands.md`.
3. **`agency workflow run`.** Plan: `docs/superpowers/plans/2026-11-01-workflow-cli-run.md`.

Each plan is one PR, based on main after the one before it merges.

These come later, after more design discussion:

- `agency workflow new` and `agency workflow edit`, the form for writing a workflow. They are the only commands that offer to add effects to a workflow's `raises`.
- `-i` for `run`, which answers each prompt as it comes. It needs the program to own the terminal, which the simpler runner below does not give it.
- A form for `run`'s inputs, and picking a saved workflow from a list.

## Part 1: hard limits and `raises`

### Every limit is hard

A workflow's `limits`, and a step's, become a `guard` in the generated program. When a guard trips, it raises `std::guard`. A handler that approves `std::guard` gives the guard more budget (`docs/site/guide/guards.md`). So today, any caller's handler or policy can raise a workflow's limit.

The generated program answers its own guard trips with a rejection. Its scaffold wraps the body of `main` in a handler, and labels the guard around the body with the workflow's name:

```
export node main(inputs: Inputs!): Result {
  handle {
    ...the steps...
  } with (guardTrip) {
    if (guardTrip.effect == "std::guard" && ["updateMealPlanFromNote", "add"].includes(guardTrip.data.label)) {
      return reject()
    }
    return pass()
  }
}
```

The list holds the label of every guard the workflow itself writes: the workflow's name for the guard around the body, when the workflow has limits, and the id of each step with limits.

Any rejection wins over every other handler, so no caller can extend a limit. This is what the `@guarded` decorator does for the functions it wraps: it rejects a trip with its own label and passes on every other. A `return` inside a `handle` block returns from the enclosing function, so the steps' `return` statements keep working.

The handler passes on a trip from a guard inside a tool. A tool's guard sits inside the step's guard and the workflow's, so a caller who extends it is still stopped at the workflow's limits. What a caller can extend is only the tool's own budget, up to the workflow's, which is what they can do when they call the tool directly. And `supervise()`, which keeps a long task going by approving its own guard at each check (`stdlib/supervise.agency:72-112`), keeps working inside a workflow tool. A tool guard whose label matches a step id is rejected too, which is the safe direction for a collision.

### `raises`

A workflow may say which effects it is allowed to raise:

```json
{
  "format": 1,
  "name": "updateMealPlanFromNote",
  "raises": ["FileRead", "test::lists::add"],
  ...
}
```

It works like an Agency function's `raises` clause (`docs/site/guide/effects-and-raises.md`):

| `raises` | Meaning |
| --- | --- |
| left out | The workflow may raise anything. |
| `[]` | It may raise nothing. |
| `["std::read", "FileWrite"]` | It may raise at most these. A name of a set from `std::effectSets` stands for every effect in the set. |
| `["*"]` | It may raise anything. |

`checkWorkflow` checks it. The effects a workflow raises are the effects of each tool step's tool, as `describe` reports them, minus `std::guard`, because the workflow rejects its own guard trips. An effect a step raises that `raises` does not allow is a problem on that step:

```text
step add, tool: addListItems raises "test::lists::add", which the workflow's raises does not allow
```

A `raises` field is optional, and nothing writes it except a person or, later, `new` and `edit`. The parser drops keys it does not know, so an older Agency reading a workflow with `raises` ignores it. The format stays at 1.

Like Agency's own `raises`, this is a check made before running, from static analysis. The analysis can miss an effect, such as one raised through a function passed as a value (`docs/dev/compiler/effect-propagation.md`, "What the walk cannot see"). It never reports an effect the tool cannot raise. The safety while running comes from the caller's handlers and policy.

Two more rules:

- A bare `interrupt("...")` raises the effect `unknown`. A workflow allows it by listing `"unknown"`.
- Only the built-in sets in `std::effectSets` expand. A set a user declared with `effectSet` is read as one effect name, because a workflow does not name the module that declares it.

### Tool modules that import local files

`describe` gets a module's text with no path, so its effect analysis cannot resolve the module's own imports. It throws `Cannot find module`. So today a tool whose module imports a helper file can't be used in any workflow.

`describe` gains an optional folder and file name. With them, it first checks the module's imports the way a sandboxed compile does, refusing TypeScript files, escapes, symlinks, and splices without running them. Then it runs the effect analysis with the module's real path. This is what `std::agency`'s `typecheck(source, dir, strict)` already does for a type check. `std::workflow` passes the folder and file name when it describes a tool's module. It still reads the module through `read`, so the `std::read` prompt is unchanged.

One limit remains. A return type that names a type alias imported from another file isn't recognized as a `Result`, because `describe` looks up aliases only in the module's own file. The strict type check in `_checked` catches the mistakes that causes.

### Effects in the catalog

Each `catalog` entry gains `effects`, the tool's effects as `describe` reports them, `std::guard` included, because an entry describes the tool. A pure function, `stepEffects(workflow, signatures)`, lists the effects each tool step raises, without `std::guard`, because the workflow rejects it. The `raises` check, the CLI's `check`, and `run`'s approval prompt all use `stepEffects`.

## Part 2: `tools`, `check`, `compile`, and `list`

### Naming a workflow

A saved workflow is one file, `<dir>/workflows/<name>.json`, written by `writeWorkflow`. `<dir>` is the project directory. Each step's `module` is a path relative to it.

`check`, `compile`, and `run` take either a path to that file or a bare name:

```
agency workflow check workflows/updateMealPlanFromNote.json
agency workflow check updateMealPlanFromNote
```

A bare name means `./workflows/<name>.json`. A path must end in `workflows/<name>.json`, and the project directory is the folder that holds `workflows`.

A hand-written file needs the shape `writeWorkflow` writes, with `meta` left out:

```json
{ "workflow": { "format": 1, "name": "updateMealPlanFromNote", ... } }
```

### The commands

`tools` prints each tool's parameters, return type, and effects. Each source is a `.agency` file or a `std::` module:

```text
$ agency workflow tools ./src/agent/lists.agency
./src/agent/lists.agency
  findLists(query: string): Result<ListSummary[]>
    Find lists whose title matches the query.
  addListItems(listId: string, items: string[], section: string): Result<string>
    Add items to a section of a list.
    raises test::lists::add
```

`check` prints the workflow's problems, or the effects it can raise:

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

`compile` prints the Agency program the workflow turns into. `list` prints the saved workflows in a project, with their inputs and descriptions. Each of `tools`, `check`, and `list` takes `--json`. Every command prints the same shape, which `run` uses too: `{ "success": true, "value": ... }` with `std::workflow`'s value, or `{ "success": false, "error": ..., "step": ... }`, with `problems` when there are some.

### How the commands reach `std::workflow`

Every `std::workflow` function takes the tools as function values. The CLI is TypeScript and cannot import a user's `.agency` file while it runs. So each command writes a small Agency program, the driver, into `<dir>/.agency-tmp/workflow-<id>/`. The driver imports the tools and calls `std::workflow`. The command runs it with `runAgencyNode` (`lib/cli/util.ts`), which compiles a file, calls one node with arguments, and returns the node's value. The eval judge already runs this way.

The driver is one fixed text. Only its imports and tool list change:

```
import { catalog as wfCatalog, loadWorkflow as wfLoad, checkWorkflow as wfCheck, compileWorkflow as wfCompile, listWorkflows as wfList } from "std::workflow"
import { searchNotes, readNote } from "../../src/agent/appleNotes.agency"

const wfTools = [searchNotes, readNote]

node wfCheckNode(name: string, dir: string) {
  const wfEntry = wfLoad(name, dir) with approve
  if (wfEntry is failure) {
    return wfEntry
  }
  const wfResult = wfCheck(wfEntry.value.workflow, wfTools, dir) with approve
  return wfResult
}

...one node each for tools, compile, and list...
```

The name and directory arrive as arguments, so no value is written into the driver's source.

`with approve` is safe in these nodes. The `std::workflow` functions they call read files and compile in the sandbox. None of them runs a tool. So every interrupt they raise is their own: `std::read` for a tool's module, and `std::workflow::scan` for the `workflows` folder.

`tools` imports every exported `def` of each source. `check`, `compile`, and `run` import the tools the workflow's steps name. Before writing the driver, the command describes each module and leaves out a step's tool when the module is missing, is outside the project, or does not export it. The driver would not compile with it. Leaving it out lets `checkWorkflow` report the step as naming a tool it was not passed, on that step.

The command reports two cases itself, before writing the driver:

1. A module that exists but cannot be described, on the step's `module` field.
2. Two tools with one name from different modules, in `toolRefs`'s wording.

The driver is compiled normally, because a sandboxed compile records no source file on a function, and `std::workflow` refuses a tool without one. The driver's config has no `distDir`, because the driver is never precompiled. The workflow's own program still compiles in the sandbox, as it always has.

### Limits

- **A tool's module may import other local `.agency` files, but not TypeScript.** Part 1 lets `describe` take a module's folder and file name, so the module's own imports resolve after the sandbox's import check. A module whose imports that check refuses is reported on the step's `module` field, or, for `tools`, with the source that failed.
- **Compiling the driver writes a `.js` file beside each tool's module**, as `agency run` does.
- **A tool module with a type error** makes the compile print its errors and exit 1. The errors name `driver.agency` in `.agency-tmp`, a file the person never wrote.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The command did what it was asked. |
| 1 | The workflow has problems, `std::workflow` refused, the run failed, or the person declined to run it. |
| 2 | The command line is wrong: a missing file, a path not under `workflows`, or `--inputs` that is not JSON. |

## Part 3: `run`

```
agency workflow run updateMealPlanFromNote --inputs '{"noteTitle": "Groceries"}' --policy ./mine.json
```

`--inputs` is the inputs as JSON, `{}` when left out. On success the command prints the workflow's value: a string as itself, anything else as indented JSON. On failure it prints the failure, which names the step that stopped the workflow. `--json` prints `{ "success": true, "value": ... }` or `{ "success": false, "error": ..., "step": ... }`.

### What `run` approves

Before anything runs, the command works out which effects the workflow's steps raise, using `stepEffects`. An effect is covered when the person's policy has any rule for it, or a `"*"` rule. The policy comes from `--policy`, `--approve`, and `--reject`. The command lists the effects the policy does not cover and asks once:

```text
Your policy does not cover these interrupts:
  test::lists::add   step add (addListItems)
  std::read          step text (readNote)

Approve all of them for this run? [y/N]
```

If the person answers no, nothing runs. If there is no terminal to ask in, the command prints the list, says to cover these effects in a policy, and exits without running. The list and the question go to stderr, so `--json` output stays parseable.

The run's policy is built from three parts:

1. **The person's policy, unchanged.** It approves exactly what it says. If it approves reads from one folder only, a read from any other folder is rejected.
2. **The start prompts.** Typing the command is consent to start the workflow, so the command adds rules that approve the prompts raised before the first step:
   - `std::workflow::scan` for the project's `workflows` folder, which the driver's `loadWorkflow` raises. The folder is spelled with its real path, as `loadWorkflow` spells it;
   - `std::workflow::run` for this workflow's name and directory;
   - `std::run` for node `main` at depth 1;
   - `std::read` for each tool module's directory and file name, spelled the way `read` spells them.

   Each rule goes after the person's rules for that effect. A policy's first matching rule wins, so the person's own rules decide first. The command adds none of these rules when the person's policy has a `"*"` rule. An effect's own rule outranks `"*"`, and a person who wrote a `"*"` rule meant it to decide everything.
3. **The accepted effects.** For each effect the person accepted at the prompt, there is one rule approving every interrupt of that effect. Then, unless the person's policy has a `"*"` rule, a `"*"` rule rejects everything else.

`std::guard` never reaches the policy, because the workflow rejects its own guard trips.

The analysis can miss an effect. An interrupt it missed matches no approval and is rejected, and the step fails. It is never approved without the person having seen it.

A rule in the person's policy that propagates leaves its interrupt unanswered, because no one can answer it without a terminal. The run stops and prints the interrupt.

A budget trip from `--max-cost` or `--max-time` exits 1, with the child's error on stderr. `agency run` exits 3 for the same trip. Matching it means changing the evaluate script that `runAgencyNode` and every agency test share, which is an open question for the owner.

A tool that calls `run` shows up as `std::run`. Its child's own interrupts are not listed. They reach the same policy, so anything not approved is rejected.

### Flags

`run` takes these flags from `agency run`:

| Flag | Why it works for a workflow |
| --- | --- |
| `--policy`, `--approve`, `--reject` | They build the person's part of the run's policy. |
| `--model`, `--local` | They become config the driver is compiled with. Since ADI-256, the workflow's child gets the driver's model and provider. |
| `--max-cost`, `--max-time` | They become the driver's budget, which counts the child's spending and time. |
| `--log-file`, `--observability` | The child writes its log events to the driver's log. |

`run` leaves out the rest:

- `-i`, which is later work.
- `--trace` and `--trace-file`. A trace covers one process, and the driver's trace would show one step.
- `--max-tool-call-rounds`. The child never receives it.
- `--max-tool-result-chars`. It only affects an `llm()` call with tools, and LLM steps have none.
- `--draft`. The child never receives it. Leaving it undefined makes the command line refuse it.
- `--strict`. The check already compiles workflow programs strictly.
- `--capture-workdir`. It saves an eval run folder.
- `--agency-only` and `--refuse-splices`. The workflow's program always compiles in the sandbox.

There is no `--yes` flag.

## Calls I made

1. **One handler in the scaffold makes every limit hard.** It rejects a trip from the workflow's own guards, by label, and passes on the rest. An earlier draft rejected every `std::guard`, a tool's included, which broke `supervise()` inside a tool and bought nothing: the workflow's own guards still stop a caller who extends a tool's guard.
2. **The `raises` check is TypeScript in `resolve`, not the type checker's AG3013.** AG3013 points at `main`, not at the step, and would count `std::guard`. The check expands set names with `builtinEffectSets()`, the table the policy flags use.
3. **A problem from `raises` is on the step's `tool` field.** That is the step the person has to change, or the effect they have to add.
4. **The commands run their driver with `runAgencyNode`.** It already compiles a file, calls a node with arguments, and returns the value. It captures the program's output, which rules out `-i` for now.
5. **The start rules come after the person's rules for each effect.** A policy that rejects all reads therefore stops the workflow's check from reading its tools, and the run fails at the check. That honors "a policy approves exactly what it says".
