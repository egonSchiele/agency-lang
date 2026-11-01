# `agency workflow`

The `agency workflow` commands (`tools`, `check`, `compile`, and `list`) call `std::workflow` from the command line. The user page is `docs/site/cli/workflow.md`. The workflow format and the functions themselves are in `docs/dev/stdlib/workflow.md`.

## Why a driver exists

Every `std::workflow` function takes the tools as function values: `checkWorkflow(workflow, [searchNotes, readNote], dir)`. The CLI is TypeScript, and it cannot import a person's `.agency` file while it runs. So each command writes a small Agency program, the driver, imports the tools in it, and runs one of its nodes with `runAgencyNode` (`lib/cli/util.ts`). That function compiles a file, calls one node with arguments, and returns the node's value.

```
import { catalog as wfCatalog, loadWorkflow as wfLoad, ... } from "std::workflow"
import { findLists, addListItems } from "../../tools/lists.agency"

const wfTools = [findLists, addListItems]

node wfCheckNode(name: string, dir: string) {
  const wfEntry = wfLoad(name, dir) with approve
  if (wfEntry is failure) {
    return wfEntry
  }
  const wfResult = wfCheck(wfEntry.value.workflow, wfTools, dir) with approve
  return wfResult
}
```

## The fixed text

`DRIVER` in `driver.ts` is one fixed text with a node per command. Only the import lines and the tool list are written into it, and `importLine` writes each import, refusing a module path or name it cannot write safely. Every value reaches the driver as a node argument, so nothing a person typed lands in its source. `DRIVER_NODES` maps each command to its node.

`DRIVER_NAMES` lists every name the driver binds. A tool with one of those names would clash with the driver's own, so the import plan refuses it. A test parses the driver and checks that every name it binds is in `DRIVER_NAMES`, and that every node in `DRIVER_NODES` exists. So adding a node without listing its names fails a test, not a person's run.

## Which bad steps are left for `checkWorkflow`

The driver would not compile with an import of a name its module does not export. So before writing it, `importsForSteps` (`toolImports.ts`) describes each step's module and imports only names the module really exports. A local module is described with its path, `_describe(text, dir, module)`, so its own imports of other local files resolve, the way `std::workflow` describes it.

Some steps are left out without a problem, and `checkWorkflow` then reports each one on its step:

- a missing module;
- a module outside the project directory;
- a name the module does not export;
- a malformed step.

Three problems are reported by the command itself, because `checkWorkflow` would report them wrongly or not at all:

1. A module that exists but cannot be described, on the step's `module` field. Left out, `checkWorkflow` would say the tool "is not among the tools passed to this workflow", which sends the person looking for the wrong mistake. The usual causes are a module that does not parse, and one whose imports the sandbox check refuses, such as a TypeScript file.
2. Two tools with one name from different modules, in `toolRefs`'s wording.
3. A tool named like one of `DRIVER_NAMES`.

## Why `with approve` is safe in these nodes

The `std::workflow` functions the nodes call read files and compile in the sandbox. None of them runs a tool. So every interrupt they raise is their own: `std::read` for a tool's module, and `std::workflow::scan` for the `workflows` folder. `runAgencyNode`'s child gets no run policy, because `withRootCarriers` removes it from the environment when no policy carrier is passed.

## Why the driver is not sandboxed

A sandboxed compile records no source file on a function, and `std::workflow` refuses a tool without one (`docs/dev/stdlib/workflow.md`, "Tool modules"). So the driver is compiled normally, with splices refused. The workflow's own program still compiles in the sandbox, as it always has.

`runDriver` clears `distDir` from the config. With `distDir` set, `runAgencyNode` skips compiling and looks for a precompiled file there, and the driver is never precompiled.

## The temp folder

The driver goes in `<project>/.agency-tmp/workflow-<id>/`, which `makeAgencyTempDir` makes. It has to be inside the project, so Node resolves the driver's imports of `agency-lang` through the project's own `node_modules`. The spawn tests make their project inside the package for the same reason.

`runDriver` deletes the folder in a `finally`. `compile()` calls `process.exit(1)` on a compile error, which skips the `finally`, so an `exit` listener deletes it too. An `exit` listener runs only synchronous work, and `safeDeleteDirectoryWithin` is synchronous.

## What a broken tool module looks like

The driver compiles each tool module it imports. A type error in a tool makes `compile()` print its errors and exit 1, and the output names `driver.agency` in `.agency-tmp`, a file the person never wrote. Compiling a tool module also writes a `.js` beside it, as `agency run` does. The user page says so, and a spawn test pins it, so a later change to it is deliberate.

## Files

- `lib/cli/workflow/locate.ts`: finding a workflow from a path or a bare name.
- `lib/cli/workflow/toolImports.ts`: describing modules and choosing the tools the driver imports.
- `lib/cli/workflow/driver.ts`: the fixed text, `DRIVER_NAMES`, and `DRIVER_NODES`.
- `lib/cli/workflow/runDriver.ts`: the temp folder and the `runAgencyNode` call.
- `lib/cli/workflow/output.ts`: the formatters.
- `lib/cli/workflow/commands.ts`: the commands, `prepareWorkflow`, and `readDriverResult`.
- `lib/cli/workflow/workflow.spawn.test.ts`: the end-to-end tests against the built CLI.
- `scripts/agency.ts`: the `workflow` command group.
