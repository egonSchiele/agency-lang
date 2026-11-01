# Workflow hard limits and `raises` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The owner prefers one agent working inline, so do not use subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No caller can raise a workflow's limits. A workflow can say which effects it may raise, and `checkWorkflow` reports a step that raises any other. `catalog` shows each tool's effects. A tool whose module imports another local `.agency` file can be used in a workflow.

**Architecture:** The generated program's scaffold wraps `main`'s body in a handler that rejects every `std::guard`. A new optional `raises` field is validated in `parse.ts` and checked in `resolve.ts` against each tool step's effects. Those effects come from `describe` and are carried on each `Signature`. One pure function, `stepEffects`, lists them per step. The `raises` check uses it here, and the CLI plans use it later. `describe` gains an optional folder and file name, so it can resolve a module's own local imports. `std::workflow` passes them when it describes a tool's module.

**Tech Stack:** TypeScript in `lib/stdlib/workflow/`; Agency in `stdlib/workflow.agency`; vitest; Agency execution tests in `tests/agency/workflow/`.

**Spec:** `docs/superpowers/specs/2026-11-01-workflow-cli.md`, "Part 1". Read `docs/dev/stdlib/workflow.md` first, especially "Why the scaffold is fixed text" and "Limits and the step guard".

## Background

- **Guards.** A trip raises `std::guard`, and an approval gives the guard more budget (`docs/site/guide/guards.md`, "When a guard trips"). The `@guard` decorator answers its own trip, so its caller cannot extend it (`stdlib/decorators.agency:60-75`).
- **The scaffolds.** `SCAFFOLD` and `GUARDED_SCAFFOLD` in `render.ts:19-47` are fixed text. The body goes in with one regex pass. `renderWorkflow` indents the body by `depth`, which is 1, or 2 under the workflow guard. It also computes line ranges from the scaffold's token positions.
- **A `return` inside a `handle` block returns from the enclosing function.** `tests/agency/destructive-in-blocks.agency:108-116` relies on this. The steps' `return failure(...)` checks and the final `return success(...)` keep working inside the new handler.
- **Names the program uses.** `PROGRAM_NAMES` in `resolve.ts:36` lists names a tool may not have, because importing it would shadow a name the scaffold uses.
- **Effects.** `describe` gives every export an `effects` list from the cross-file analysis. `guard` contributes `std::guard` through `TS_SIDE_EFFECT_SEEDS` (`lib/symbolTable.ts:531`). `_pickSignatures` (`index.ts:100`) builds each `Signature` from an export, and drops `effects` today.
- **Effect sets.** `builtinEffectSets()` in `lib/runtime/effectSets.ts` maps each set in `stdlib/effectSets.agency` to its members, with nested sets already resolved. `policyFlags.ts:29` expands `--approve` names with it.

Build and test the way the earlier workflow plans did. After editing `stdlib/workflow.agency`, run `make > /tmp/wfhl-make.log 2>&1`. Run unit tests with `pnpm test:run <files> > /tmp/wfhl-unit.log 2>&1`, and one Agency test with `pnpm run agency test <file>.test.json > /tmp/wfhl-agency.log 2>&1`. Before each commit, run `pnpm run typecheck`, and `npx prettier --write` on the TypeScript files you changed.

## Task 1: every limit is hard

**Files:** `lib/stdlib/workflow/render.ts`, `lib/stdlib/workflow/resolve.ts`, `render.test.ts`, `tests/agency/workflow/runMealPlan.agency` and its `.test.json`.

- [ ] **Step 1: Change both scaffolds.** Wrap `main`'s body in the handler:

```
export node main(inputs: Inputs!): Result {
  handle {
{{body}}
  } with (guardTrip) {
    if (guardTrip.effect == "std::guard") {
      return reject()
    }
    return pass()
  }
}
```

The `return pass()` is what a handler that returns nothing does already. It is written out so the scaffold reads like the `@guarded` decorator's handler.

In `GUARDED_SCAFFOLD`, the `return guard({{guardArgs}}) { ... }` goes inside the `handle` block. Add one to each `depth`.

Write a comment on the scaffolds saying three things:

1. The handler is what makes every limit hard.
2. It rejects a tool's own guards too.
3. As a result, `supervise()` inside a tool stops at its first check. `supervise` extends its own guard by approving `std::guard` (`stdlib/supervise.agency:72-112`), and this rejection wins over that approval. A handler cannot tell a tool's own approval from a caller's, so there is no way to keep `supervise` working without letting callers extend a tool's guard. This limitation is accepted.

- [ ] **Step 2: Add `guardTrip` to `PROGRAM_NAMES`.**

- [ ] **Step 3: Update `render.test.ts`.** The pinned sources change. Keep a range test passing unchanged in its meaning: a step's lines still map to that step.

- [ ] **Step 4: Add execution tests that a caller cannot extend a limit.** Add both to `runMealPlan.agency`, and leave `stepLimitTrips` as it is.
  1. `stepLimitIsHard`: copy `stepLimitTrips`. Its handler approves `std::guard` with `approve({ maxTime: 60000 })` and approves everything else. The workflow still fails at step `slow`. Expected output: the same as `stepLimitTrips`.
  2. `workflowLimitIsHard`: the same one-step workflow, with no step limit and `limits: { maxTime: 100 }` on the workflow, and the same approving handler. This covers the guard `GUARDED_SCAFFOLD` writes, which moved inside the handler. The run fails, and the failure names the workflow's limit.

  Both tests fail before Step 1 and pass after it. Without the handler, the caller's approval lets `slowEcho`'s 2-second sleep finish.

- [ ] **Step 5: Run and commit.** Run `render.test.ts`, `resolve.test.ts`, and `tests/agency/workflow/runMealPlan.test.json`. The existing run, compile, and check tests should pass unchanged, except for pinned sources. Commit: `std::workflow: every limit is hard`.

## Task 2: effects on signatures and in the catalog

**Files:** `lib/stdlib/workflow/types.ts`, `index.ts`, `catalog.ts`, `stdlib/workflow.agency`, `catalog.test.ts`, `tests/agency/workflow/catalog.agency` and its `.test.json`.

- [ ] **Step 1:** Add `effects: string[]` to `Signature`, with the comment "What `describe` reports the tool can raise." `_pickSignatures` copies it from the export.
- [ ] **Step 2:** Add `effects: string[]` to `CatalogEntry`, in TypeScript and in the Agency type. `catalogEntry` copies it from the signature unchanged, `std::guard` included, because a catalog entry describes the tool, not a workflow. The doc comment says this: "What the tool can raise, as `describe` reports it. A tool that uses `guard` lists `std::guard`. A workflow rejects every guard trip itself, so `std::guard` never reaches a workflow's caller, and `stepEffects` leaves it out."
- [ ] **Step 3: Tests.** In `catalog.test.ts`, an entry for a tool whose signature has effects carries them. In `catalog.agency`, add a case for `addListItems` from `fixtures/tools/lists.agency`: its `effects` is `["test::lists::add"]`. Update any pinned output that now holds `effects`.
- [ ] **Step 4:** `make`, run the tests, and commit: `std::workflow: catalog lists each tool's effects`.

## Task 3: `stepEffects`

**Files:** create `lib/stdlib/workflow/effects.ts` and `effects.test.ts`.

- [ ] **Step 1: Write the function.**

```ts
/** One tool step and the effects its tool can raise. */
export type StepEffects = { step: string; tool: string; effects: string[] };

/** The effects each tool step raises, in step order. `std::guard` is left
 *  out: the generated program rejects every guard trip itself, so it never
 *  reaches a caller. A step whose signature is missing raises nothing here;
 *  resolve reports that step on its own. */
export function stepEffects(
  workflow: Workflow,
  signatures: Record<string, Signature>,
): StepEffects[]
```

- [ ] **Step 2: Tests.**
  1. The meal plan, with signatures that give `addListItems` `["test::lists::add"]` and `readNote` `["std::read"]`, gives one entry per tool step, with those effects.
  2. A tool whose effects include `std::guard` lists the rest without it.
  3. LLM steps add nothing.
- [ ] **Step 3:** Commit: `std::workflow: stepEffects`.

## Task 4: the `raises` field

**Files:** `lib/stdlib/workflow/types.ts`, `parse.ts`, `resolve.ts`, `stdlib/workflow.agency`, `lib/runtime/effectSets.ts`, `lib/runtime/policyFlags.ts`, `parse.test.ts`, `resolve.test.ts`, `lib/runtime/effectSets.test.ts`, `tests/agency/workflow/check.agency` and its `.test.json`.

- [ ] **Step 1: The type.** Add `raises?: string[] | null` to `Workflow` in `types.ts`, with the comment "The effects the workflow may raise. Absent or null means any." Add `raises?: string[]` to the Agency `Workflow` type, with a doc comment that points at `docs/site/guide/effects-and-raises.md`.

- [ ] **Step 2: Parse.** `raises` is an optional array of strings. Each entry is `*` or a name matching `EFFECT_NAME`, a new constant in `types.ts` beside `REF_PATH`: `/^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/`. Anything else is a problem on field `raises`, with step `null`, saying which entry is wrong. Test:
  1. A missing `raises` passes.
  2. `[]`, `["*"]`, `["std::read", "FileRead"]`, and `["unknown"]` all pass.
  3. `"std::read"` (not an array), `[5]`, and `["std read"]` each give one problem on `raises`.

- [ ] **Step 3: One expansion of set names.** `expandSetNames` in `lib/runtime/policyFlags.ts:29` already turns set names into effects for `--approve` and `--reject`, and it is private. Move its expansion into `lib/runtime/effectSets.ts` as a pure function:

```ts
/** Each name as the effects it stands for: a built-in set's members, or
 *  the name itself. This is Agency's rule for a bare name in `raises`. */
export function expandEffectNames(names: string[]): string[]
```

`expandSetNames` keeps its near-miss warning and calls `expandEffectNames` for the expansion. The policy flag tests must pass unchanged. Add a test for `expandEffectNames` in `effectSets.test.ts`: `FileSystem` expands to the members of both nested sets, and `std::read` and `unknown` stay as they are.

- [ ] **Step 4: The check.** Add a rule to `RULES` in `resolve.ts`:
  1. No `raises`, or one holding `*`, allows everything.
  2. Otherwise, the allowed effects are `expandEffectNames(raises)`.
  3. For each `stepEffects` entry, each effect outside the allowed list is one problem: `{ step, field: "tool", message: \`${tool} raises "${effect}", which the workflow's raises does not allow\` }`.

Test in `resolve.test.ts`, with hand-built signatures that give `readNote` `["std::read"]` and `addListItems` `["test::lists::add"]`:
  1. `raises: ["test::lists::add"]` with the meal plan gives one problem, on step `text` for `std::read`.
  2. `raises: ["FileRead", "test::lists::add"]` gives none.
  3. `raises: []` gives one problem per effect per step.
  4. A tool whose only effect is `std::guard` gives none under `raises: []`.

- [ ] **Step 5: An end-to-end check.** In `check.agency`, add a node that checks a two-step workflow over `notes.agency` and `lists.agency` with `raises: ["std::read"]`. It returns the problems' `step/field` strings. Expected output: the `add/tool` problem.

- [ ] **Step 6:** `make`, then run `parse.test.ts`, `resolve.test.ts`, `lib/runtime/effectSets.test.ts`, `lib/runtime/policyFlags.test.ts`, and `check.test.json`. The policy flag tests must pass unchanged. Commit: `std::workflow: a workflow's raises, checked by checkWorkflow`.

## Task 5: describe a module whose imports are local files

**Files:** `lib/stdlib/agency.ts`, `stdlib/agency.agency`, `stdlib/workflow.agency`, `lib/stdlib/agency.test.ts` (or the file that tests `_describe` today), and a new fixture pair under `tests/agency/workflow/fixtures/tools/`. Also `tests/agency/workflow/check.agency` and `run.agency`, with their `.test.json` files.

### Why it fails today

`_describe(source)` (`lib/stdlib/agency.ts:255`) gets text with no path. `describeSource` computes effects with `getEffectsFromSource`, which runs the type checker's effect analysis. That analysis must open every file the module imports, and with no path it cannot resolve `./helpers.agency`. It throws `AG4009 Cannot find module './helpers.agency'`. `_signatures` in `stdlib/workflow.agency:137` describes each local tool module this way. So a tool whose module imports a local file cannot be used in any workflow.

### What already exists

- `effectsVia(source, sourcePath, config)` in `lib/compiler/typecheck.ts:262` runs the same analysis with a real path. Only tests call it today, through `getEffectsFromFile`. With a real path the pipeline can expand splices, which runs their generators. So the imports must be checked first, and the call passes `{ refuseSplices: true }`.
- `_typecheck(source, dir, strict)` (`lib/stdlib/agency.ts:138`) does the safe version for a type check. `sandboxImportErrors` runs `validateClosure` before anything expands. It refuses TypeScript files, `..` escapes, symlinks, and splices, without running them. Only then does the type check run, with a path inside `dir`.

### Steps

- [ ] **Step 1: Thread a path through `describeSource`.** Give it an optional `sourcePath`. With a path, effects come from `effectsVia(source, sourcePath, { refuseSplices: true })`. Without one, they come from `getEffectsFromSource`, as today. Everything else in `describeSource` is unchanged.

- [ ] **Step 2: `_describe` takes an optional folder and file name.**

```ts
/** Describe a module's exports. With `dir` and `filename`, the source is the
 *  file at `filename` inside `dir`, so its relative imports resolve against
 *  its own folder. The imports are checked as a sandboxed compile checks
 *  them, before anything runs: a TypeScript file, an escape from `dir`, a
 *  symlink, or a splice is refused. */
export function _describe(source: string, dir: string = "", filename: string = ""): ModuleInfo
```

With both given:
1. `resolveInSandbox(dir, filename, root)` gives the real path.
2. `validateClosure({ entry: { file: filename }, dir })` checks the imports. A `ClosureValidationError` is thrown with its violations, in a message that names the module.
3. `describeSource(source, [], realPath)` describes it.

With only one of the two given, it throws a message saying both are needed. The description is of `source`, the text the caller read. Only the imports are read from disk.

- [ ] **Step 3: The public `describe`.** In `stdlib/agency.agency:922`, add `dir: string = ""` and `filename: string = ""` to `describe`, passed through to `_describe`. Add both to the docstring, and update its sentence about relative re-exports. A relative re-export still comes back as a thin entry, since only imports are resolved here.

- [ ] **Step 4: `std::workflow` passes the path.** In `_signatures`, a local module is still read with `read(group.module, dir)`, so its `std::read` prompt does not change. Then call `describe(source, dir: dir, filename: group.module)`. A `std::` module still goes through its re-export line, with no path. The imported files are read without prompts of their own, as `_checked`'s type check already reads them.

- [ ] **Step 5: Tests.**
  1. In the `_describe` tests, write a module and a sibling into a temp folder. The module imports a helper from the sibling, and the helper raises an effect. With the folder and file name, `_describe` returns the module's def, and its effects include the sibling's effect. Without them, it still throws `Cannot find module`, as today.
  2. A module that imports a TypeScript file, and one that imports `../outside.agency`, are each refused with the validator's violation in the message.
  3. Add `tests/agency/workflow/fixtures/tools/withHelper.agency`. Its exported def calls a helper from a new `tests/agency/workflow/fixtures/tools/helper.agency`, and the helper returns a string. In `check.agency`, a workflow with a step that calls it has no problems. In `run.agency`, running that workflow returns the helper's value. The workflow's program already compiles in the sandbox with local `.agency` imports, so nothing else should need to change. If `run` fails, the error tells you which part does.

- [ ] **Step 6:** `make`, run the tests, and commit: `describe: resolve a module's local imports from its file path`.

## Task 6: documentation

- [ ] **`docs/dev/stdlib/workflow.md`.**
  - Under "Limits and the step guard", add how the scaffold's handler makes every limit hard, and that it covers a tool's guards too. Add the `supervise()` limitation, with the example from the review: a tool that wraps `codingAgent` in `supervise(every: 5m, maxTime: 30m, ...)` stops after 5 minutes when a workflow calls it. Say why it is accepted.
  - Add a section, "What a workflow may raise". Cover these:
    - the `raises` field and its four forms;
    - how set names expand;
    - `unknown`, the effect of a bare `interrupt("...")`, which a workflow allows by listing `"unknown"`;
    - only the built-in effect sets expand. A set a user declared with `effectSet` is read as one effect name, because the workflow does not name the module that declares it;
    - why the check lives in `resolve` and not in the type checker's AG3013;
    - what the analysis cannot see.
  - In "The catalog", add `effects`, and why it keeps `std::guard` while `stepEffects` drops it.
  - In "Tool modules", say that a tool's module may import other local `.agency` files inside `dir`. `_signatures` describes it with its path, after the same import check a sandboxed compile makes. Add one remaining limit: a return type that names a type alias imported from another file is not recognized as a `Result`. `describe` resolves aliases only in the module's own file. The strict type check in `_checked` catches the mistakes this causes.
- [ ] **`docs/dev/compiler/effect-propagation.md`.** `getEffectsFromFile`'s comment says only tests call `effectsVia` with a path. Update that sentence: `_describe` now calls it, with splices refused.
- [ ] **The module doc in `stdlib/workflow.agency`.** If it lists the format's fields, add `raises`. Wherever it describes limits, add one sentence: a workflow's limits are hard, and a tool that uses `supervise()` stops at its first check when a workflow calls it. `make` regenerates `docs/site/stdlib/workflow.md`. Do not edit that file by hand.
- [ ] Commit: `std::workflow: document hard limits and raises`.

## Task 7: final checks

- [ ] `pnpm run typecheck` and `pnpm run lint:structure`.
- [ ] `npx prettier --write` on each TypeScript file this plan changed.
- [ ] `pnpm test:run lib/stdlib/workflow lib/stdlib/agency.test.ts lib/runtime/effectSets.test.ts lib/runtime/policyFlags.test.ts > /tmp/wfhl-unit.log 2>&1`
- [ ] `describe` is public, so run the Agency tests that call it: `grep -rl "describe(" tests/agency --include=*.agency`, then each one's `.test.json`.
- [ ] Run each workflow Agency test: `run`, `runMealPlan`, `check`, `compile`, `catalog`, `save`, and `tool`, each with `pnpm run agency test tests/agency/workflow/<name>.test.json`. Set `AGENCY_USE_TEST_LLM_PROVIDER=1` for the ones with mocked model calls.
- [ ] Open the PR, with its description written to a file and passed with `--body-file`.
