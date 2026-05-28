# Expose compiled-module dirname to Agency code, rewire `read` and `readSkill`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let Agency programs build paths relative to the directory of the compiled `.js` file (which, by convention, is the directory of the source `.agency` file). Specifically:

1. Add an Agency-callable accessor for the compiled-module dirname: `std::system::dirname()`.
2. Change `read` / `write` / `readImage` / `edit` / `multiedit` so a relative `dir` argument resolves against the module dirname instead of `process.cwd()`. This is the behavior people actually want when they ship a co-located resource bundle (the canonical example: `lib/agents/policy/prompts/system.md`).
3. Remove the implicit `readSkill` wrapper currently emitted into every compiled module from `imports.mustache`, and move it to a new `stdlib/skills.agency` module. It no longer needs to be implicit because (1) gives us a generic mechanism for any path-dependent stdlib helper.

**Out of scope (deferred):** auditing fs/process helpers that take whole paths (`mkdir`, `copy`, `move`, `remove`, `applyPatch`, `shell::exec`, etc.) for traversal containment. That work is in `2026-05-28-fs-path-traversal-audit.md`.

**Non-goal:** changing how *absolute* `dir` arguments resolve. `read("foo", "/etc")` keeps current semantics.

**Architecture (one-paragraph summary):** Today every compiled Agency module already has `__dirname` (via `fileURLToPath(import.meta.url)`) thanks to `imports.mustache`. The mechanism we lack is propagating that value into the ALS-based `AgencyStore` frame so stdlib TS helpers (which run in the runtime, not the module) can read it. We add a new optional `moduleDir: string` field to `AgencyStore`, seed it from generated code at every entry point into the runtime (top-level run, bootstrap frame, etc.), and have `resolvePath()` and the new `_dirname()` / `_readSkillRaw` helpers read it via `getRuntimeContext()`. Re-entry points inside the runtime (`Runner.runInScope`, `runBatch`'s branch frame) already copy `{ ...store }` so they inherit `moduleDir` for free.

**Tech stack:** Existing typescript codebase + ALS infrastructure in `lib/runtime/asyncContext.ts`. Codegen is the mustache template at `lib/templates/backends/typescriptGenerator/imports.mustache`. Stdlib defs live in `stdlib/*.agency`; backing TS helpers live in `lib/stdlib/*.ts`.

**Workflow conventions:** Worktree per PR. Run `make` (not `pnpm build`) because stdlib changes require regenerating templates. Commit/PR messages via file (never inline because of apostrophes). Never force-push or amend.

**Behavior change to call out in the CHANGELOG:** `read("foo.txt", "./data")` and similar previously resolved `./data` against `process.cwd()`. After this PR it resolves against the *module dirname* (the directory of the compiled `.js`). To get the old behavior, pass `dir: cwd()` (importing `cwd` from `std::system`). Document this in the changelog and in the docstring for `read`/`write`/`readImage`/`edit`/`multiedit`.

---

## Task 1: Plumb `moduleDir` through the ALS frame

**Why:** stdlib TS helpers run in the runtime, not the generated module. They can only see the calling module's `__dirname` if it's stashed in the ALS frame.

### Steps

- [ ] **Step 1.1: Add `moduleDir?: string` to `AgencyStore`**

Edit [lib/runtime/asyncContext.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/runtime/asyncContext.ts). Add an optional field:

```ts
export type AgencyStore = {
  ctx: RuntimeContext<any>;
  stack: StateStack;
  threads: ThreadStore;
  callsite?: CallsiteLocation;
  runner?: Runner;
  /**
   * Absolute path of the directory containing the *compiled* JS module
   * that initiated this Agency run. Seeded by generated code at every
   * entry point (`runNode`, `runInBootstrapFrame`). Inherited by every
   * inner ALS frame because they all spread `{ ...store }`. Read by
   * stdlib helpers that need to resolve paths relative to the module
   * (e.g. `resolvePath`, `_readSkillRaw`, `_dirname`).
   *
   * Optional because there is no sensible default when no frame is
   * active (tests that call helpers directly, or bootstrap paths that
   * never went through the generated entry). Helpers must fall back
   * to `process.cwd()` and document that fallback.
   */
  moduleDir?: string;
};
```

- [ ] **Step 1.2: Add an accessor**

Append to `asyncContext.ts`:

```ts
/**
 * Read the module directory from the current ALS frame. Returns
 * `process.cwd()` as a fallback when no frame is active or no module
 * directory was seeded. Callers that need strictness should use
 * `getRuntimeContext().moduleDir` directly.
 */
export function getModuleDir(): string {
  return agencyStore.getStore()?.moduleDir ?? process.cwd();
}
```

(`import process from "node:process"` if not already imported.)

- [ ] **Step 1.3: Thread `moduleDir` through `runNode`**

Locate `runNode` in `lib/runtime/node.ts`. Find the `agencyStore.run(...)` call that wraps the user's graph. Add a `moduleDir?: string` field to whatever options bag it takes, and include it in the frame:

```ts
agencyStore.run({ ctx, stack, threads, moduleDir }, () => { ... });
```

If `runNode` takes positional args today, add `moduleDir` as a named field on its options. Update every internal caller; external callers (in generated code) get updated in Task 2.

- [ ] **Step 1.4: Thread `moduleDir` through `runInBootstrapFrame`**

Find `runInBootstrapFrame` (same file region as `agencyStore.run` invocations). Same change: accept an optional `moduleDir`, put it in the frame.

- [ ] **Step 1.5: Verify `Runner.runInScope` and `runBatch`'s branch frame inherit it**

These re-enter the ALS frame with `{ ...store, ... }`. Grep for `agencyStore.run` in `lib/runtime/runner.ts` and `lib/runtime/runBatch.ts`. Confirm each call spreads the existing store; if any constructs a frame from scratch, add `moduleDir: parent?.moduleDir` explicitly. Document any exception in the JSDoc next to `AgencyStore.moduleDir`.

- [ ] **Step 1.6: Unit test the ALS plumbing**

Add a vitest in `lib/runtime/asyncContext.test.ts` (create if missing):

```ts
import { agencyStore, getModuleDir } from "./asyncContext.js";
import { describe, it, expect } from "vitest";

describe("getModuleDir", () => {
  it("returns moduleDir when set", () => {
    agencyStore.run(
      { ctx: {} as any, stack: [] as any, threads: {} as any, moduleDir: "/x" },
      () => expect(getModuleDir()).toBe("/x"),
    );
  });
  it("falls back to process.cwd when not in a frame", () => {
    expect(getModuleDir()).toBe(process.cwd());
  });
  it("inherits moduleDir into nested {...store} frames", () => {
    agencyStore.run(
      { ctx: {} as any, stack: [] as any, threads: {} as any, moduleDir: "/outer" },
      () => {
        const s = agencyStore.getStore()!;
        agencyStore.run({ ...s, callsite: { moduleId: "", scopeName: "", stepPath: "" } }, () => {
          expect(getModuleDir()).toBe("/outer");
        });
      },
    );
  });
});
```

Run `pnpm vitest run lib/runtime/asyncContext.test.ts` and confirm green.

---

## Task 2: Seed `moduleDir` from generated code

**Why:** generated modules are the ones that know their `__dirname`. They must pass it into `runNode` / `runInBootstrapFrame` at every entry point.

### Steps

- [ ] **Step 2.1: Inventory entry points in `imports.mustache`**

```bash
grep -n "runNode\|runInBootstrapFrame\|agencyStore" lib/templates/backends/typescriptGenerator/imports.mustache
```

There are likely two or three call sites: top-level `runNode`, module-init bootstrap frame, and possibly the resume path.

- [ ] **Step 2.2: Pass `__dirname` to every entry**

At each call site, add `moduleDir: __dirname` to the options. Example shape (adapt to the real call signature):

```ts
runNode({ ..., moduleDir: __dirname });
runInBootstrapFrame({ ..., moduleDir: __dirname }, () => { ... });
```

`__dirname` is already in scope (line 34 of [imports.mustache](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/templates/backends/typescriptGenerator/imports.mustache#L33-L35)).

- [ ] **Step 2.3: Recompile templates and rebuild**

```bash
pnpm run templates
make
```

- [ ] **Step 2.4: End-to-end smoke test**

Create a tiny test fixture under `tests/agency/system/dirname/`:

```agency
import { dirname } from "std::system"

node main() {
  let d = dirname()
  return { dir: d }
}
```

Add an execution test that asserts `result.dir` ends with the expected path. Skip this step until Task 3 lands (`dirname()` doesn't exist yet) — come back here.

---

## Task 3: Add `std::system::dirname()`

**Why:** the user-facing escape hatch for any path the stdlib doesn't already wrap.

### Steps

- [ ] **Step 3.1: Add TS helper**

In [lib/stdlib/system.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/stdlib/system.ts), add:

```ts
import { getModuleDir } from "../runtime/asyncContext.js";

export function _dirname(): string {
  return getModuleDir();
}
```

(Co-locate with `_cwd` for symmetry.)

- [ ] **Step 3.2: Add Agency wrapper**

In [stdlib/system.agency](file:///Users/adityabhargava/agency-lang/packages/agency-lang/stdlib/system.agency), import `_dirname` and add:

```agency
export safe def dirname(): string {
  """
  Return the absolute path of the directory containing the *compiled
  JavaScript* of this Agency module. By convention this is the same
  directory as the source `.agency` file. Use this to build paths to
  resources shipped alongside your Agency file (prompts, fixtures, etc.):

      import { dirname } from "std::system"
      import { join } from "std::path"
      const promptDir = join(dirname(), "prompts")
      const prompt = read("system.md", promptDir)
  """
  return _dirname()
}
```

Also add `_dirname` to the imports list at the top of `system.agency`.

- [ ] **Step 3.3: Rebuild**

```bash
make
```

- [ ] **Step 3.4: Now complete Step 2.4** (the fixture test) and confirm green.

---

## Task 4: Resolve `read`/`write`/`readImage`/`edit`/`multiedit` relative to `moduleDir`

**Why:** the primary UX goal — `read("system.md", "./prompts")` should work from any cwd.

### Steps

- [ ] **Step 4.1: Update `resolvePath`**

In [lib/stdlib/resolvePath.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/stdlib/resolvePath.ts), change the `baseDir` resolution from `path.resolve(process.cwd(), dir)` to:

```ts
import { getModuleDir } from "../runtime/asyncContext.js";

// ...
const baseDir = path.resolve(getModuleDir(), dir);
```

Note: `path.resolve` already returns `dir` unchanged when `dir` is absolute, so the absolute-`dir` path is unaffected. Only relative `dir` values change behavior.

- [ ] **Step 4.2: Update tests for `resolvePath`**

[lib/stdlib/resolvePath.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/stdlib/resolvePath.test.ts) currently runs with no ALS frame, so calls fall back to `process.cwd()` — existing tests should still pass. Add at least one new test that wraps the call in `agencyStore.run({...moduleDir: "/some/dir"}, ...)` and asserts the base resolves there.

- [ ] **Step 4.3: Update docstrings**

In [stdlib/index.agency](file:///Users/adityabhargava/agency-lang/packages/agency-lang/stdlib/index.agency) and [stdlib/fs.agency](file:///Users/adityabhargava/agency-lang/packages/agency-lang/stdlib/fs.agency), update the `@param dir` docs for `read`, `write`, `readImage`, `edit`, `multiedit` to read approximately:

> `@param dir` - The directory to resolve the filename against. Relative paths resolve against the directory of the compiled `.js` (i.e. next to the source `.agency` file by default), not the current working directory. Defaults to `"."`. Pass an absolute path or `cwd()` from `std::system` for the old behavior.

- [ ] **Step 4.4: End-to-end test**

Create `tests/agency/stdlib/read-relative-to-module/` with:

```
read-relative-to-module.agency
data/hello.txt
```

```agency
node main() {
  let content = read("hello.txt", "./data")
  return { content: content }
}
```

The test should run from a different cwd (e.g. via `process.chdir` in the harness or by spawning the runner from `/tmp`) and still find `hello.txt`. Verify failure mode also: a missing-file path that escapes the dir still throws the existing `escapes directory` error.

- [ ] **Step 4.5: Add CHANGELOG entry**

In `CHANGELOG.md`, under the next unreleased section, add:

> **BREAKING:** `read`, `write`, `readImage`, `edit`, and `multiedit` now resolve relative `dir` arguments against the directory of the compiled module instead of the current working directory. To restore the old behavior, pass `dir: cwd()` (from `std::system`).

---

## Task 5: Move `readSkill` out of `imports.mustache` into `stdlib/skills.agency`

**Why:** every compiled module today gets a `readSkill` wrapper baked in. It doesn't need to be implicit now that we have a general module-dir mechanism.

### Steps

- [ ] **Step 5.1: Make `_readSkillRaw` ALS-aware**

Find `_readSkillRaw` (likely in `lib/runtime/` or `lib/stdlib/skills.ts`). Change its signature from `({ filepath, dirname })` to `({ filepath })`, and read `getModuleDir()` internally:

```ts
import { getModuleDir } from "../runtime/asyncContext.js";

export function readSkill({ filepath }: { filepath: string }): string {
  const dirname = getModuleDir();
  // ... existing logic using dirname ...
}
```

If the helper currently lives in the runtime barrel re-export, decide whether it should move to `lib/stdlib/skills.ts`. (It probably should, since it's a stdlib function not a runtime primitive.) Update the import in `imports.mustache`'s import block accordingly while you're there — but before deleting the wrapper, finish the move.

- [ ] **Step 5.2: Create `stdlib/skills.agency`**

```agency
import { _readSkill } from "agency-lang/stdlib-lib/skills.js"

export safe def readSkill(filepath: string): string {
  """
  Read a skill file from the skills directory next to this Agency module.
  Resolves `filepath` relative to a `skills/` directory beside the
  compiled `.js`. Use this when shipping co-located skill files.
  """
  return _readSkill(filepath)
}
```

Match the exact shape of the existing `readSkill` (params, return type, validation) — confirm by reading the current TS helper.

- [ ] **Step 5.3: Wire up `stdlib/skills.agency` in `stdlib/index.agency`**

Check the existing `stdlib/index.agency` for how other submodules are re-exported. Either add a re-export there or document that users import directly via `import { readSkill } from "std::skills"`.

- [ ] **Step 5.4: Remove the wrapper from `imports.mustache`**

Delete lines 41–43 (the `readSkill` wrapper) from [imports.mustache](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/templates/backends/typescriptGenerator/imports.mustache#L40-L43). Also remove the now-unused `readSkill as _readSkillRaw, readSkillTool as __readSkillTool, readSkillToolParams as __readSkillToolParams` imports if they're truly unused after this PR (grep generated test fixtures first to be sure — `readSkillTool` may still be referenced elsewhere).

- [ ] **Step 5.5: Recompile templates and rebuild**

```bash
pnpm run templates
make
```

- [ ] **Step 5.6: Update fixtures**

Find all generated fixtures that include the `readSkill` wrapper line and rebuild them:

```bash
make fixtures
```

Inspect the diff to make sure removals are limited to the now-deleted wrapper.

- [ ] **Step 5.7: End-to-end test**

Find any existing Agency test that uses `readSkill`. Update it to `import { readSkill } from "std::skills"` and confirm it still passes. If no existing test, add a minimal one under `tests/agency/stdlib/skills/`.

---

## Task 6: Documentation

- [ ] **Step 6.1: Update `docs/site/guide/`**

Add or extend a page that explains:
- the new `dirname()` accessor with the canonical "co-located prompts" example,
- the breaking behavior change for `read`/`write`/`readImage`/`edit`/`multiedit`,
- the `std::skills` module's new home for `readSkill`.

- [ ] **Step 6.2: Update the policy agent**

Update [lib/agents/policy/agent.agency](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/agents/policy/agent.agency) to drop the hard-coded absolute path:

```agency
systemPrompt = read("system.md", "./prompts") with approve
```

This is the dogfood test: verify the agent still works from any cwd.

---

## Validation checklist (run before opening the PR)

- [ ] `pnpm vitest run lib/runtime/asyncContext.test.ts` green.
- [ ] `pnpm vitest run lib/stdlib/resolvePath.test.ts` green.
- [ ] `make fixtures` produces a clean diff containing only the `readSkill` wrapper removal.
- [ ] Relevant agency execution tests under `tests/agency/stdlib/` pass: at least `read-relative-to-module`, `system/dirname`, and any skill tests touched.
- [ ] Manual smoke test: `cd /tmp && pnpm --dir <repo>/packages/agency-lang run a policy gen` works (i.e. the policy agent finds its prompts).
- [ ] `pnpm run lint:structure` clean.
- [ ] No regressions in `pnpm run agency` on a few sample programs from `examples/`.
