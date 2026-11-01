# ADI-253: Find a workflow tool's file wherever the host runs from — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The owner prefers one agent working inline, so do not use subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workflow imports a local tool from the file the tool was defined in, even when the host runs from a different working directory than the one it was compiled in.

**Architecture:** Each function value gains `sourceFile`, the absolute path of the `.agency` file it was defined in. The compiler writes the path from the compiled `.js` file to its source into the compiled module. When the module loads, it resolves that path against its own folder, which it already knows from `import.meta.url`. `toolRefs` then builds a tool's import path from `sourceFile` and stops resolving the module id against the current working directory.

**Tech Stack:** TypeScript in `lib/runtime/agencyFunction.ts`, `lib/backends/typescriptBuilder.ts`, `lib/compiler/compile.ts`, and `lib/stdlib/workflow/tools.ts`; one typestache template; vitest; one agency-js test.

**Spec:** `docs/superpowers/specs/2026-10-26-workflows-design.md`, section "Tools and modules". Linear ticket ADI-253. Read `docs/dev/stdlib/workflow.md` ("Tool modules") and `docs/dev/language/agency-function.md` before starting.

## Background for someone new to this codebase

### How a workflow finds a tool's file today

A host hands a workflow its tools as function values:

```
import { searchNotes } from "./notes.agency"

const result = runWorkflow(workflow, inputs, [searchNotes], __dirname)
```

The generated program has to import `searchNotes`, so the generator needs an import path for it, relative to the workflow's `dir`. It gets one from the function value's `module` field. That field is the compiler's module id, written into the compiled code as a string (`typescriptBuilder.ts:2681`). The id is the source file's path relative to the working directory the compiler ran in:

```ts
const moduleId = path.relative(process.cwd(), absoluteInputFile);   // buildSession.ts:505
```

So compiling `~/bmo/src/agent/notes.agency` from `~/bmo` gives the id `src/agent/notes.agency`.

`toolRefs` (`lib/stdlib/workflow/tools.ts:58-65`) turns that id back into a file by resolving it against the working directory at run time, which `_toolRefs` reads from the host (`index.ts:70`):

```ts
const fromDir = path.relative(path.resolve(cwd, dir), path.resolve(cwd, tool.module));
```

That is right only when the host runs from the directory it was compiled in. When it runs from anywhere else, the id points at a different place.

### The bug, reproduced

A host program and a local tool in one folder were compiled from the package root, then run twice (both runs on a current build):

```
--- run from package root:
OK
--- run from the tool's own folder:
REFUSED: the workflow has problems:
ENOENT: no such file or directory, open '.../cwdprobe/tests/agency/workflow/test-output/cwdprobe/shout.agency'
```

From the tool's folder, the id `tests/agency/workflow/test-output/cwdprobe/shout.agency` is resolved against that folder, so the path doubles and the read fails. If a file had existed at the doubled path, the workflow would have imported that file instead of the host's tool. If the doubled path had fallen outside `dir`, the check would have refused the tool as "outside the workflow directory".

An agency-js test hits the same failure with no setup. The runner compiles from the package root (`lib/cli/test.ts:1330`) and then runs `node test.js` with the test's own folder as the working directory (`test.ts:1397-1398`). A probe agency-js test that runs a workflow over a local tool fails with the same doubled-path `ENOENT`. Task 4 turns that probe into the test for this ticket.

### What each part of the system knows

The ticket asks whether a function value can carry an absolute path for its module, or whether the registry can recover one.

- **The registry cannot.** It is one shared object keyed `${module}:${name}` (`agencyFunction.ts:719`), holding the function values themselves. It has no path beyond the module id.
- **The compiled module knows where it is.** Every generated module declares `const __dirname = __host.system.moduleDir(import.meta.url);` in its prelude (`lib/templates/backends/typescriptGenerator/imports.mustache:46`). On Node that is the folder of the compiled `.js` file (`lib/host/node/nodeHost.ts:236`). This is how Agency code reads `__dirname`.
- **The compiler knows where the source is relative to the output.** The TypeScript builder already holds both paths. The compilation unit's `fromFile` is the absolute path of the source file (`compilationUnit.ts:365-366`). `outputFile` is the file the generated code is written to (`typescriptBuilder.ts:390-393`, `:428`). `buildSession.compileEntry` sets both: it builds the unit from `absoluteInputFile` (`buildSession.ts:462`) and passes `absoluteOutputFile` to `generateTypeScript` (`:514`). The output sits beside the source, or under `config.outDir` (`outputPathFor`, `buildSession.ts:743-749`).

So a function value can carry its absolute source path. The compiler writes the path from the output to the source, and the module turns it into an absolute path when it loads. That path does not depend on the working directory at compile time or at run time.

### Programs compiled for a subprocess have no source file

`run` from `std::agency` compiles a program with `compileSource` (`lib/compiler/compile.ts`). That gives every module a random id, `agency_<nanoid>` (`compile.ts:128`), and returns the code as text. The child process later writes the text to a location of its own. The sources it compiled from are mirrored into a temporary folder, which `compileValidatedClosure` deletes when it finishes. Code compiled this way has no source file it can point at, so it records none. `compileSource` passes the builder a made-up output path, `<temp folder>/<id>.js` (`compile.ts:209`). The builder reads `outputFile` in one place, as a fallback behind `fromFile` (`typescriptBuilder.ts:1819`), so that path is never read today. This plan stops passing it. Its function values have random ids today, so a child that passes its own local tools to a workflow already fails. This plan makes that a clear refusal instead of a confusing read error.

### Paths in compiled code today

No compiled code uses an absolute path to find a file. Compiled code contains one absolute path today, in the label of an error message that a `static` read can throw (`__readStatic`, `lib/runtime/staticInit.ts:53-72`). Compiled output can be built in one place and run in another, as the stdlib in the npm package is. A fix that baked in the build machine's absolute paths would break when a built project is moved, and it would leak the build machine's folder names into the output.

### Build and test commands

- After editing a `.mustache` template, run `pnpm run templates`. Never edit the generated `.ts` beside it.
- After changing codegen, run `make fixtures > /tmp/adi253-fixtures.log 2>&1`. It regenerates the expected output of the fixture tests. The generated-code fixtures, 88 under `tests/typescriptGenerator` and 2 under `tests/typescriptBuilder`, each change in two places: the new `__sourceFile` line, and one property on each `def`'s `AgencyFunction.create` call. The preprocessor fixtures are AST JSON and do not change.
- Unit tests: `pnpm test:run <files> > /tmp/adi253-unit.log 2>&1`, then read the file.
- The agency-js test: `pnpm run agency test js tests/agency-js/workflow-tool-from-another-cwd > /tmp/adi253-js.log 2>&1`. Run it from the package root. That is what makes the compile directory differ from the run directory.
- Before each commit: `pnpm run typecheck`, and `npx prettier --write` on the TypeScript files you changed. Do not run `pnpm run fmt:ts`, which formats every worktree under the package.

## Global Constraints

- Module ids do not change. `module` keeps its value and meaning. Everything keyed on it keeps working unchanged: globals, the registry, checkpoints, code fingerprints, the `std::` and `pkg::` checks in `tools.ts`.
- Compiled code holds no absolute path from the machine that compiled it. It holds a path relative to its own location.
- `sourceFile` is not written into a checkpoint. The checkpoint format does not change.
- A workflow's `dir` keeps its meaning: a relative `dir` is read against the working directory at run time.
- When a function value has no source file, `toolRefs` refuses the tool. It never falls back to the old guess from the working directory.
- The generated line runs when a module loads, in Node and in the browser bundle, so it must not read `process`. It uses `path.join`, which only normalizes. The portable `path` behind the browser bundle (`path-browserify`, `lib/utils/path.portable.ts`) reads `process.cwd()` in `resolve` when no argument is an absolute path. A browser's `__dirname` is a URL, so `path.resolve(__dirname, ...)` throws there: a probe gave `TypeError: Cannot read properties of undefined (reading 'cwd')`. `path.join` on the same URL returns a harmless string.

## Calls I made

1. **The design.** The compiler records where the source is relative to the compiled file, and the module resolves it when it loads. Three other designs were set aside:
   - Writing the absolute source path into the compiled code. It breaks when built output is moved, for example when a CI build is copied into a container. It also writes the build machine's folder names into every compiled file.
   - Making module ids relative to a fixed root, such as the project root. Module ids key globals, the registry, checkpoints, code fingerprints, and logs. Changing them is a far larger change than this bug needs.
   - A registry keyed by module id, filled by one line in each module's prelude, the way `lib/runtime/moduleFingerprintRegistry.ts` holds code hashes. `toolRefs` would look up `tool.module` in it. That is one generated line per module instead of one property per `def`, so half the fixture churn, and no new field on `AgencyFunction`. It was set aside for two reasons. It is TypeScript module state, which the repo avoids outside the places that already have it. And it is keyed by module id, so two builds of one module loaded in one process, such as a build beside the source and an `outDir` build, would overwrite each other's entry. A field on the function value cannot be wrong about the function it sits on.

   The owner chose the field on each function value over the registry.
2. **No source file means a refusal.** A function value with `sourceFile: null` is refused with the message `tool "<name>" does not record the file it was defined in, so a workflow cannot import it`. Guessing from the working directory is the bug this ticket fixes, so the guess is removed. Four kinds of function value have no source file: one from a module compiled before this change, one from a program `run` compiled for a subprocess, a block, and the stub `revive` builds for a function in a checkpoint whose module this process never loaded (`makeUnresolvedFunctionStub`, `lib/runtime/revivers/functionRefReviver.ts:290-316`). The fix differs for each, so the message states the fact and the doc comment on `toolRefs` lists the four causes. For the first, the fix is to recompile the module.
3. **`sourceFile` describes this process, not the program state.** A checkpoint does not carry it. A revived function value comes from the registry of the process that resumes, which loaded the module from its own location.
4. **Only `def`s carry a source file.** Blocks, runtime builtins, and tools built by `createTool` get null. `toolRefs` already refuses a builtin and a `createTool` tool before it needs a path. A block passed as a tool now gets the no-source-file refusal, which is correct, because a block cannot be imported.
5. **No symlink handling.** On Node, `import.meta.url` gives the compiled file's real path. A module imported through a symlinked folder reports the folder it really lives in, as a probe confirmed. A `dir` spelled through a symlink resolves to a different string, so its tools read as outside the workflow directory and are refused. The repository rule is to refuse symlinks, not to support them.
6. **The "outside the workflow directory" message names the source file's absolute path** instead of the module id, since the id depends on where the compiler happened to run. That changes what a model can see in a tool result: the refusal now carries an absolute path from this machine. The `ENOENT` messages that already reach a model carry absolute paths as well. The PR body says so.
7. **No new compiler parameter.** The builder already holds the source path, as `compilationUnit.fromFile`, and the output path, as `outputFile`. It records a source file when it has both. `outputFile` then means the file the generated code is written to and loaded from. `compileSource` loads its output from somewhere else, so it stops passing its made-up path.

## Not in this ticket

- `tools.ts` still recognizes a `std::` tool by its module id (`STDLIB_ID`, `tools.ts:23`). The stdlib is always compiled from the package root, so those ids are stable.
- The debug session's `sourcePathFor` (`lib/cli/debugSession/readers.ts:157-163`) also reads a module id as a path. It looks for a stopped program's source under the current directory, then beside the compiled program. It works from a checkpoint and a source map, with no function value to read `sourceFile` from, so it stays as it is.

## Review Focus

These are the inputs the spec implies but no test in the ticket exercises. Each one gets a test in the task named.

1. A host compiled at the project root and run from a subfolder: the workflow imports the right file. (Task 4)
2. A relative `dir` while the working directory differs from the compile directory: `dir` is still read against the working directory at run time. (Task 3)
3. A function value with no source file is refused. Its module id is not resolved against the working directory. (Task 3)
4. Output in a different folder from its source, as with `outDir`: the recorded path climbs out of the output folder correctly. (Task 2)
5. A derived copy, such as `.describe()`, and a function revived from a checkpoint keep the source file. (Task 1)

---

### Task 1: `AgencyFunction.sourceFile`

**Files:**
- Modify: `lib/runtime/agencyFunction.ts` (`AgencyFunctionOpts`, the class fields, the constructor, `options()`)
- Test: `lib/runtime/agencyFunction.test.ts` and `lib/runtime/revivers/functionRefReviver.test.ts`

**Interfaces:**
- Produces: `AgencyFunctionOpts.sourceFile?: string | null`, and `readonly sourceFile: string | null` on `AgencyFunction`, which is null when not given. Its doc comment: the absolute path of the `.agency` file this function was defined in, resolved when its compiled module loaded; null for a function with no source file, such as a block, a builtin, or code compiled for a subprocess.

- [ ] **Step 1: Write the failing tests**

In `agencyFunction.test.ts`, a new describe block:

```ts
describe("sourceFile", () => {
  const shout = (sourceFile?: string | null) =>
    AgencyFunction.create(
      {
        name: "shout",
        module: "agent/shout.agency",
        sourceFile,
        fn: (_run, text: string) => text,
        params: [
          { name: "text", hasDefault: false, defaultValue: undefined, variadic: false },
          { name: "loud", hasDefault: false, defaultValue: undefined, variadic: false },
        ],
        toolDefinition: {
          name: "shout",
          description: "Shout.",
          schema: z.object({ text: z.string(), loud: z.boolean() }),
        },
      },
      {},
    );

  it("is null when none is given", () => {
    expect(shout().sourceFile).toBeNull();
  });

  it("is carried by every derivation", () => {
    const original = shout("/proj/agent/shout.agency");
    const derived = [
      original.partial({ loud: true }),
      original.rename("yell"),
      original.describe("Shout louder."),
      original.preapprove(),
      original.withParamSchema("text", { type: "string" }),
    ];
    expect(derived.map((fn) => fn.sourceFile)).toEqual(
      derived.map(() => "/proj/agent/shout.agency"),
    );
  });
});
```

In `functionRefReviver.test.ts`, inside a new describe block, using the file's `roundTripFunction` helper:

```ts
it("a revived function takes its source file from the registered function", () => {
  const registry: Record<string, AgencyFunction> = {};
  const tool = AgencyFunction.create(
    {
      name: "shout",
      module: "agent/shout.agency",
      sourceFile: "/proj/agent/shout.agency",
      fn: (_run, text: string) => text,
      params: [{ name: "text", hasDefault: false, defaultValue: undefined, variadic: false }],
      toolDefinition: { name: "shout", description: "Shout.", schema: z.object({ text: z.string() }) },
    },
    registry,
  );
  expect(new FunctionRefReviver().serialize(tool)).not.toHaveProperty("sourceFile");
  expect(roundTripFunction(tool.describe("Shout louder."), registry).sourceFile).toBe(
    "/proj/agent/shout.agency",
  );
});
```

Run both files. The new tests fail because `sourceFile` is undefined.

- [ ] **Step 2: Add the field**

Add the option, the readonly field set from `opts.sourceFile ?? null`, and `sourceFile: this.sourceFile` in `options()`. `options()` is the one place `derive` reads, so every derivation carries the field. Leave `FunctionRefReviver` unchanged: `serialize` does not write the field, and `revive` starts from the registered function, which has it.

- [ ] **Step 3: Run, typecheck, commit**

Both test files pass. Typecheck, prettier, and commit with the message in a file: `AgencyFunction: record the file a function was defined in`.

---

### Task 2: The compiled module records its source file

**Files:**
- Modify: `lib/templates/backends/typescriptGenerator/imports.mustache` (one line after `__dirname`), then `pnpm run templates`
- Modify: `lib/backends/typescriptBuilder.ts` (the doc comment on the constructor's `outputFile` parameter at line 390, the call to `renderImports.default` at line 4718, and `createProps` at line 2679)
- Modify: `lib/compiler/compile.ts` (remove the unused `outputPath` at line 209, and pass `undefined` in its place at line 220)
- Create: `lib/backends/sourceFile.codegen.test.ts`
- Test: `lib/compiler/compile.test.ts`
- Regenerate: the fixtures, with `make fixtures`

**Interfaces:**
- Consumes: `AgencyFunctionOpts.sourceFile` from Task 1.
- Produces:
  - No new parameter on `generateTypeScript` or `TypeScriptBuilder`. The builder records a source file when it has both `outputFile` and `compilationUnit.fromFile`.
  - The doc comment on `outputFile` says it is the file the generated code is written to and loaded from.
  - Every generated module declares `const __sourceFile = path.join(__dirname, "<path from the output's folder to the source>");` right after `__dirname`. When the builder lacks either path, it declares `const __sourceFile = null;`.
  - Every `def`'s `__AgencyFunction.create({ ... })` gets `sourceFile: __sourceFile`.
  - `__sourceFile` starts with two underscores, so it is a compiler name that no Agency program can declare (`docs/dev/language/reserved-names.md`).

- [ ] **Step 1: Write the failing tests**

`lib/backends/sourceFile.codegen.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCompilationUnit } from "@/compilationUnit.js";
import { parseAgency } from "../parser.js";
import { generateTypeScript } from "./typescriptGenerator.js";

const SOURCE = "export def shout(text: string): string {\n  return text\n}\n";
const SOURCE_FILE = "/proj/agent/shout.agency";

/** The generated code for SOURCE, compiled from SOURCE_FILE to `outputFile`. */
function generate(outputFile?: string): string {
  const parsed = parseAgency(SOURCE, {}, false);
  if (!parsed.success) {
    throw new Error(parsed.message);
  }
  const info = buildCompilationUnit(parsed.result, undefined, SOURCE_FILE);
  return generateTypeScript(parsed.result, undefined, info, "agent/shout.agency", outputFile);
}

describe("the compiled module's source file", () => {
  it("is found beside the compiled file", () => {
    expect(generate("/proj/agent/shout.js")).toContain(
      'const __sourceFile = path.join(__dirname, "shout.agency");',
    );
  });

  it("is found from an output folder elsewhere, as with outDir", () => {
    expect(generate("/proj/dist/agent/shout.js")).toContain(
      'const __sourceFile = path.join(__dirname, "../../agent/shout.agency");',
    );
  });

  it("is null when the code is not written to a known output file", () => {
    expect(generate()).toContain("const __sourceFile = null;");
  });

  it("is given to every def's function value", () => {
    expect(generate("/proj/agent/shout.js")).toMatch(
      /__AgencyFunction\.create\(\{[^]*?sourceFile: __sourceFile/,
    );
  });
});
```

In `lib/compiler/compile.test.ts`, inside `describe("compileSource")`:

```ts
it("records no source file for a program that runs from somewhere else", () => {
  const result = compileSource(`export def shout(text: string): string {\n  return text\n}\n`, {});
  expect(result.success && result.code).toContain("const __sourceFile = null;");
});
```

Run both files. All five tests fail.

- [ ] **Step 2: Emit the line and the property**

In the template, after the `__dirname` line, add `const __sourceFile = {{{sourceFile:string}}};`. Run `pnpm run templates`.

In the builder, compute the expression once, in the method that renders the imports template. When `this.outputFile` and `this.compilationUnit.fromFile` are both set, build a TS IR call, `$.id("path").prop("join").call([ts.id("__dirname"), ts.str(rel)])`, and print it with `printTs`. Here `rel` is `path.relative(path.dirname(outputFile), fromFile)`. Otherwise the expression is `"null"`. Pass it to `renderImports.default` beside `runtimeContextCode`. Add `sourceFile: ts.id("__sourceFile")` to `createProps`. Put a one-line comment on the `join` call that says why it is not `resolve`.

`path` in the generated module is the runtime's `path` export, which every module already imports (`imports.mustache`, `path, os`). In the browser bundle it is the portable `#path` module (`lib/runtime/agencyGlobals.browser.ts`). Use `join`. Do not use `resolve`, for the reason in Global Constraints. On Node, `__dirname` is absolute, so `join` gives the same absolute path `resolve` would. In a browser the result is a string nothing reads.

- [ ] **Step 3: Stop `compileSource` passing a made-up output path**

In `compile.ts`, delete `outputPath` and pass `undefined` to `generateTypeScript` in its place. The builder read it only behind `fromFile`, so the only change in the generated code is the `null` source file. Reword the doc comment on the builder's `outputFile` parameter to say "the file the generated code is written to and loaded from".

- [ ] **Step 4: Regenerate the fixtures and run everything that compiles code**

Run `make fixtures`. Then run `pnpm test:run lib/backends/ lib/compiler/ > /tmp/adi253-t2.log 2>&1`. The new tests pass, and so do the two fixture tests, `lib/backends/typescriptGenerator.integration.test.ts` and `lib/backends/typescriptBuilder.integration.test.ts`, against the regenerated fixtures. The fixture script passes no output file, so every fixture has `const __sourceFile = null;`. Check one fixture's diff by eye: that line, plus `sourceFile: __sourceFile` on each create call, and nothing else.

Then confirm a real compile records a real path. Compile `tests/agency/workflow/fixtures/tools/notes.agency` with `node dist/scripts/agency.js compile` after `make`, and grep the `.js` beside it for `__sourceFile`. It reads `path.join(__dirname, "notes.agency")`. The `.js` is gitignored. The CI job `browser`, which loads compiled modules in a headless browser, is what catches a prelude line that reads `process`.

- [ ] **Step 5: Typecheck, lint, commit**

`pnpm run typecheck` and `pnpm run lint:structure`. Commit the template, the generated template module, `typescriptBuilder.ts`, `compile.ts`, the two test files, and the regenerated fixtures: `Compiled modules record the source file of each def`.

---

### Task 3: `toolRefs` reads the source file

**Files:**
- Modify: `lib/stdlib/workflow/tools.ts` (`localModule`, the file's header comment, and the `toolRefs` doc comment)
- Test: `lib/stdlib/workflow/tools.test.ts`

**Interfaces:**
- Consumes: `AgencyFunction.sourceFile` from Task 1.
- Produces: no new names. `toolRefs(tools, dir, cwd)` keeps its signature. `cwd` is now used only to read a relative `dir`.

- [ ] **Step 1: Update the helper and write the failing tests**

The test helper `fn(name, module)` gains a third argument, `sourceFile: string | null = \`${CWD}/${module}\``, and passes it to `AgencyFunction.create`. With that default, the existing tests keep their meaning: each tool was compiled from `CWD`, and the tests run from `CWD`.

Change the expectation of "refuses a local file outside dir" to name the source file: `tool "a" is defined in "/work/other/a.agency", outside the workflow directory`.

Add:

```ts
it("finds a local tool by its source file when the working directory has changed", () => {
  const notes = fn("searchNotes", "agent/notes.agency", "/work/agent/notes.agency");
  expect(toolRefs([notes], DIR, "/somewhere/else").refs).toEqual([
    { module: "./notes.agency", name: "searchNotes" },
  ]);
});

it("reads a relative dir against the working directory it is given", () => {
  const notes = fn("searchNotes", "agent/notes.agency", "/work/agent/notes.agency");
  expect(toolRefs([notes], "..", "/work/agent/sub").refs).toEqual([
    { module: "./notes.agency", name: "searchNotes" },
  ]);
});

it("refuses a local tool that does not record its source file", () => {
  expect(toolRefs([fn("a", "agent/a.agency", null)], DIR, CWD).problems).toEqual([
    problem('tool "a" does not record the file it was defined in, so a workflow cannot import it'),
  ]);
});
```

Run the file. All three new tests fail, and so does the changed expectation. The second fails as well, because the old code resolves the module id against `/work/agent/sub`.

- [ ] **Step 2: Implement**

In `localModule`, refuse a tool whose `sourceFile` is null, using the message above. Otherwise compute the path from `path.resolve(cwd, dir)` to `tool.sourceFile`. Keep the rest as it is: the "outside" test, the `./` prefix, and the `MODULE_PATH` check in `moduleText`. Rewrite the file's header comment, which describes the old resolution. The comment says that a function value carries its module id and its source file, that the id decides `std::` and `pkg::`, and that the source file decides a local tool's import path. The doc comment on `toolRefs` lists the four kinds of function value with no source file, from call 2, and says that the first is fixed by recompiling its module.

- [ ] **Step 3: Run the workflow tests and commit**

Run `pnpm test:run lib/stdlib/workflow/`. Then run the workflow Agency tests that pass local tools: `pnpm run agency test tests/agency/workflow/check.test.json` and `runMealPlan.test.json`. They compile their tools fresh, so the tools carry a source file. All pass. Typecheck, prettier, and commit: `std::workflow: import a local tool from its source file`.

---

### Task 4: The end-to-end test

**Files:**
- Create: `tests/agency-js/workflow-tool-from-another-cwd/agent.agency`, `tools/shout.agency`, `test.js`, and `fixture.json`

- [ ] **Step 1: Write the test**

`tools/shout.agency`:

```
/** Shout some text. */
export def shout(text: string): string {
  return text.toUpperCase()
}
```

`agent.agency`:

```
// The runner compiles this file from the package root and runs test.js
// from this folder, so the compile directory and the run directory differ.
// The workflow must still import ./tools/shout.agency.
import { runWorkflow, Workflow } from "std::workflow"
import { shout } from "./tools/shout.agency"

export node main(): any {
  const workflow: Workflow = {
    format: 1,
    name: "loud",
    description: "Shout the input.",
    inputs: "{ text: string }",
    steps: [
      {
        id: "s",
        kind: "tool",
        module: "./tools/shout.agency",
        tool: "shout",
        args: { text: { "$ref": "inputs.text" } }
      }
    ]
  }
  return runWorkflow(workflow, { text: "hi" }, [shout], __dirname) with approve
}
```

`test.js`:

```js
import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
writeFileSync("__result.json", JSON.stringify({ finalData: result.data }, null, 2));
```

`fixture.json`:

```json
{ "finalData": { "__type": "resultType", "success": true, "value": "HI" } }
```

`runWorkflow` starts a subprocess, so this test is slower than most agency-js tests. One such test is fine.

- [ ] **Step 2: Watch it fail without the fix, then pass with it**

The same files, run as a probe before this plan was written, failed with the doubled-path `ENOENT`. To see that here, run the test on a checkout without Task 3. With all tasks in place, run it from the package root. It passes.

- [ ] **Step 3: Commit**

Commit the four files: `test: a workflow finds its tool when run from another directory`.

---

### Task 5: Docs

**Files:**
- Modify: `docs/dev/stdlib/workflow.md`, the first paragraph of "Tool modules"
- Modify: `docs/dev/language/agency-function.md`, a new bullet under "What it is"
- Modify: `docs/dev/runtime/checkpointing.md`, one sentence in "Function values in a checkpoint"
- Modify: `docs/dev/runtime/checkpoint-code-fingerprints.md`, one item under "Limitations"
- Modify: `docs/superpowers/specs/2026-10-26-workflows-design.md`, "Tools and modules"

- [ ] **Step 1: Write the changes**

State the mechanism and the rules only:

- **`workflow.md`:** a local tool's import path comes from its source file, relative to `dir`. A tool with no source file is refused, and the paragraph names the four kinds of function value that have none. Remove the sentence that describes the wrong-directory problem.
- **`agency-function.md`:** a "Source file" bullet. Say what `sourceFile` holds and how the compiled module computes it from `__dirname` and the path the compiler recorded. Say why the compiler records a relative path and not an absolute one. Say which function values have none: blocks, builtins, tools built by `createTool`, code compiled for a subprocess, functions from a module compiled before this change, and the stub `revive` builds for a function whose module the process never loaded. Add one clause on Windows: a Windows build machine writes the recorded path with backslashes, Node's `path.join` reads them, and in the browser nothing reads the value.
- **`checkpointing.md`:** one sentence. A checkpoint does not write `sourceFile`, and a revived function value takes it from the module the resuming process loaded.
- **`checkpoint-code-fingerprints.md`:** one item under "Limitations", beside the one about the working directory. A module's hash covers its generated code, and the `__sourceFile` line is part of that code. So moving a module's output relative to its source, such as switching between a build beside the source and an `outDir` build, changes the hash, and a run paused before the move refuses to resume after it.
- **The spec:** in "Tools and modules", replace "for a local file rewrites the path relative to `dir`" with the source-file rule.

- [ ] **Step 2: Commit**

`docs: a function value's source file`.

---

### Task 6: PR

- [ ] **Step 1: Check the diff against `docs/dev/contributing/anti-patterns.md`.** Watch for logic in the builder that belongs in the runtime, and for a second place that turns a module id into a path.
- [ ] **Step 2: Reread every comment and doc line you added.** Cut implementation notes and history.
- [ ] **Step 3: Push and open the PR**, with its body written to a file. Title: `std::workflow: find a tool's file wherever the host runs from (ADI-253)`. The body covers the bug as reproduced in this plan, the fix, the three designs set aside, the seven calls above, and the fixture churn: every generated-code fixture gains two lines, and nothing else in them changes. It says that the refusal for a tool outside the workflow directory now carries an absolute path, which can reach a model (call 6), and that the output layout now moves a module's code fingerprint (Task 5).
- [ ] **Step 4: Link the PR on ADI-253.** The owner merges.

## Self-review notes

- The ticket's test, "a tool compiled in one directory, with the workflow checked and run from another, imports the right file", is Task 4. It checks and runs, because `runWorkflow` checks before it runs.
- The ticket's question, whether a function value can carry the path or the registry can recover it, is answered in the background: the registry cannot, and the function value can.
- Type consistency: `sourceFile` is `string | null` on the function value. The builder takes the source path from `compilationUnit.fromFile` and needs no new parameter, so the only new name the codegen tasks share is `__sourceFile`.
- This plan and ADI-252 both change `lib/runtime/agencyFunction.ts`: ADI-252 its import on line 4, this plan its options and fields. They also change different sections of `docs/dev/stdlib/workflow.md`. Either merge order works, and the second to merge takes a one-line conflict at most.
