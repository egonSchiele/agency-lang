# Review: `agency workflow tools`, `check`, `compile`, and `list`

Plan: `docs/superpowers/plans/2026-11-01-workflow-cli-basic-commands.md`

## Verdict

The driver design works, and the plan fits the code it names. One finding changes how the commands behave on real projects: a tool module that imports another local file cannot be described. The plan currently hides that behind a wrong error message. Two smaller findings are one-line fixes in `runDriver`.

## 1. A tool module that imports a local file cannot be described (high)

`_describe` works on source text, with no file path. When that text imports a relative path, it throws. I ran it against a real file, from the repo root and from the module's own folder:

```
import { findLists } from "./lists.agency"
export def a(x: string): string { ... }
```

Both runs threw `AG4009 Cannot find module './lists.agency'`.

`std::workflow`'s own `_signatures` (`stdlib/workflow.agency:137-158`) describes a local module the same way, so this is an existing limit of `std::workflow`. A tool module that imports a helper file cannot be used in any workflow today. The spec's own examples, such as `./src/agent/lists.agency`, are the kind of module that usually imports something.

The plan makes the limit harder to see:

- `importsForSteps` leaves a step's tool out "without a problem" when its module does not describe. `checkWorkflow` then reports `tool "addListItems" from "./src/agent/lists.agency" is not among the tools passed to this workflow`. The person did nothing wrong in the workflow, and the message sends them looking for the wrong mistake.
- `tools ./src/agent/lists.agency` exits 2 with an AG4009 message that names a file the person did not pass.

Recommended changes:

1. In `importsForSteps`, a module that exists inside `dir` but fails to describe is a problem on the step's `module` field, with the describe error in the message. Only a missing module, a module outside `dir`, an unknown name, or a malformed step is left for `checkWorkflow`.
2. In `tools`, print the describe error with the source it came from, for example `./src/agent/lists.agency: cannot read its exports: Cannot find module './helpers.agency'`.
3. Open a ticket for describing a local module by file path, so imports resolve. That fix belongs in `std::workflow` and `std::agency`, not in this plan. Until it lands, say in `docs/site/cli/workflow.md` that a tool's module must not import other local files.

## 2. A project with `distDir` in `agency.json` breaks every command (medium)

`runAgencyNode` (`lib/cli/util.ts:285-287`) skips compiling when `config.distDir` is set, and looks for a precompiled file there instead:

```ts
if (distDir) {
  compiledPath = resolveCompiledFile(distDir, agencyFile);
}
```

The driver is never precompiled, so in a project that sets `distDir` every workflow command fails. `runDriver` builds the config already. Have it also clear `distDir`:

```ts
config: { ...applyCliFlags(call.config, { refuseSplices: true }), distDir: undefined }
```

Add a unit test that the stub `run` receives a config with no `distDir`.

## 3. `check` leaves compiled `.js` files beside the user's tools (decide)

Compiling the driver compiles each tool module it imports. With no `outDir`, `outputPathFor` (`lib/compiler/buildSession.ts:743-750`) writes each output next to its source. So after `agency workflow check updateMealPlanFromNote`, the project has `src/agent/appleNotes.js` and `src/agent/lists.js`. The temp folder cleanup removes only the driver's files.

`agency run` does the same thing, so this may be fine. It is surprising for `check` and `tools`, which a person expects to read only. Pick one:

- Accept it, and say so in `docs/site/cli/workflow.md`.
- Point `outDir` at the temp folder in `runDriver`. That needs a check that imports between compiled files still resolve under `outDir`, so it is more than a one-line change.

I recommend accepting and documenting it. Then add a spawn-test assertion that pins the behavior, so a later change to it is deliberate.

## 4. Smaller notes

- **Background, `runAgencyNode`.** "`executeJudgeAsync` in the same file is a caller to read" is wrong. `executeJudgeAsync` calls `runAgencyJudge`. The callers of `runAgencyNode` are `executeNodeAsync` (`lib/cli/util.ts:414`) and the eval grader (`lib/eval/grading/agencyRunner.ts:24`). Point at those.
- **The `std::` check got looser.** The first draft required `/^std::[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/`. The new text uses `isStdlibImport`, which is only `startsWith("std::")`, plus `MODULE_PATH`, which allows `.` and `/`. So `std::../../x` passes both and reaches `_describe` as `export * from "std::../../x"`. The stdlib resolver probably refuses it, but the CLI should refuse it first. Keep the stricter pattern, or add a test that such a source gets a clear error.
- **A tool module with a type error.** The driver compiles the tool modules normally, so a type error in a tool makes `compile()` print its errors and call `process.exit(1)`. The person sees compiler output that names `driver.agency` in `.agency-tmp`, a file they never wrote. Say in the dev doc that this is what a broken tool module looks like from these commands. It is rare enough not to need code.
- **The exit listener.** `compile()` exits synchronously, so the `process.once("exit")` cleanup must delete synchronously. `safeDeleteDirectoryWithin` does, but say so in Task 4, because an async delete in an exit listener never runs.

## What I checked and found correct

- **The `with approve` claim.** `catalog`, `checkWorkflow`, and `compileWorkflow` raise only `std::read`, through `_signatures`. `loadWorkflow` and `listWorkflows` raise only `std::workflow::scan`. None of them runs a tool. `withRootCarriers` deletes `AGENCY_RUN_POLICY` from the child's environment when no policy carrier is passed, so no outside policy can reject these prompts.
- **Import paths from the temp folder.** `MODULE_PATH` (`lib/stdlib/workflow/tools.ts:20`) allows `..`, so `importLine` accepts `../../tools/lists.agency`. `toolRefs` computes each tool's module from the source file the function value records, so importing it through a different relative path does not change its `module`.
- **Helpers named in the plan.** `_workflowNameProblem`, `parseWorkflow`, `isStdlibImport`, `resolveInSandbox(dir, filename, root)`, `isStrictDescendant`, `makeAgencyTempDir`, `safeDeleteDirectoryWithin`, and `stripControlCharacters` all exist with the signatures the plan uses. `describeProblem` exists in `index.ts` and is private, as the plan says.
- **The serialized `Result`.** It has `__type: "resultType"`, `success`, and `value` or `error` (`lib/runtime/result.ts`), which is enough for `readDriverResult` to tell a value from a failure. An unanswered interrupt comes back as an array, which the evaluate template's `hasInterrupts` already checks.
- **The driver syntax.** `const x = f() with approve` is used in `tests/agency/contained-filenames.agency:19`. `x is failure` and `return x` from a node are used throughout the workflow tests.
- **The spawn fixtures.** `searchNotes` and `findLists` raise nothing, and `addListItems` raises `test::lists::add`, so case 3's expected `can raise:` output is right.
