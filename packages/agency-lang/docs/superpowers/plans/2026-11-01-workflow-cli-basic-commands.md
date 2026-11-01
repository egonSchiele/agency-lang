# `agency workflow tools`, `check`, `compile`, and `list` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The owner prefers one agent working inline, so do not use subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the command line, a person can see what tools take, return, and raise; check a saved workflow and see the effects it can raise; see the program it becomes; and list a project's saved workflows.

**Architecture:** Each command writes one fixed Agency file, the driver, into `<dir>/.agency-tmp/`. The driver imports the tools and has one node per command, each calling `std::workflow`. The command runs one node with `runAgencyNode`, which already compiles a file, calls a node with arguments, and returns its value. Then the command prints the value.

**Tech Stack:** TypeScript in a new `lib/cli/workflow/` folder and in `scripts/agency.ts`. vitest, including one spawn test file against the built CLI.

**Spec:** `docs/superpowers/specs/2026-11-01-workflow-cli.md`, "Part 2". Linear ticket ADI-255.

**Depends on:** `docs/superpowers/plans/2026-11-01-workflow-hard-limits-and-raises.md`, merged to main. This plan uses `stepEffects` and the `effects` on signatures and catalog entries. Start from main after that PR merges.

## Background

- **`std::workflow`** (`stdlib/workflow.agency`): `catalog`, `loadWorkflow`, `checkWorkflow`, `compileWorkflow`, and `listWorkflows` each take tools as function values. They read files and compile in the sandbox, and none of them runs a tool. So the only interrupts they raise are `std::read` for a tool module and `std::workflow::scan` for the `workflows` folder.
- **`runAgencyNode`** (`lib/cli/util.ts:258`) compiles an `.agency` file normally, writes an evaluate script beside it or in `scratchDir`, and calls `nodeName` with `argsString`. `argsString` is JavaScript argument text, so `JSON.stringify` of each argument, joined with `, `, is safe. It returns `{ data }`, where `data` is what the node returned. It throws when the child exits nonzero. Read its two callers: `executeNodeAsync` (`lib/cli/util.ts:414`) and the eval grader (`lib/eval/grading/agencyRunner.ts:24`). When `config.distDir` is set, it skips compiling and looks for a precompiled file there (`util.ts:285-287`), so `runDriver` clears `distDir`.
- **Describing a local module.** Since the hard-limits plan, `_describe(source, dir, filename)` takes the module's folder and file name, so the module's own local imports resolve. It first checks those imports the way a sandboxed compile does, refusing TypeScript files, escapes, symlinks, and splices. `std::workflow`'s `_signatures` describes tool modules this way, and the CLI must too. Otherwise the CLI would refuse a module that `checkWorkflow` accepts.
- **Reading exports.** `_describe(source)` in `lib/stdlib/agency.ts:255` lists a module's exports. `_describe('export * from "std::math"')` lists a standard module's. `_pickSignatures(source, exports)` in `lib/stdlib/workflow/index.ts:100` turns exports into the `Signature`s `std::workflow` uses, keyed by `signatureKey(module, name)`. `stepEffects(workflow, signatures)` comes from the hard-limits plan.
- **Import lines.** `importLine` in `lib/stdlib/workflow/lower.ts:35` writes one, and refuses a module path that fails `MODULE_PATH` or a name that is not an identifier.
- **Temp folders.** `makeAgencyTempDir(label, parent)` in `lib/utils/agencyTempDir.ts`, and `safeDeleteDirectoryWithin(root, target)` in `lib/utils.ts:110`. `compile()` calls `process.exit(1)` on a compile error, so cleanup needs an `exit` listener as well as a `finally`. An `exit` listener must work synchronously, because Node runs nothing asynchronous after it. `safeDeleteDirectoryWithin` is synchronous.
- **Compiled files beside the tools.** Compiling the driver compiles each tool module it imports. With no `outDir`, `outputPathFor` (`lib/compiler/buildSession.ts:743-750`) writes each `.js` next to its source, so `check` leaves `src/agent/lists.js` beside `src/agent/lists.agency`. `agency run` does the same. This plan accepts that, documents it, and pins it in a spawn test.
- **Subcommands.** Follow `eval` in `scripts/agency.ts`: `program.command("eval")`, then `evalCmd.command("new")`.

Build and test commands: `make > /tmp/wfcli-make.log 2>&1` builds `dist/`, which the spawn tests run. Unit tests: `pnpm test:run <files> > /tmp/wfcli-unit.log 2>&1`. Before each commit, run `pnpm run typecheck`, and `npx prettier --write` on the TypeScript files you changed.

## Global constraints

- The driver is one fixed text. Only its import lines and its tool list are generated. Values reach it as node arguments, never in its source.
- `with approve` wraps each `std::workflow` call in the driver's nodes, and nothing else.
- The driver is compiled with `refuseSplices: true`.
- Text from a file goes through `stripControlCharacters` (`lib/utils/controlCharacters.ts`) before it is printed.
- No change to the runtime or to generated code.

## Task 1: finding a workflow file

**Files:** create `lib/cli/workflow/locate.ts` and `locate.test.ts`.

- [ ] **Step 1: Implement.**

```ts
export type WorkflowFile = { dir: string; name: string; file: string };
export type Located = { found: WorkflowFile; error: null } | { found: null; error: string };

/** A workflow named by its file, `<dir>/workflows/<name>.json`, or by a
 *  bare name in `<cwd>/workflows`. */
export function locateWorkflow(arg: string, cwd: string): Located
```

An argument ending in `.json` is a path, and its folder must be named `workflows`. Any other argument is a name. Check the name with `_workflowNameProblem` (`lib/stdlib/workflow/parse.ts`). The file must exist and must be a regular file under `lstatSync`, not a symlink.

- [ ] **Step 2: Test** the path form, the name form, a `.json` path outside a `workflows` folder, a bad name, a missing file, and a symlink. Commit: `agency workflow: find a workflow file`.

## Task 2: which tools the driver imports

**Files:** create `lib/cli/workflow/toolImports.ts` and `toolImports.test.ts`.

- [ ] **Step 1: Describe a module.**

```ts
export type DescribedModule = {
  /** As a step's `module` field writes it: `std::math`, or `./tools/notes.agency`. */
  module: string;
  /** Each exported def's Signature, keyed by its name. */
  signatures: Record<string, Signature>;
};

export function describeModule(module: string, dir: string): DescribedModule | { error: string }
```

Reuse the existing checks; do not write new ones:

- A `std::` module must match `STD_MODULE`, a constant in `toolImports.ts`: `/^std::[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/`. It is described as `export * from "<module>"`. `isStdlibImport` is not enough here, because it only checks the prefix. `std::../../x` would pass it and `MODULE_PATH`.
- A local module must match `MODULE_PATH` and end in `.agency`. Resolve it with `resolveInSandbox(dir, module, root)` (`lib/stdlib/agency.ts:106`). That is the sandbox's own rule, which refuses an absolute path, a `..` escape, and a symlink. Read the file it returns, and describe it with `_describe(text, dir, module)`, so its own local imports resolve.

Build the signatures with `_pickSignatures` over the module's `def` exports. A thrown `resolveInSandbox` or `_describe` becomes the error.

- [ ] **Step 2: Import plans.**

```ts
export type ImportPlan = {
  /** One import line's worth per module, in first-use order. */
  imports: ToolImport[];
  /** Signatures of every imported tool, keyed by signatureKey(module, name). */
  signatures: Record<string, Signature>;
  problems: Problem[];
};
export type ToolImport = { module: string; names: string[] };

/** `tools`: every def of each source. A source is a .agency path or a std:: module. */
export function importsForSources(sources: string[], dir: string, cwd: string): ImportPlan | { error: string }

/** `check`, `compile`, and `run`: the tools the steps name. */
export function importsForSteps(workflow: unknown, dir: string): ImportPlan
```

For `importsForSteps`, a step's tool is imported when its module describes and exports a `def` with that name. These steps are left out without a problem, and `checkWorkflow` then reports each one on the step:

- a missing module;
- a module outside `dir`;
- a name the module does not export;
- a malformed step.

These are problems the command reports itself:

1. A module that exists inside `dir` but cannot be described, on the step's `module` field: `cannot read the exports of "<module>": <the describe error>`. Leaving it to `checkWorkflow` would report "not among the tools passed to this workflow", which sends the person looking for the wrong mistake. The usual causes are a module that does not parse, and one whose imports the sandbox check refuses, such as a TypeScript file.
2. Two tools with one name from different modules, on the second step's `tool` field, in `toolRefs`'s wording: `tools "<name>" from "<a>" and "<b>" have the same name; a workflow imports each tool by its name`.
3. A tool named like one of `DRIVER_NAMES` (Task 3), on the step's `tool` field: `tool name "<name>" is a name the agency workflow command uses`.

For `importsForSources`, a source that does not describe returns `{ error }`, and the command exits 2. The error names the source the person passed: `<source>: cannot read its exports: <the describe error>`. A local source is turned into `./<path relative to dir>`.

- [ ] **Step 3: Test** against `tests/agency/workflow/fixtures/tools/`:
  1. `notes.agency` and `lists.agency` describe to their defs, with `addListItems` carrying `["test::lists::add"]`.
  2. `std::math` holds `round`, and `std::../../x` is refused with a clear error.
  3. The meal plan's steps give two imports.
  4. An unknown tool is left out.
  5. A name clash is one problem.
  6. `withHelper.agency`, the fixture the hard-limits plan adds, which imports `helper.agency`, describes. Its def is imported like any other.
  7. A module in a temp folder that imports a TypeScript file gives a problem on the step's `module` field. As a `tools` source, it gives an error that names the module.

  Commit: `agency workflow: choose the tools a driver imports`.

## Task 3: the driver

**Files:** export `importLine` from `lib/stdlib/workflow/lower.ts`; create `lib/cli/workflow/driver.ts` and `driver.test.ts`.

- [ ] **Step 1: The text.**

```ts
const DRIVER = `import { catalog as wfCatalog, loadWorkflow as wfLoad, checkWorkflow as wfCheck, compileWorkflow as wfCompile, listWorkflows as wfList } from "std::workflow"
{{imports}}

const wfTools = [{{tools}}]

node wfToolsNode(dir: string) {
  const wfResult = wfCatalog(wfTools, dir) with approve
  return wfResult
}

node wfCheckNode(name: string, dir: string) {
  const wfEntry = wfLoad(name, dir) with approve
  if (wfEntry is failure) {
    return wfEntry
  }
  const wfResult = wfCheck(wfEntry.value.workflow, wfTools, dir) with approve
  return wfResult
}

node wfCompileNode(name: string, dir: string) {
  ...the same as wfCheckNode, with wfCompile...
}

node wfListNode(dir: string) {
  const wfResult = wfList(dir) with approve
  return wfResult
}
`;

/** The driver's node for each command, so a command names its node by kind. */
export const DRIVER_NODES = {
  tools: "wfToolsNode",
  check: "wfCheckNode",
  compile: "wfCompileNode",
  list: "wfListNode",
} as const;

/** Every name the driver binds. A tool with one of these names would clash.
 *  Written beside the text, as `PROGRAM_NAMES` is beside the generator's
 *  scaffold; a test checks the two agree (Step 2). */
export const DRIVER_NAMES = [
  "wfCatalog", "wfLoad", "wfCheck", "wfCompile", "wfList", "wfTools",
  "wfToolsNode", "wfCheckNode", "wfCompileNode", "wfListNode", "wfEntry", "wfResult",
];

/** The driver's text, with each local module's path made relative to the
 *  folder the driver is written to. */
export function driverSource(imports: ToolImport[], projectDir: string, driverDir: string): string
```

Write `wfCompileNode` out in full. Each import line comes from `importLine`. A local module's import path is `path.relative(driverDir, path.resolve(projectDir, module))`, with `/` separators. A `std::` module is written as it is.

- [ ] **Step 2: Test** that the driver for the meal plan's imports and for no imports both parse with `parseAgency`. Pin the meal plan's driver text once. Add one more test: every import alias, top-level `const`, node name, and node-local `const` in the parsed driver is in `DRIVER_NAMES`, and every value of `DRIVER_NODES` is a node in it. Then adding a node without listing its names fails a test, not a user's run. Commit: `agency workflow: the driver`.

## Task 4: running the driver

**Files:** create `lib/cli/workflow/runDriver.ts` and `runDriver.test.ts`.

- [ ] **Step 1: Implement.**

```ts
export type DriverCall = {
  dir: string;
  imports: ToolImport[];
  node: string;
  args: unknown[];
  config: AgencyConfig;
  carriers?: RootCarriers;
};
export type DriverOutcome = { ok: true; data: unknown } | { ok: false; message: string };

export async function runDriver(call: DriverCall, run = runAgencyNode): Promise<DriverOutcome>
```

1. Make the folder with `makeAgencyTempDir("workflow", call.dir)`, and write `driver.agency` into it.
2. Call `run` with these arguments:
   - `config`: `{ ...applyCliFlags(call.config, { refuseSplices: true }), distDir: undefined }`. The driver is never precompiled, so a project's `distDir` must not send `runAgencyNode` looking for it.
   - `agencyFile`: the driver's path
   - `nodeName`: `call.node`
   - `hasArgs` and `argsString`: from `call.args`, each through `JSON.stringify`
   - `scratchDir`: the folder
   - `quietCompile`: `true`
   - `rootCarriers`: `call.carriers`
3. A thrown error becomes `{ ok: false, message }`, holding the child's stderr when the error carries it.
4. Delete the folder in a `finally`, and from a `process.once("exit")` listener removed in the same `finally`. The listener must delete synchronously, because an asynchronous delete in an `exit` listener never runs. `safeDeleteDirectoryWithin` is synchronous.

- [ ] **Step 2: Test** with a stub `run`: the folder is gone after a success and after a throw, and the stub received the expected node and argument text. A config with `distDir` set reaches the stub with no `distDir`. Commit: `agency workflow: run a driver node`.

## Task 5: output

**Files:** export `describeProblem` from `lib/stdlib/workflow/index.ts`; create `lib/cli/workflow/output.ts` and `output.test.ts`.

- [ ] Write four formatters, each through `stripControlCharacters`, and pin each against the spec's examples:
  1. `formatCatalog(entries)`: a heading per module. Under it, per tool: `name(param: type = default, ...): returns`, the description's first paragraph, and `raises a, b` when `effects` is not empty.
  2. `formatProblems(label, problems)`: `<label> has <n> problem(s):`, then one `describeProblem` line each.
  3. `formatChecked(label, warnings, steps: StepEffects[])`: `<label>: no problems`, then a `warning:` line per warning, then `can raise:` with one line per effect naming the steps that raise it. When nothing is raised, it prints `can raise: nothing`.
  4. `formatList(dir, entries)`: each name with its inputs, then its description. With none: `no saved workflows in <dir>/workflows`.

Commit: `agency workflow: output`.

## Task 6: the commands

**Files:** create `lib/cli/workflow/commands.ts` and `commands.test.ts`; modify `scripts/agency.ts`.

- [ ] **Step 1: Implement.** Each returns its exit code. `io` holds `cwd`, `out`, `err`, `config`, and `runDriver`, so tests pass a fake.

```ts
export async function workflowTools(sources: string[], options: { dir?: string; json?: boolean }, io: WorkflowIo): Promise<number>
export async function workflowCheck(target: string, options: { json?: boolean }, io: WorkflowIo): Promise<number>
export async function workflowCompile(target: string, io: WorkflowIo): Promise<number>
export async function workflowList(dir: string | undefined, options: { json?: boolean }, io: WorkflowIo): Promise<number>
```

Two shared functions hold the steps every command repeats. `check`, `compile`, and later `run` call the first. Every command calls the second.

```ts
export type PreparedWorkflow = {
  found: WorkflowFile;
  /** The file's `workflow`, after `parseWorkflow`. */
  workflow: Workflow;
  plan: ImportPlan;
};

/** Find, read, parse, and plan the imports for a workflow. Prints what is
 *  wrong and returns the exit code instead when a step fails:
 *  2 for locateWorkflow, 1 for a file that does not parse as JSON, for
 *  parseWorkflow's problems, and for the import plan's problems. */
export function prepareWorkflow(target: string, io: WorkflowIo): PreparedWorkflow | { exitCode: number }

export type DriverResult =
  | { kind: "value"; value: unknown }
  | { kind: "problems"; problems: Problem[] }
  | { kind: "failed"; message: string; step: string | null }
  /** The value was a list of interrupts nothing answered. */
  | { kind: "unanswered"; effects: string[] };

/** What a driver node's outcome means. The value is a serialized `Result`
 *  (`lib/runtime/result.ts:70-130`). `{ ok: false }` from runDriver is
 *  `failed`, with its message. */
export function readDriverResult(outcome: DriverOutcome): DriverResult
```

Each command is then short:

- `check` runs `DRIVER_NODES.check` with `[name, dir]`. For `value`, it prints `formatChecked` with `stepEffects(workflow, plan.signatures)` and exits 0.
- `compile` runs `DRIVER_NODES.compile` the same way. For `value`, it prints the source and exits 0.
- `tools` runs `DRIVER_NODES.tools` with `[dir]`.
- `list` runs `DRIVER_NODES.list` with `[path.resolve(cwd, dir ?? ".")]`.

In every command, `problems` prints `formatProblems` and exits 1. `failed` prints its message and exits 1. `unanswered` prints the effects and exits 1. With `--json`, `value` prints as JSON.

- [ ] **Step 2: Unit test** `readDriverResult` on each kind of outcome. Unit test `prepareWorkflow`'s exit codes. Unit test each command's branches with a fake `runDriver`, checking what was printed and the exit code.

- [ ] **Step 3: Register.** Add a `workflow` command group after `eval`, with `tools <sources...>` (`--dir`, `--json`), `check <workflow>` (`--json`), `compile <workflow>`, and `list [dir]` (`--json`). Each action calls `process.exit` with the code it gets back. A small `workflowIo()` in the same closure builds the `io` from `process.cwd()`, `console.log`, `console.error`, `getConfig()`, and `runDriver`.

- [ ] **Step 4:** Commit: `agency workflow: tools, check, compile, and list`.

## Task 7: end-to-end tests

**Files:** create `lib/cli/workflow/workflow.spawn.test.ts`, following `lib/cli/budgetRun.spawn.test.ts`.

- [ ] **Step 1: The fixture project.** Copy `notes.agency` and `lists.agency` from `tests/agency/workflow/fixtures/tools/` into `<tmp>/tools/`. Write two saved workflows, each as `{ "workflow": { ... } }`:
  - `workflows/addOne.json`: `note` (`searchNotes`, from `inputs.noteTitle`), then `list` (`findLists`, `query: "weekly"`), then `add` (`addListItems`, `listId` from `steps.list[0].id`, `items: ["soup"]`, `section: "Meals"`).
  - `workflows/broken.json`: the same, but with `listId` from `steps.lists[0].id`.

- [ ] **Step 2: Cases.** Each runs `dist/scripts/agency.js` with `cwd: <tmp>`:
  1. `workflow tools ./tools/lists.agency` exits 0, and prints `addListItems(listId: string, items: string[], section: string): Result<string>` and `raises test::lists::add`.
  2. `workflow tools std::math --json` exits 0, and its JSON holds an entry named `round`.
  3. `workflow check addOne` exits 0, and prints `no problems` and a `test::lists::add` line naming `step add (addListItems)`.
  4. `workflow check workflows/broken.json` exits 1, with a line starting `  step add, args.listId:`.
  5. `workflow compile addOne` exits 0, and prints `import { findLists, addListItems } from "./tools/lists.agency"`.
  6. `workflow list` exits 0, and names both workflows.
  7. `workflow check tools/x.json` exits 2.
  8. After every case, `<tmp>/.agency-tmp` holds no `workflow-` folder.
  9. After `workflow check addOne`, `<tmp>/tools/lists.js` exists. This pins the documented behavior, so a later change to it is deliberate.

- [ ] **Step 3:** `make`, run the file into `/tmp/wfcli-spawn.log`, and commit: `agency workflow: end-to-end tests`.

## Task 8: documentation

- [ ] `docs/site/cli/workflow.md`: one section per command with the spec's examples, and the exit codes. Add it to the sidebar in `docs/site/.vitepress/config.mts`, beside `eval`.
- [ ] In `docs/site/cli/workflow.md`, also add a "Limits" section covering two things:
  - A tool's module may import other local `.agency` files in the project, but not TypeScript files. A workflow's program runs in the sandbox, which refuses them. The commands report such a module on the step's `module` field.
  - `check`, `compile`, `tools`, and later `run` compile the tool modules, which writes a `.js` file beside each one, as `agency run` does.
- [ ] `docs/dev/cli/workflow-command.md`. Cover:
  - why a driver exists;
  - the fixed text, `DRIVER_NAMES`, and `DRIVER_NODES`;
  - which bad steps are left for `checkWorkflow` and which are reported here, and why;
  - why `with approve` is safe in these nodes;
  - why the driver is not sandboxed, and why `distDir` is cleared;
  - the temp folder's synchronous cleanup.

  Also describe what a tool module with a type error looks like from these commands. `compile()` prints the errors and exits 1, and the output names `driver.agency` in `.agency-tmp`, a file the person never wrote. End with the file list.- [ ] Add the dev doc to the "CLI and terminal UI" index in `CLAUDE.md` and to `.claude/skills/agency-cli-docs/SKILL.md`.
- [ ] Commit: `agency workflow: docs`.

## Task 9: final checks

- [ ] `pnpm run typecheck` and `pnpm run lint:structure`.
- [ ] `npx prettier --write` on each TypeScript file this plan changed.
- [ ] `pnpm test:run lib/cli/workflow lib/stdlib/workflow > /tmp/wfcli-unit.log 2>&1`
- [ ] Smoke the built CLI by hand from `tests/agency/workflow/fixtures/tools`: `node dist/scripts/agency.js workflow tools ./lists.agency std::math`, and read the output as a user would.
- [ ] Open the PR, with its description written to a file and passed with `--body-file`.
