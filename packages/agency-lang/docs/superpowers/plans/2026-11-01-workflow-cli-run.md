# `agency workflow run` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The owner prefers one agent working inline, so do not use subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person runs a saved workflow from the command line. Before anything runs, they see every interrupt their policy does not cover and approve or decline all of them at once. The run approves only what the policy says, what they accepted, and the prompts that start the workflow, and it rejects everything else.

**Architecture:** `run` adds one node to the driver from the basic-commands plan. Before running it, the command lists each step's effects with `stepEffects`, compares them with the person's policy, and asks once. It then builds the run's policy as data, in a pure function, and passes it to the driver through `runAgencyNode`'s `rootCarriers`. There's no new runtime code and no new stdlib function.

**Tech Stack:** TypeScript in `lib/cli/workflow/` and `scripts/agency.ts`; vitest; spawn tests against the built CLI.

**Spec:** `docs/superpowers/specs/2026-11-01-workflow-cli.md`, "Part 3". Linear ticket ADI-255.

**Depends on:** the hard-limits plan and the basic-commands plan, both merged to main. Start from main after the second one merges.

## Background

- **The run policy** reaches the driver as `rootCarriers.policy`, which is `{ policyJson, interactive }`. The runtime installs it as one handler in the chain (`lib/runtime/runPolicyHandler.ts`). Inside a policy, an effect's rules are tried in order and the first match wins. A `"*"` key applies only when the effect's own rules matched nothing (`lib/runtime/policy.ts:57`). A rule's `match` values are globs, so a literal value goes through `escapeGlob` (`policy.ts:43`). A number in the interrupt's data is compared as its string.
- **What the run node raises before the first step.** The driver's own `loadWorkflow` comes first. It raises `std::workflow::scan` with `dir` set to `<real project dir>/workflows` (`stdlib/workflow.agency:628`). It builds that from `_realDir`, which follows symlinks. Then `runWorkflow` raises three:
  - `std::read` for each local tool module, with `dir` and `filename` from `prepareContainedPath(resolve(dir), module, "read")` (`lib/stdlib/prepareContainedPath.ts`). The `dir` is the real root.
  - `std::workflow::run` with `{ name, dir: resolve(dir), inputs }`. This `dir` is `path.resolve`, with no realpath.
  - `std::run` with `node: "main"` and `depth: 1` from a root process.

  The `with approve` on `loadWorkflow` cannot approve its scan on its own. The run's `"*"` reject is a handler in the same chain, and a rejection wins. So the scan needs a start rule like the others.
- **`--max-time` and `--max-cost` in a driver.** The root budget never raises an interrupt (`lib/runtime/rootBudget.ts:43`). `agency run` catches a trip in the generated main-module block and exits 3 with `Exceeded time limit` (`lib/runtime/budgetExit.ts:37`, and `lib/cli/budgetRun.spawn.test.ts:73-90`). The evaluate script `runAgencyNode` writes does not catch it. So in a driver, a trip ends the child with exit 1 and a stack trace on stderr.
- **The flags.** `addRunOptions` in `scripts/agency.ts` (around line 514) defines `agency run`'s shared flags in one function. `runWithOptions` (around line 345) turns them into config, a policy, and a budget, through `withLocalModel`, `applyCliFlags`, `resolveRunPolicy`, and `resolveBudget`. `resolveRunPolicy` returns null when no policy flag was given, and its `policy` field is the `Policy` object.
- **The driver** (`lib/cli/workflow/driver.ts`) is one fixed text with one node per command, run through `runDriver`.

Build and test commands are the same as the basic-commands plan.

## Global constraints

- No `-i`, and no `--yes`.
- The person's policy is used unchanged. The command's rules come after the person's rules for each effect.
- When the person's policy has a `"*"` key, the command adds nothing: no start rules, no prompt, and no catch-all.
- Otherwise a `"*"` rule rejects everything not approved.
- The run takes exactly these flags from `agency run`: `--policy`, `--approve`, `--reject`, `--model`, `--local`, `--max-cost`, `--max-time`, `--log-file`, `--observability`. It adds its own `--inputs` and `--json`.
- `agency run --help` prints the same text before and after this plan.

## Task 1: the run node

**Files:** `lib/cli/workflow/driver.ts`, `driver.test.ts`.

- [ ] Add `runWorkflow as wfRun` to the driver's import, and this node:

```
node wfRunNode(name: string, dir: string, inputs: any) {
  const wfEntry = wfLoad(name, dir) with approve
  if (wfEntry is failure) {
    return wfEntry
  }
  const wfResult = wfRun(wfEntry.value.workflow, inputs, wfTools, dir)
  return wfResult
}
```

`wfRun` has no handler around it. The run's policy decides each of its interrupts. Add `run: "wfRunNode"` to `DRIVER_NODES`, and `wfRun` and `wfRunNode` to `DRIVER_NAMES`. The basic-commands plan's driver tests cover the new text, including the check that the two lists agree with it. Commit: `agency workflow: the run node`.

## Task 2: the run's policy

**Files:** create `lib/cli/workflow/runPolicy.ts` and `runPolicy.test.ts`.

- [ ] **Step 1: Implement three pure functions.**

```ts
/** One effect the person's policy does not cover, and the steps that raise it. */
export type Uncovered = { effect: string; steps: string[] };

/** The effects in `steps` that `policy` has no rule for. With a "*" key,
 *  nothing is uncovered. Each step is written `<id> (<tool>)`. */
export function uncoveredEffects(steps: StepEffects[], policy: Policy): Uncovered[]

export type StartPrompts = {
  name: string;
  /** The absolute directory runWorkflow is given, from `path.resolve`. */
  dir: string;
  /** `<real project dir>/workflows`, from `fs.realpathSync`, as loadWorkflow spells it. */
  workflowsDir: string;
  /** Each local tool module as `read` spells it. */
  moduleReads: { dir: string; filename: string }[];
};

/** The rules that approve what the run node raises before the first step:
 *  loadWorkflow's scan, then what runWorkflow raises. */
export function startRules(start: StartPrompts): Policy

/** The run's policy. With a "*" key in `person`, it is `person` unchanged.
 *  Otherwise each effect's rules are the person's, then the start rules,
 *  then one approve for an accepted effect, and a "*" rule rejects the rest. */
export function runPolicy(person: Policy, start: Policy, accepted: string[]): Policy
```

`startRules` gives these, each value through `escapeGlob`:

```json
{
  "std::workflow::scan": [{ "match": { "dir": "<workflowsDir>" }, "action": "approve" }],
  "std::workflow::run": [{ "match": { "name": "<name>", "dir": "<dir>" }, "action": "approve" }],
  "std::run": [{ "match": { "node": "main", "depth": "1" }, "action": "approve" }],
  "std::read": [{ "match": { "dir": "<module dir>", "filename": "<module file>" }, "action": "approve" }]
}
```

There's one `std::read` rule per module.

The `std::run` rule pins the node and depth but not the module. That approves nothing extra. The only depth-1 `run` in the driver is `runWorkflow`'s. A tool that calls `run` does so inside the child, at depth 2.

- [ ] **Step 2: Tests.**
  1. `uncoveredEffects` leaves out an effect the policy has any rule for, including a rule with a `match`. With a `"*"` key it returns nothing. It names every step that raises an effect.
  2. `runPolicy` puts the person's rules first. A person's `std::read` rules that end in a reject come before the module-read rules.
  3. An accepted effect gets one approve rule with no `match`. The `"*"` rule is a reject.
  4. With a `"*"` key in `person`, the result equals `person`.
  5. A directory holding glob characters, such as `/p/v*1`, is escaped. `checkPolicyExplicit` approves the `std::workflow::run` interrupt for `/p/v*1` and passes on one for `/p/v21`.
  6. Under `runPolicy` with no `"*"` key in `person`, `checkPolicyExplicit` approves a `std::workflow::scan` interrupt for `workflowsDir`, and rejects one for any other folder.

- [ ] **Step 3:** Commit: `agency workflow run: the run's policy`.

## Task 3: the flag groups and shared run settings

**Files:** `scripts/agency.ts`.

- [ ] **Step 1:** Save `node dist/scripts/agency.js <cmd> --help` for `run`, `resume`, and `debug` into `/tmp/wfrun-help-before-<cmd>.txt`.
- [ ] **Step 2:** Split `addRunOptions` into functions in the same closure, keeping the options in the same order:
  - `addLogOptions`
  - `addCompileOptions`: strict, refuse-splices, and both tool caps
  - `addModelOptions`: model and local
  - `addDraftOption`
  - `addPolicyOptions`
  - `addBudgetOptions`
  - `addAgencyOnlyOption`

  `addRunOptions` calls them in that order.
- [ ] **Step 3:** Move the part of `runWithOptions` after `withLocalModel` into `runSettings(options, input): { config, runPolicy, budget }`. It keeps the same exits on a bad flag. `applyCliFlags` uses `input` only to name a default trace file (`lib/config/config.ts:914`). `workflow run` takes no trace flag, so it passes the workflow file's path, which is never used.
- [ ] **Step 4:** Rebuild. Each help diff against the saved files must be empty. The existing run spawn tests must pass. Commit: `cli: split the run flags into groups`.

## Task 4: the command

**Files:** `lib/cli/workflow/commands.ts`, `commands.test.ts`, `output.ts`, `output.test.ts`, `lib/cli/remote/confirmation.ts`, `scripts/agency.ts`.

- [ ] **Step 1: Output.** Add these formatters, and test each:
  - `formatRunValue(value)`: a string as itself, anything else as indented JSON. Both go through `stripControlCharacters`.
  - `formatUncovered(list)`: the table from the spec.
  - `NO_TERMINAL`: `Run this in a terminal to approve them, or cover them with --policy, --approve, or --reject.`

  The table, `NO_TERMINAL`, the question, and `Did not run.` all go to stderr. Standard output holds only the result, so `--json` stays parseable.

- [ ] **Step 2: The command.** `confirmQuestion` (`lib/cli/remote/confirmation.ts:34`) writes its question to stdout. Give it a second parameter, `output: NodeJS.WritableStream = process.stdout`, passed to `readline.createInterface`. Its existing callers do not change. `io` gains `confirm: ((question: string) => Promise<boolean>) | null`. `workflowIo()` sets it to `(question) => confirmQuestion(question, process.stderr)` when `process.stdin.isTTY` is true, and to null otherwise.

```ts
export type RunCommandOptions = { inputs?: string; json?: boolean };
export type RunCommandSettings = { config: AgencyConfig; person: Policy; budget?: { maxCost?: string; maxTime?: string } };

export async function workflowRun(target: string, options: RunCommandOptions, settings: RunCommandSettings, io: WorkflowIo): Promise<number>
```

1. Parse `--inputs`, or use `{}` when it is absent. JSON that does not parse exits 2.
2. `prepareWorkflow(target, io)` from the basic-commands plan. It returns the exit code when the file is missing or the workflow has problems.
3. Compute `uncoveredEffects(stepEffects(workflow, plan.signatures), settings.person)`. If the list is not empty:
   - With no `confirm`, print it and `NO_TERMINAL`, and exit 1.
   - Otherwise print it and call `confirm("Approve all of them for this run?")`. A no prints `Did not run.` and exits 1.
4. Build the start prompts:
   - The name comes from the file.
   - `dir` is `path.resolve(dir)`.
   - `workflowsDir` is `path.join(fs.realpathSync(path.resolve(dir)), "workflows")`. The real path matters on macOS, where a temp folder under `/var` is really under `/private/var`. The wrong spelling would pass on Linux and fail there.
   - The module reads come from `await prepareContainedPath(path.resolve(dir), module, "read")` for each local module in `plan.imports`. It throws for a module that escapes `dir` or is a symlink. `plan.imports` holds only modules that described, so that should not happen. If it does, print the error and exit 1.
5. Run `DRIVER_NODES.run` with `[name, path.resolve(dir), inputs]`. The carriers are `{ policy: { policyJson: JSON.stringify(runPolicy(...)), interactive: false }, budget }`.
6. Read the outcome with `readDriverResult`, and handle its kinds the way the other commands do. Only `value` is new: it prints `formatRunValue` and exits 0.
   - `failed` covers a failed step, whose message names the step. It also covers a budget trip, which ends the child with exit 1 and its error on stderr. `agency run` exits 3 for the same trip. The user doc says so.
   - `unanswered` happens when a rule in the person's policy propagates, for the effect itself or under `"*"`. For example, `{ "test::lists::add": [{ "action": "propagate" }] }` counts as covering the effect, so there is no prompt. At run time the rule propagates, nothing can answer, and the driver returns the interrupt unanswered.

   With `--json`, print `{ "success": true, "value": ... }` or `{ "success": false, "error": ..., "step": ... }`. Both come from the same `DriverResult`.

- [ ] **Step 3: Unit tests,** with a fake `runDriver` and a fake `confirm`:
  1. A yes runs.
  2. A no does not run, and exits 1.
  3. A null `confirm` with uncovered effects does not run, exits 1, and prints `NO_TERMINAL`.
  4. A fully covered policy never asks.
  5. The carriers hold the policy `runPolicy` built.
  6. Each output branch prints what it should.
  7. A person's policy `{ "test::lists::add": [{ "action": "propagate" }] }` does not ask, and a driver outcome holding that unanswered interrupt prints it and exits 1.
  8. With `--json` and uncovered effects, `out` holds only the JSON. The table and the question went to `err`.

- [ ] **Step 4: Register.** Add `workflow run <workflow>` with `--inputs <json>` and `--json`, then `addPolicyOptions`, `addModelOptions`, `addBudgetOptions`, and `addLogOptions`. The action does three things:
  1. `withLocalModel`, then `runSettings`.
  2. It passes `settings.runPolicy?.policy ?? {}` as `person`.
  3. It exits with the code `workflowRun` returns.

  `--draft` is not defined, so the command line refuses it.

- [ ] **Step 5:** Commit: `agency workflow run`.

## Task 5: end-to-end tests

**Files:** `lib/cli/workflow/workflow.spawn.test.ts`.

The spawn tests have no terminal, so `confirm` is null there. Copy `slow.agency` into the fixture project, and add `workflows/slow.json`: one step, `slowEcho`, with `text` from `inputs.text`.

- [ ] **Cases.** These use `addOne` from the basic-commands plan, with `--inputs '{"noteTitle":"Groceries"}'` unless the case says otherwise:
  1. With `--approve test::lists::add`, it exits 0 and prints `added 1 items to l1/Meals`. This also proves the start rules approve the module reads and the start prompts.
  2. With no flags, it exits 1. It prints `test::lists::add` beside `add (addListItems)`, prints the `NO_TERMINAL` line, and runs nothing.
  3. With `--approve test::lists::add --reject std::workflow::run`, it exits 1, and its output has no `added`. The person's rejection wins.
  4. With `--policy reject-add.json`, a file holding `{ "test::lists::add": [{ "action": "reject" }] }`, it exits 1 without asking, and its stderr names step `add`.
  5. Case 1 with `--json` prints `{"success":true,"value":"added 1 items to l1/Meals"}` once parsed.
  6. `--inputs nope` exits 2.
  7. `run slow --inputs '{"text":"x"}'` with the small `--max-time` that `budgetRun.spawn.test.ts` uses exits 1, and its stderr holds `Exceeded time limit`. This pins today's behavior, including the stack trace that comes with it. See "Open question" below.
  8. Case 1 with `--log-file <tmp>/run.jsonl` exits 0. The file holds `addListItems`, written by the child.
  9. `--draft x` exits nonzero with the parser's unknown-option error.
  10. After every case, `.agency-tmp` holds no `workflow-` folder.

- [ ] `make`, run the file into `/tmp/wfrun-spawn.log`, and commit: `agency workflow run: end-to-end tests`.

## Task 6: documentation

- [ ] `docs/site/cli/workflow.md`: a `run` section. Cover:
  - an example;
  - `--inputs`;
  - the prompt, and the no-terminal message;
  - the flag table;
  - how the run's policy is built.

  Add one limit: a budget trip exits 1 with the child's error, where `agency run` exits 3.
- [ ] `docs/dev/cli/workflow-command.md`: the three parts of the run's policy and their order, why the start rules come after the person's rules, why a `"*"` key turns all of it off, why there is no `-i` yet, and which flags reach the child and why.
- [ ] Commit: `agency workflow run: docs`.

## Task 7: final checks

- [ ] `pnpm run typecheck` and `pnpm run lint:structure`.
- [ ] `npx prettier --write` on each TypeScript file this plan changed.
- [ ] `pnpm test:run lib/cli/workflow > /tmp/wfrun-unit.log 2>&1`
- [ ] The prompt needs a terminal, so hand the owner this command to try by hand. Run it from a scratch copy of the spawn test's fixture project. It should list `test::lists::add` once, then run on `y`.

```bash
node <repo>/packages/agency-lang/dist/scripts/agency.js workflow run addOne --inputs '{"noteTitle":"Groceries"}'
```

- [ ] Open the PR, with its description written to a file and passed with `--body-file`.

## Open question: a budget trip's exit code

`agency run` exits 3 with a one-line `Exceeded time limit` message when `--max-time` or `--max-cost` trips. `workflow run` exits 1, and stderr holds the child's error with a stack trace. The difference comes from the evaluate script `runAgencyNode` writes, which does not catch the trip.

Matching `agency run` means wrapping the call in `lib/templates/cli/evaluate.mustache` with a catch that calls `reportBudgetExceededAndExit` (`lib/runtime/budgetExit.ts:37`). That template is shared by every `runAgencyNode` caller, including agency tests and eval runs, so their budget trips would change the same way. It is a small change, but it reaches beyond this command, so the owner decides. Until then, this plan keeps exit 1 and documents it.
