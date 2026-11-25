# Relative module ids in `__readStatic` calls: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the compiler from writing the build machine's absolute paths into generated code, so the compiled code in a published agency-lang package and in a built Perry app no longer contains the builder's home folder.

**Architecture:** One function call changes in the TypeScript builder. The module id passed to `__readStatic` goes through `displayModuleId`, the function that already turns the same absolute ids into relative ones for the init registry calls.

**Tech Stack:** TypeScript, vitest.

**Spec:** GitHub issue #1565, "Compiled code holds the build machine's absolute path for every imported name read as a value". There is no separate spec document.

## Background: how module ids reach generated code today

### What `__readStatic` is

A `static const` in Agency compiles to a module-level variable that starts out holding a special marker value, `__UNINIT_STATIC`. The variable gets its real value when the module's `__initializeStatic` function runs. If some code reads the variable before that, the read would silently get the marker.

To catch that, the compiler wraps every read of an imported name in `__readStatic`. Here is what the compiler writes for a read of `barStatic`, imported from `bar.agency`:

```js
__readStatic(barStatic, "barStatic", "/Users/me/proj/bar.agency")
```

`__readStatic` (in `lib/runtime/staticInit.ts`) returns the value unchanged. If the value is still the marker, it throws an error that names the variable and the module it came from. The third argument is used only in that error message. It has no other effect on what the program does.

The compiler wraps imported functions the same way, because at compile time it doesn't always know whether an imported name is a static or a function. This is why a tool list like `[searchSessions]` also produces a `__readStatic` call.

### The three kinds of module id strings in generated code

Generated code names modules in three places:

1. **The module's own id.** `buildSession.ts:511` computes it as `path.relative(process.cwd(), absoluteInputFile)`, for example `src/agency/sessionSearch.agency`. A read of a static from the same file uses this id.
2. **The init registry calls.** `__registerStaticInit`, `__registerGlobalsInit`, `__registerCallbacksInit`, `__awaitStaticInit` and `__awaitGlobalsInit` all get their module id from the compile closure, which keys modules by absolute path. Before printing, `sectionAssembler.ts` passes each one through `displayModuleId`:

   ```ts
   function displayModuleId(abs: string): string {
     if (!path.isAbsolute(abs)) return abs;
     return path.relative(process.cwd(), abs);
   }
   ```

   So these come out relative too. `docs/dev/compiler/init-topsort.md` explains this under "cwd-relative paths in the registry strings".
3. **The `__readStatic` call for an imported name.** `typescriptBuilder.ts:1183` asks the init plan for the source module's id, with `this.initPlan?.resolveImportedName(literal.value)?.sourceModuleId`. The id it gets back is the closure's absolute path, and the builder prints it as is. This is the only one of the three that skips `displayModuleId`.

So after a build, the same module appears in one file under two names:

```js
__registerStaticInit(".agency-tmp/probe/bar.agency", __initializeStatic);
...
__readStatic(greet, "greet", "/Users/adityabhargava/agency-lang/packages/agency-lang/.agency-tmp/probe/bar.agency")
```

That output comes from compiling a two-file program on main (498d267be). In the agency-lang build output, 30 files under `dist/lib/agents` contain 120 of these calls, and every absolute path in that output comes from this one call site. The compiled stdlib, which sits beside its sources in `stdlib/`, has none.

Some of those 30 files read a value imported from the stdlib. For example, `dist/lib/agents/agency-agent/lib/policy.js:313` prints:

```js
__readStatic(BUILTIN_POLICIES, "BUILTIN_POLICIES", "/Users/.../stdlib/policy.agency")
```

The fix covers that case too, because it goes through the same call site.

### Why the obvious alternatives are worse

- **Make the closure return relative ids.** The closure's absolute ids are the keys that link a module's register call to other modules' await calls while the compiler builds the plan. `InitPlanForModule` in `typescriptGenerator.ts` says this in its comment on `registryModuleId`. Changing the keys risks the init ordering, which every program depends on. The fix only needs to change how one id is printed.
- **Use the import specifier for a `pkg::` import, as the issue suggests.** The registry calls for the same module already use `displayModuleId`. If `__readStatic` uses the same function, one module has one printed name everywhere in the generated code. A second naming scheme would mean the error message names a module differently from the registry.

### What the printed id looks like after the fix

`displayModuleId` makes a path relative to `process.cwd()`, the folder the compiler runs in. That can differ from the folder passed to `agency compile`. For example, `make` runs `agency compile dist/lib/agents/...` from the package root, so the printed ids start with `dist/lib/agents/`.

| Imported module | Printed id |
|---|---|
| A file under the folder the compiler runs in | `src/agency/sessionSearch.agency` |
| A file outside that folder | `../shared/helpers.agency` |
| A `std::` import, such as `std::policy` | `stdlib/policy.agency` inside agency-lang, or `node_modules/agency-lang/stdlib/policy.agency` in a user's project |
| A `pkg::` import of an installed package | `node_modules/agency-lang/dist/lib/...`. The exact path depends on the package manager's layout. |
| A `compileSource` module, whose ids are random names like `agency_abc123` | unchanged, because `displayModuleId` leaves a non-absolute id alone |

For `make` and for a Perry build, the imported modules are inside or near the folder the compiler runs in, so no printed id contains the builder's home folder. A program compiled from `/tmp/x` that imports `/Users/me/proj/bar.agency` would print `../../Users/me/proj/bar.agency`. This plan doesn't handle that case.

## Global constraints

- Change only how the id is printed in the `__readStatic` call. Do not change `resolveImportedName`, `registryModuleId`, or the await module ids.
- Delete test folders with `safeDeleteDirectoryWithin` from `lib/utils.ts`, not `fs.rmSync`.
- Run `pnpm run fmt:ts` on the TypeScript files you change. CI fails on unformatted files.
- Do not release. The owner batches this into the next release with PR #1568.

## Review focus

1. **A `static const` read from another module's static initializer.** This is the case the existing test in `lib/runtime/staticInit.crossModule.test.ts` covers. The new test covers it for the printed id, and the existing test makes sure the program still runs.
2. **An imported function used as a value.** The issue's Perry example is a tool list. The new test checks this case.
3. **A file compiled with no compile closure.** The builder then prints `""`, and `__readStatic` shows `<unknown module>`. The fix must keep printing `""` here. `displayModuleId("")` returns `""` because an empty string is not an absolute path.
4. **The trap message still names a module.** `lib/runtime/topsortCycleErrors.test.ts` runs the `runtime-trap` fixture. It must still pass.
5. **The published output.** After `make`, no compiled file in `dist/lib` or `stdlib` should contain the builder's home folder. Task 2 checks this.

### Saved sessions after the release

A checkpoint stores a hash of the generated code of each module it is paused inside, and resuming is refused when that code changed (`docs/dev/runtime/checkpoint-code-fingerprints.md`). This fix changes the generated code of the 30 agent modules above:

1. A terminal session waiting for the user's next message is paused in `core.agency`, which this fix doesn't change. It still resumes.
2. A session saved while it waited on an approval in the middle of a turn has frames in `turn.agency`. It won't resume after the release.
3. A served agent's paused run inside one of its own modules that reads an imported name won't resume after a redeploy.

The fingerprint doc already lists this as a limit of any upgrade, and PR #1568 changes several of the same modules in this release. The plan doesn't work around it. The PR description says it in one sentence, so the release notes can.

---

### Task 1: Print the source module of an imported read with `displayModuleId`

**Files:**
- Modify: `lib/backends/typescriptBuilder/sectionAssembler.ts:18` (export `displayModuleId`)
- Modify: `lib/backends/typescriptBuilder.ts:1183-1189` (use it)
- Modify: `docs/dev/compiler/init-topsort.md:378-386` and `:538-540`
- Test: `lib/runtime/staticInit.crossModule.test.ts`

**Interfaces:**
- Produces: `export function displayModuleId(abs: string): string` from `sectionAssembler.ts`, with its body unchanged.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block at the end of `lib/runtime/staticInit.crossModule.test.ts`. Give it its own folder, `.agency-tmp/static-read-ids/`, so it can't collide with the other blocks' fixtures. Its `beforeAll` does the same four things as the first block's:

```ts
beforeAll(() => {
  fs.mkdirSync(fixturesRoot, { recursive: true });
  fs.writeFileSync(barAgency, /* bar.agency below */);
  fs.writeFileSync(mainAgency, /* main.agency below */);
  resetCompilationCache();
  compile({}, mainAgency);
});
```

The two source files:

```
// bar.agency
export static const barStatic = "hello"

export def greet(): string {
  return "hi"
}
```

```
// main.agency
import { barStatic, greet } from "./bar.agency"

node main() {
  const tools = [greet]
  return "${barStatic} ${tools.length}"
}
```

The test reads the compiled `main.js` as text and checks it:

```ts
it("names the imported module by a path relative to the folder the compiler runs in", () => {
  const compiled = fs.readFileSync(mainJs, "utf8");
  const barId = path.relative(process.cwd(), barAgency);
  expect(compiled).toContain(`__readStatic(barStatic, "barStatic", "${barId}")`);
  expect(compiled).toContain(`__readStatic(greet, "greet", "${barId}")`);
  expect(compiled).not.toContain(fixturesRoot);
});
```

Vitest runs with the package root as its folder, so `barId` is `.agency-tmp/static-read-ids/bar.agency`. All three assertions fail today, because the compiled code prints the absolute path of `bar.agency`.

In `afterAll`, delete the folder with `safeDeleteDirectoryWithin(packageRoot, fixturesRoot)`, where `packageRoot` is `path.resolve(__dirname, "../..")`. Add `import { safeDeleteDirectoryWithin } from "@/utils.js";` to the file.

- [ ] **Step 2: Run the test and see it fail**

```bash
pnpm exec vitest run lib/runtime/staticInit.crossModule.test.ts > /tmp/static-read-ids-red.log 2>&1
```

Expected: the new test fails at its first `toContain`, and the diff shows the absolute path. Vitest stops at the first failed assertion, so the other two don't run. The two existing tests in the file pass.

- [ ] **Step 3: Export `displayModuleId` and use it**

In `sectionAssembler.ts`, add `export` to `displayModuleId`. Leave the body as it is. Its comment says it exists for the registry-key strings. Add one sentence saying it also prints the module named in a `__readStatic` call, and that this id is used only in an error message.

In `typescriptBuilder.ts`, wrap the id the builder prints:

```ts
const sourceModuleId =
  this.initPlan?.resolveImportedName(literal.value)?.sourceModuleId ?? "";
return ts.call(ts.id("__readStatic"), [
  ts.id(literal.value),
  ts.str(literal.value),
  ts.str(displayModuleId(sourceModuleId)),
]);
```

Add `displayModuleId` to the existing import from `./typescriptBuilder/sectionAssembler.js` at line 172. Update the comment above this code so it says the id is printed relative to the folder the compiler runs in, like the registry ids.

- [ ] **Step 4: Run the tests and see them pass**

```bash
pnpm exec vitest run lib/runtime/staticInit.crossModule.test.ts lib/runtime/topsortCycleErrors.test.ts lib/runtime/initPlanWorkedExamples.test.ts > /tmp/static-read-ids-green.log 2>&1
```

Expected: every test passes. The second and third files cover the trap message and the init plans.

- [ ] **Step 5: Update the init doc**

In `docs/dev/compiler/init-topsort.md`:

1. Under "cwd-relative paths in the registry strings", say that `__readStatic`'s module argument goes through `displayModuleId` too, so a module has the same printed name in every call. Add this sentence: "Generated code prints every module path relative to the folder the compiler runs in."
2. Under "Read-before-init trap", change `__readStatic(value, name, sourceModuleId)` so the reader knows the third argument is the source module's id as `displayModuleId` prints it.

- [ ] **Step 6: Format, typecheck, and lint**

```bash
pnpm exec prettier --write lib/backends/typescriptBuilder.ts lib/backends/typescriptBuilder/sectionAssembler.ts lib/runtime/staticInit.crossModule.test.ts
pnpm run typecheck > /tmp/static-read-ids-typecheck.log 2>&1
pnpm run lint:structure > /tmp/static-read-ids-lint.log 2>&1
```

Expected: both commands exit 0. Format only these named files. Running `pnpm run fmt:ts` from the main checkout formats every worktree.

- [ ] **Step 7: Commit**

Write the message to a file, then run `git commit -F <file>`. The subject is "Compiled code names an imported module by a relative path, not the build machine's". The body cites issue #1565.

### Task 2: Check the built agent and stdlib

**Files:** none changed. This task checks the output of Task 1.

**Interfaces:**
- Consumes: the builder change from Task 1.

- [ ] **Step 1: Rebuild everything**

```bash
make > /tmp/static-read-ids-make.log 2>&1
```

Expected: exit 0. `make` compiles the stdlib and the agent, which `pnpm run build` skips.

- [ ] **Step 2: Search the output for the home folder**

```bash
grep -rl "$HOME" dist/lib stdlib --include=*.js | wc -l
```

Expected: `0`. On main this prints `30`, the same 30 agent files. This checks the goal directly, so it would also catch an absolute path printed by some other call site. The stdlib is in `stdlib/`, because it compiles to `.js` files beside its sources. There is no `dist/stdlib`.

- [ ] **Step 3: Check that the agent still starts**

```bash
HOME=<scratch folder> node ./dist/scripts/agency.js agent --help > /tmp/static-read-ids-agent.log 2>&1
```

Expected: exit 0 with the help text. Use a scratch `HOME` so the run can't touch the real agent home.

- [ ] **Step 4: Open the PR**

Push the branch and open a PR against main. Write the description to a file and pass it with `gh pr create --body-file <file>`. Put these in the description:

- the before and after `__readStatic` lines;
- the count from Step 2;
- one sentence from "Saved sessions after the release": a session saved while waiting on an approval in the middle of a turn won't resume after the upgrade, and one waiting for the user's next message will;
- that the fix needs a release, which is batched with #1568.

## After this ships

Perry can drop its two workarounds: its copy of one constant, and the function in each tool's file that returns the tool. That is a Perry change after the release, and this plan doesn't cover it.

One published file outside the compiled code still holds the home folder. `docs/site/agent/index.md:83` shows real agent output with `/Users/adityabhargava/.agency-agent/policy.json`. The makefile copies `docs/site/agent` to `stdlib/docs/agent`, and the package publishes `./stdlib/docs/**/*.md`. It is a hand-written user doc, so this plan leaves it for the owner. Replacing the path with `~/.agency-agent/policy.json` would fix it.
