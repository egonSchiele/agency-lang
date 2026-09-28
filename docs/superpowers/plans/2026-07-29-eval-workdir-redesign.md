# Eval Workdir Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Plan v2** — incorporates every finding from the sibling `-REVIEW` file: the TS-interop closure gap (significant 1), the unlisted `baseOptimizer.workdir.test.ts` (2), the git-suite-root `inputs.json` shape (3), highest-plus-one verifier numbering (4), the recorded `Workspace.run` deviation (5), the `_gitRun` non-reuse rationale (6), verifier mkdir placement (7), the provenance-key caveat (8), and the full anti-pattern addendum (A1–A11).

**Goal:** Seed eval workdirs from declared test files plus the agent's computed closure (`.agency` imports **and** their local TypeScript/JS dependencies) instead of cloning the user's whole project; let suites and fixtures come from git URLs with sha provenance; reorganize the run directory into `agent/` (evidence, per input) and `verifier/` (opinion, at the run root).

**Architecture:** A `Workspace` class in the eval layer owns seed → compile → run for one input. Seeding unions the contents of a test's `files` directory (workdir root) with the agent closure (project-relative paths); collisions are hard errors. The `.agency` half of the closure comes from the existing `visitFile` walk; the TS half expands each non-agency local import through `esbuild.buildSync` metafiles. A *source* string (`local path | git URL`, optional `//subdir`, `?ref=`) resolves through a clone cache, always reporting the resolved sha. No git tracking of workdirs (cut in spec v2).

**Tech Stack:** TypeScript, Node (≥ 20.12 — `Dirent.parentPath` is used; CI is on 22.x/23.x), vitest, esbuild (already a dependency), git via `child_process.execFileSync` (sources resolver only), commander.

**Spec:** `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-29-eval-workdir-redesign-design.md` (v2, already updated with: TS-deps closure, `verifier/` at the run root, `Workspace.run(runner, …)`, and the single-`inputs.json` directory rule — the plan implements the spec as it now stands).

## Global Constraints

- **Work on a branch.** Never commit to `main`. Create `adit/eval-workdirs` from up-to-date `main` before Task 1. Re-check the branch before every commit.
- **Write commit messages to a file** (`/tmp/commitmsg.txt`) and commit with `git commit -F /tmp/commitmsg.txt` — apostrophes on the command line break the shell.
- **Save test output to a file, then grep it.** `npx vitest run <paths> > /tmp/t<N>.txt 2>&1` then `grep -E "FAIL|Tests " /tmp/t<N>.txt | grep -v worktree`. Never re-run a suite just to rediscover failures.
- **Scope test runs to the files you changed.** CI runs the full suite; do not run whole-package suites locally.
- **This checkout has stale `worktree-*` directories** vitest picks up. Ignore any failure whose path contains `worktree-`.
- **Do not run `make`.** Nothing in this plan changes stdlib `.agency` files, `lib/agents/**`, or templates.
- Run `pnpm run typecheck` and `pnpm run lint:structure` before each commit.
- Follow `docs/dev/coding-standards.md` and `docs/dev/anti-patterns.md`. In particular, for this plan: no `...(cond ? { x } : {})` conditional spreads (optional properties accept `undefined` directly — `exactOptionalPropertyTypes` is off); no declare-then-assign where a value can be derived; no bare `catch {}` that swallows an error silently; named constants for magic numbers; no single-character identifiers, including in tests.
- **No network in tests.** Every git-source test uses local repositories created by the test.
- **Out of scope, do not touch:** git tracking of workdirs, workdir deletion/pruning, setup scripts, glob forms of `files`, `std::agency run()`, `agency eval judge` internals, GEPA internals.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/agency-lang/lib/eval/sources.ts` | Parse + resolve source strings to `{ dir, sha? }` via a clone cache. Owns the eval layer's only git invoker. |
| `packages/agency-lang/lib/eval/sources.test.ts` | Parser + resolver tests against local fixture repos. |
| `packages/agency-lang/lib/eval/testUtils.ts` | Shared test fixtures: `makeRepo` (a local git repo with known shas). Convention precedent: `lib/optimize/testUtils.ts`, `lib/typeChecker/testUtils.ts`. |
| `packages/agency-lang/lib/eval/workspace.ts` | The `Workspace` class: seed (closure + config files + test files + overlay, collision check) → compile → run. Replaces `runWorkdir.ts`. |
| `packages/agency-lang/lib/eval/workspace.test.ts` | Seeding, collision, overlay, size-guard tests. |
| `packages/agency-lang/lib/analysis/closure.ts` | The agent-closure walk (`.agency` + TS interop), moved out of the optimizer so eval does not import upward. Home precedent: the shared effects walk lives in `lib/analysis/effects.ts`. |
| `packages/agency-lang/lib/analysis/closure.test.ts` | Closure tests (agency-only, TS interop, externals). |
| `packages/agency-lang/lib/utils/hash.ts` | `sha256Text`, moved from `lib/optimize/targets.ts` — eval provenance and the optimizer both hash file contents, and a hash function belongs to neither. |

**Modified:**

| File | Change |
|---|---|
| `packages/agency-lang/lib/optimize/workspace.ts` | `type Workspace` → `type CachePartition`; `sha256Text` import moves to `@/utils/hash.js`. |
| `packages/agency-lang/lib/optimize/targets.ts` | Walk + `defaultBaseDir` + `agentClosureBaseDir` move OUT to `lib/analysis/closure.ts`; `discoverOptimizeTargets` consumes them from there; `sha256Text` re-homed (also touches `sourceMutator.ts`). |
| `packages/agency-lang/lib/importPaths.ts` | `nonAgencyLocalImportTargets(program)` — the inverse filter of `agencyImportTargets`. |
| `packages/agency-lang/lib/eval/runTypes.ts` | `Input.files?: string`; deprecation note on `working_dir`. |
| `packages/agency-lang/lib/eval/loadInputs.ts` | `files` field; test-directory form; wrapper-file rule; disambiguation; git-source nesting rule. |
| `packages/agency-lang/lib/eval/runEvalInput.ts` | Consume `Workspace`; seeded-file listing on run failure. |
| `packages/agency-lang/lib/eval/runArtifacts.ts` | Per-input paths under `agent/`; provenance in config.json. |
| `packages/agency-lang/lib/eval/readRun.ts` | Dual-layout fallbacks. |
| `packages/agency-lang/lib/cli/eval/run.ts` | `RunSeed` union; `--inputs` sources; provenance threading; inline grading writes `verifier/grading.json`; `working_dir` deprecation warning. |
| `packages/agency-lang/lib/cli/eval/grade.ts` | Default output = next `verifier-N/grading.json` (highest + 1). |
| `packages/agency-lang/lib/optimize/baseOptimizer.ts` | Seed carries the closure list; `CachePartition` fallout. |
| `packages/agency-lang/lib/optimize/baseOptimizer.workdir.test.ts` | Seed-shape assertion updated to `RunSeed` (review finding 2). |
| `packages/agency-lang/lib/optimize/testUtils.ts` | `fakeRun` fabricates the `agent/` layout. |
| `packages/agency-lang/lib/eval/runWorkdir.ts` + `runWorkdir.test.ts` | **Deleted** (both exist; `workspace.ts`/`workspace.test.ts` supersede them). |
| `packages/agency-lang/lib/cli/eval/run.workdir.test.ts` | **Verify unchanged** — its three tests (two `working_dir` validation errors, one compiled-entry-inside-workdir) must pass as-is; the legacy clone path preserves all three behaviors. Named here so nobody assumes it was missed. |
| `packages/agency-lang/lib/config.ts` | `eval.sourceCacheRoot` (type + zod). |
| `packages/agency-lang/scripts/agency.ts` | `--inputs` help text. |
| `packages/agency-lang/docs/site/cli/eval.md`, `docs/dev/writing-optimizers.md` | User docs. |

Task order: 1 (rename) and 2 (closure API) before 3 (the class needing both); 4–5 (input formats) on 3; 6 (sources) independent; 7 wires 6 into 4–5 with provenance; 8 (layout) last so paths churn once; 9 docs + audit.

---

### Task 1: Rename the optimizer's `Workspace` type to `CachePartition`

The optimizer's `type Workspace = { key: string }` (`lib/optimize/workspace.ts:9`) is a cache-partition token, nothing on disk. Task 3 introduces a real `Workspace` class in the eval layer; this frees the name. Purely mechanical.

**Files:**
- Modify: `packages/agency-lang/lib/optimize/workspace.ts` and every importer of the type (found in Step 1).

**Interfaces:**
- Consumes: nothing.
- Produces: `export type CachePartition = { key: string }`. `WorkspaceManager` keeps its name (`fork(): CachePartition`, `writeBack(...)` unchanged). The optimizer's `RunInput` first parameter becomes `CachePartition`.

- [ ] **Step 1: Create the branch, then find every use**

```bash
cd /Users/adityabhargava/agency-lang && git checkout main && git pull && git checkout -b adit/eval-workdirs
cd packages/agency-lang
grep -rn "Workspace" lib/optimize lib/cli/eval docs/dev/writing-optimizers.md --include='*.ts' --include='*.md' | grep -v "WorkspaceManager" | grep -v worktree
```

Expected hits at minimum: `lib/optimize/workspace.ts` (the type), `lib/optimize/baseOptimizer.ts` (`RunInput`, `fork()`, `evaluate(ws: Workspace, …)`), `lib/optimize/optimizers/gepa.ts` (`ws.key`), optimizer test files, and prose in `docs/dev/writing-optimizers.md`.

- [ ] **Step 2: Rename the type and update every reference**

```ts
/** Per-candidate cache-partition token. `EvalCache` keys runs by
 *  `(key, inputId)`; nothing on-disk lives at the partition itself. */
export type CachePartition = { key: string };
```

Update `WorkspaceManager.fork()`'s return type and every import/annotation from Step 1, including the doc prose. Do not rename `WorkspaceManager` or the `BaseOptimizer.workspace` field — only the type.

- [ ] **Step 3: Typecheck and test**

```bash
pnpm run typecheck && npx vitest run lib/optimize > /tmp/t1.txt 2>&1
grep -E "FAIL|Tests " /tmp/t1.txt | grep -v worktree
```
Expected: clean; all pass (no behavior changed).

- [ ] **Step 4: Lint and commit**

```bash
pnpm run lint:structure
git add -A lib docs
printf 'Rename the optimizer Workspace token to CachePartition\n\nIt is a cache-partition key, not a workspace: nothing on disk lives at it.\nThe rename frees the Workspace name for the eval layer class that owns an\nactual working directory, and is honest about what the token does.\n' > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
```

---

### Task 2: The full agent closure — `.agency` walk plus TS-interop deps, homed in `lib/analysis/`

Two problems, one move. First, `agentClosureBaseDir` (`lib/optimize/targets.ts:93`) walks the `.agency` closure via `visitFile` but discards the file list; seeding needs the list — **and** it needs the TypeScript interop files the walk cannot see: `isAgencyImport` (`lib/importPaths.ts:265`) is true only for `.agency`/`std::`/`pkg::` paths, so `import { greet } from "./greet.js"` (the documented interop form; 52 `.agency` files in this repo use it) never enters the closure. Today those files arrive because the whole project is cloned; after Task 3 they must be seeded deliberately, or TS-interop agents break at run time. Each direct non-agency local import expands to its transitive `.ts`/`.js` file set via esbuild's metafile — esbuild is already a dependency (`lib/eval/grading/gradingModule.ts` uses it), and its resolver handles `./greet.js` → `greet.ts` the same way the runtime does.

Second, **placement**: the walk currently lives in the optimizer, but after this change its main consumer is eval — and `lib/eval` importing from `lib/optimize` is the exact dependency inversion #727 just straightened for grading. "What files does this agent need" is not an optimizer concept. The walk moves to `lib/analysis/closure.ts` (the established home for shared walks — `lib/analysis/effects.ts`), and the optimizer's target discovery becomes a consumer like everyone else. `sha256Text` moves to `lib/utils/hash.ts` for the same reason: eval provenance hashes file contents too, and a hash function belongs to neither layer.

**Files:**
- Create: `packages/agency-lang/lib/analysis/closure.ts`, `packages/agency-lang/lib/analysis/closure.test.ts`, `packages/agency-lang/lib/utils/hash.ts`
- Modify: `packages/agency-lang/lib/importPaths.ts`, `packages/agency-lang/lib/optimize/targets.ts` (walk moves out; imports from the new homes), `packages/agency-lang/lib/optimize/sourceMutator.ts` + `packages/agency-lang/lib/optimize/workspace.ts` (`sha256Text` import path), `packages/agency-lang/lib/cli/eval/run.ts` (`agentClosureBaseDir` import path, if it imports it today)

**Interfaces:**
- Consumes: `visitFile`'s current body (`lib/optimize/targets.ts:181-199` — parse + recurse over `agencyImportTargets(program, { localOnly: true })`), `defaultBaseDir`/`commonAncestor`/`isInsideOrSame` (same file), and `agencyImportTargets`'s node-shape knowledge in `lib/importPaths.ts`.
- Produces:
  - `lib/importPaths.ts`: `export function nonAgencyLocalImportTargets(program: AgencyProgram): string[]` — relative import specifiers (`./…` or `../…`) that are **not** agency imports.
  - `lib/analysis/closure.ts`:
    - `export type ParsedSourceFile = { absoluteFile: string; source: string; program: AgencyProgram }` (moved verbatim from targets.ts)
    - `export function walkAgencyClosure(absoluteEntryFile: string): ParsedSourceFile[]` — the `visitFile` walk, moved verbatim behind a named entry point
    - `export function closureBaseDir(absoluteFiles: string[]): string` — `defaultBaseDir`, moved verbatim (with its two private helpers)
    - `export function agentClosure(entryFile: string): { baseDir: string; files: string[] }` — every `.agency` file in the walk **plus** the transitive local TS/JS deps of each file's non-agency imports; `baseDir` from the `.agency` files only, so adding TS deps cannot shift it
    - `export function agentClosureBaseDir(entryFile: string): string` — `agentClosure(entryFile).baseDir`
  - `lib/utils/hash.ts`: `export function sha256Text(value: string): string` (moved verbatim; the three optimizer importers update their import path; `targets.ts` stops exporting it).
  - `lib/optimize/targets.ts`: `discoverOptimizeTargets` consumes `walkAgencyClosure` + `closureBaseDir` from `@/analysis/closure.js`; its private copies are deleted. Later tasks import `agentClosure` from `@/analysis/closure.js` — never from optimize.

- [ ] **Step 1: Write the failing tests**

Create `lib/analysis/closure.test.ts` (fs/os/path + vitest imports as in the other test files; import `agentClosure`, `agentClosureBaseDir` from `./closure.js`):

```ts
describe("agentClosure", () => {
  function closureProject(): string {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "closure-"));
    fs.mkdirSync(path.join(projectDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "lib", "helper.agency"), "export def helper(): string { return \"hi\" }\n");
    fs.writeFileSync(path.join(projectDir, "agent.agency"), "import { helper } from \"./lib/helper.agency\"\nnode main() {}\n");
    fs.writeFileSync(path.join(projectDir, "unrelated.agency"), "node main() {}\n");
    return projectDir;
  }

  it("returns the entry plus every transitively imported .agency file, and agrees with agentClosureBaseDir", () => {
    const projectDir = closureProject();
    const closure = agentClosure(path.join(projectDir, "agent.agency"));

    const rels = closure.files.map((file) => path.relative(closure.baseDir, file)).sort();
    expect(rels).toEqual(["agent.agency", path.join("lib", "helper.agency")]);
    expect(closure.baseDir).toBe(agentClosureBaseDir(path.join(projectDir, "agent.agency")));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("includes TypeScript interop files, transitively, resolving ./x.js to x.ts", () => {
    const projectDir = closureProject();
    // agent imports ./greet.js (interop form); greet.ts exists and imports ./util.ts
    fs.writeFileSync(path.join(projectDir, "agent.agency"),
      "import { helper } from \"./lib/helper.agency\"\nimport { greet } from \"./greet.js\"\nnode main() {}\n");
    fs.writeFileSync(path.join(projectDir, "greet.ts"),
      "import { upper } from \"./util.js\";\nexport function greet(name: string): string { return upper(name); }\n");
    fs.writeFileSync(path.join(projectDir, "util.ts"),
      "export function upper(value: string): string { return value.toUpperCase(); }\n");

    const closure = agentClosure(path.join(projectDir, "agent.agency"));

    const rels = closure.files.map((file) => path.relative(closure.baseDir, file)).sort();
    expect(rels).toEqual(["agent.agency", "greet.ts", path.join("lib", "helper.agency"), "util.ts"]);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("leaves bare package imports external (no node_modules files in the closure)", () => {
    const projectDir = closureProject();
    fs.writeFileSync(path.join(projectDir, "agent.agency"),
      "import { z } from \"./schema.js\"\nnode main() {}\n");
    fs.writeFileSync(path.join(projectDir, "schema.ts"),
      "import { z } from \"zod\";\nexport { z };\n");

    const closure = agentClosure(path.join(projectDir, "agent.agency"));

    const rels = closure.files.map((file) => path.relative(closure.baseDir, file)).sort();
    expect(rels).toEqual(["agent.agency", "schema.ts"]);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run lib/analysis/closure.test.ts > /tmp/t2.txt 2>&1
grep -E "FAIL|Cannot find" /tmp/t2.txt | grep -v worktree
```
Expected: FAIL — `Cannot find module './closure.js'`.

- [ ] **Step 3: Implement**

First the two verbatim moves: create `lib/utils/hash.ts` holding `sha256Text` (from `targets.ts:63`) and update its three optimizer importers (`targets.ts`, `sourceMutator.ts`, `workspace.ts`); create `lib/analysis/closure.ts` and move `ParsedSourceFile`, the `visitFile` body (exposed as `walkAgencyClosure`), `defaultBaseDir` (exported as `closureBaseDir`), `commonAncestor`, and `isInsideOrSame` from `targets.ts`, leaving `discoverOptimizeTargets` importing them from `@/analysis/closure.js`. Then the new code.

In `lib/importPaths.ts`, next to `agencyImportTargets` (same node-iteration shape, inverse filter):

```ts
/** The module path an import-like node names, or null for everything else. */
function importedModulePath(node: AgencyProgram["nodes"][number]): string | null {
  if (node.type === "importStatement") {
    return node.modulePath;
  }
  if (node.type === "importNodeStatement") {
    return node.agencyFile;
  }
  if (node.type === "exportFromStatement") {
    return node.modulePath;
  }
  return null;
}

/** Relative import specifiers that are NOT agency imports — the local
 *  TypeScript/JavaScript interop files an .agency module depends on. */
export function nonAgencyLocalImportTargets(program: AgencyProgram): string[] {
  return program.nodes
    .map(importedModulePath)
    .filter((modulePath): modulePath is string =>
      modulePath !== null && isLocalImportTarget(modulePath) && !isAgencyImport(modulePath));
}
```

(`agencyImportTargets` in the same file open-codes the same three-way extraction with a `let` — adopting `importedModulePath` there too is an optional one-hunk tidy, same behavior.)

(If `isLocalImportTarget` is not already exported/visible in that scope, it is defined in this file — reuse it, do not re-implement.)

In `lib/analysis/closure.ts`, below the moved walk:

```ts
import { buildSync } from "esbuild";
import { nonAgencyLocalImportTargets } from "@/importPaths.js";

/** The entry file's full local closure: every .agency file the walk reaches,
 *  plus the transitive local TS/JS files their interop imports need. baseDir
 *  is computed from the .agency files only (unchanged from agentClosureBaseDir),
 *  so adding TS deps can never shift it. */
export function agentClosure(entryFile: string): { baseDir: string; files: string[] } {
  const absoluteEntryFile = fs.realpathSync(path.resolve(entryFile));
  const parsedFiles = walkAgencyClosure(absoluteEntryFile);

  const agencyFiles = parsedFiles.map((parsed) => parsed.absoluteFile);
  const interopEntries = parsedFiles.flatMap((parsed) =>
    nonAgencyLocalImportTargets(parsed.program).map((specifier) =>
      resolveInteropEntry(path.dirname(parsed.absoluteFile), specifier)),
  );
  const interopFiles = interopEntries.flatMap((interopEntry) => transitiveTsFiles(interopEntry));

  const allFiles = [...agencyFiles, ...interopFiles].sort();
  const files = allFiles.filter((file, index) => allFiles.indexOf(file) === index);
  return { baseDir: closureBaseDir(agencyFiles), files };
}

/** `./greet.js` on disk may be greet.ts (the guide says to write .js even for
 *  TypeScript sources). Prefer the file that exists; .ts when both do not. */
function resolveInteropEntry(fromDir: string, specifier: string): string {
  const asWritten = path.resolve(fromDir, specifier);
  if (fs.existsSync(asWritten)) return asWritten;
  const asTs = asWritten.replace(/\.js$/, ".ts");
  if (fs.existsSync(asTs)) return asTs;
  return asWritten;   // let esbuild produce the resolution error, which names the importer
}

/** The transitive local file set of one TS/JS entry, from esbuild's metafile.
 *  Bare (package) imports stay external, so only relative files appear. */
function transitiveTsFiles(interopEntry: string): string[] {
  const result = buildSync({
    entryPoints: [interopEntry],
    bundle: true,
    write: false,
    metafile: true,
    packages: "external",
    logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs).map((inputPath) => path.resolve(inputPath));
}

export function agentClosureBaseDir(entryFile: string): string {
  return agentClosure(entryFile).baseDir;
}
```

(`ParsedSourceFile.program` already carries each file's parsed `AgencyProgram` — the walk parses once; do not re-parse.)

(The dedup uses the indexOf-filter idiom from the anti-pattern catalog's own "good" example — no `Set`, per the house rule.)

- [ ] **Step 4: Run, typecheck, lint, commit**

```bash
npx vitest run lib/analysis/closure.test.ts lib/optimize/targets.test.ts lib/optimize > /tmp/t2.txt 2>&1
grep -E "FAIL|Tests " /tmp/t2.txt | grep -v worktree
pnpm run typecheck && pnpm run lint:structure
git add -A lib
printf 'analysis: agentClosure - the full agent file list, TS interop included\n\nThe .agency walk lived in the optimizer and discarded its file list, and\nit cannot see TypeScript interop imports at all (isAgencyImport filters\nthem out). The walk moves to lib/analysis/closure.ts - its main consumer\nis about to be eval, and eval importing from optimize would invert the\nlayering #727 straightened - and each non-agency local import now expands\nthrough an esbuild metafile to its transitive .ts/.js files, so a seeded\nworkdir carries everything the agent actually needs. sha256Text moves to\nlib/utils/hash.ts for the same reason. baseDir still derives from the\n.agency files alone.\n' > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
```

---

### Task 3: The `Workspace` class — closure + test-file seeding replaces the project clone

The core change. `lib/eval/workspace.ts` replaces `lib/eval/runWorkdir.ts`: seeding copies (a) the closure files at baseDir-relative paths, (b) `agency.json` and `.env` from baseDir when present (both are read from cwd at run time and arrived incidentally under the full clone), and (c) the contents of an optional test `filesDir` at the workdir root — erroring on collisions — then applies optimizer `overlayFiles` and compiles in place. A legacy full-clone mode keeps `working_dir` working until removal.

**Files:**
- Create: `packages/agency-lang/lib/eval/workspace.ts`, `packages/agency-lang/lib/eval/workspace.test.ts`
- Delete: `packages/agency-lang/lib/eval/runWorkdir.ts` **and** `packages/agency-lang/lib/eval/runWorkdir.test.ts` (both exist)
- Modify: `packages/agency-lang/lib/eval/runEvalInput.ts`, `packages/agency-lang/lib/cli/eval/run.ts`, `packages/agency-lang/lib/optimize/baseOptimizer.ts`, `packages/agency-lang/lib/optimize/baseOptimizer.workdir.test.ts` (seed-shape assertion — review finding 2)
- Verify unchanged: `packages/agency-lang/lib/cli/eval/run.workdir.test.ts` (three tests; all exercise behavior the legacy clone path preserves)

**Interfaces:**
- Consumes: `agentClosure` from Task 2; `compile` + `RunStrategy` exactly as `prepareRunDir` uses them (`lib/eval/runWorkdir.ts:66-75`); `copyProjectTree` (legacy mode only); `EvalInputRunner` from `runEvalInput.ts`.
- Produces (a discriminated union — `cloneDir` cannot silently coexist with closure fields):

```ts
// lib/eval/workspace.ts
export type SeededSeed = {
  kind: "seeded";
  baseDir: string;              // project root the closure paths are relative to
  agentRelPath: string;         // entry .agency, relative to baseDir
  closureFiles: string[];       // absolute paths (agency + TS interop), from agentClosure
  filesDir?: string;            // resolved test fixture dir; contents land at workdir root
};
export type LegacyCloneSeed = {
  kind: "legacyClone";          // deprecated working_dir: full clone, old behavior
  baseDir: string;
  agentRelPath: string;
  cloneDir: string;
};
export type RunSeed = SeededSeed | LegacyCloneSeed;

export class Workspace {
  readonly workdirPath: string;
  readonly compiledEntryPath: string;
  readonly seededFiles: string[];   // workdir-relative, sorted; for diagnostics
  static create(args: {
    workdirPath: string;
    seed: RunSeed;
    overlayFiles?: Record<string, string>;
    config: AgencyConfig;
  }): Workspace;                    // synchronous; throws on collision/compile failure
  run(runner: EvalInputRunner, args: { node: string; args: Record<string, any>; statelogPath: string }):
    ReturnType<EvalInputRunner>;
}
```

- `run.ts`'s seed type becomes `RunSeed` end to end (`deriveSeedFromAgent`, `resolveInputSeed`, `EvalRunLoadedInputsOptions.seed`, `runEvalInput`). Task 4 relies on `SeededSeed.filesDir`; Task 7 on `closureFiles`.
- `BaseOptimizer.runInputViaEval` seed: `{ kind: "seeded", baseDir: source.baseDir, agentRelPath: source.entryFile, closureFiles: Object.values(source.files).map((sourceFile) => sourceFile.absoluteFile) }`. (The optimizer's closure is `.agency`-only — `OptimizeTargetSet.files` — which preserves its current behavior; optimizer TS-interop seeding can adopt `agentClosure` separately if ever needed.)

- [ ] **Step 1: Write the failing tests**

```ts
// lib/eval/workspace.test.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { Workspace, type SeededSeed } from "./workspace.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
  // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function tmp(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  dirs.push(tempDir);
  return tempDir;
}

/** A project with an entry agent importing one helper, plus junk that must NOT be seeded. */
function makeProject(): { baseDir: string; seed: SeededSeed } {
  const baseDir = tmp();
  fs.mkdirSync(path.join(baseDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(baseDir, "lib", "helper.agency"), "export def helper(): string { return \"hi\" }\n");
  fs.writeFileSync(path.join(baseDir, "agent.agency"), "import { helper } from \"./lib/helper.agency\"\nnode main() {}\n");
  fs.writeFileSync(path.join(baseDir, "junk.bin"), Buffer.alloc(2 * 1024 * 1024));
  const seed: SeededSeed = {
    kind: "seeded",
    baseDir,
    agentRelPath: "agent.agency",
    closureFiles: [path.join(baseDir, "agent.agency"), path.join(baseDir, "lib", "helper.agency")],
  };
  return { baseDir, seed };
}

function totalBytes(dir: string): number {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.statSync(path.join(entry.parentPath, entry.name)).size)
    .reduce((sum, size) => sum + size, 0);
}

describe("Workspace.create", () => {
  it("seeds only the closure, at project-relative paths, and compiles the entry", () => {
    const { seed } = makeProject();
    const workdirPath = path.join(tmp(), "workdir");

    const workspace = Workspace.create({ workdirPath, seed, config: {} });

    expect(fs.existsSync(path.join(workdirPath, "agent.agency"))).toBe(true);
    expect(fs.existsSync(path.join(workdirPath, "lib", "helper.agency"))).toBe(true);
    expect(fs.existsSync(path.join(workdirPath, "junk.bin"))).toBe(false);
    expect(fs.existsSync(workspace.compiledEntryPath)).toBe(true);
    expect(workspace.seededFiles).toEqual(["agent.agency", path.join("lib", "helper.agency")]);
  });

  it("seeds agency.json and .env from baseDir when present", () => {
    const { baseDir, seed } = makeProject();
    fs.writeFileSync(path.join(baseDir, "agency.json"), "{}");
    fs.writeFileSync(path.join(baseDir, ".env"), "KEY=value\n");
    const workdirPath = path.join(tmp(), "workdir");

    Workspace.create({ workdirPath, seed, config: {} });

    expect(fs.existsSync(path.join(workdirPath, "agency.json"))).toBe(true);
    expect(fs.existsSync(path.join(workdirPath, ".env"))).toBe(true);
  });

  it("copies test files to the workdir root alongside the closure", () => {
    const { seed } = makeProject();
    const filesDir = tmp();
    fs.mkdirSync(path.join(filesDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(filesDir, "data", "report.txt"), "q3 numbers");
    const workdirPath = path.join(tmp(), "workdir");

    const workspace = Workspace.create({ workdirPath, seed: { ...seed, filesDir }, config: {} });

    expect(fs.readFileSync(path.join(workdirPath, "data", "report.txt"), "utf8")).toBe("q3 numbers");
    expect(workspace.seededFiles).toContain(path.join("data", "report.txt"));
  });

  it("errors on a test-file/closure collision, naming the path and both sources", () => {
    const { seed } = makeProject();
    const filesDir = tmp();
    fs.mkdirSync(path.join(filesDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(filesDir, "lib", "helper.agency"), "node main() {}\n");
    const workdirPath = path.join(tmp(), "workdir");

    expect(() => Workspace.create({ workdirPath, seed: { ...seed, filesDir }, config: {} }))
      .toThrow(/lib\/helper\.agency.*test files.*agent/s);
  });

  it("applies overlayFiles last, over a closure file, and refuses escapes", () => {
    const { seed } = makeProject();

    const workspace = Workspace.create({
      workdirPath: path.join(tmp(), "workdir"), seed, config: {},
      overlayFiles: { "lib/helper.agency": "export def helper(): string { return \"mutated\" }\n" },
    });
    expect(fs.readFileSync(path.join(workspace.workdirPath, "lib", "helper.agency"), "utf8")).toContain("mutated");

    expect(() => Workspace.create({
      workdirPath: path.join(tmp(), "w2"), seed, config: {},
      overlayFiles: { "../escape.txt": "nope" },
    })).toThrow(/escapes the workdir/);
  });

  it("legacy cloneDir mode copies the directory wholesale (working_dir compatibility)", () => {
    const { baseDir, seed } = makeProject();
    const workdirPath = path.join(tmp(), "workdir");

    Workspace.create({
      workdirPath,
      seed: { kind: "legacyClone", baseDir, agentRelPath: seed.agentRelPath, cloneDir: baseDir },
      config: {},
    });

    expect(fs.existsSync(path.join(workdirPath, "junk.bin"))).toBe(true);
  });

  it("size guard: a seeded workdir stays under 1 MB even in a 2 MB project", () => {
    const { seed } = makeProject();
    const filesDir = tmp();
    fs.writeFileSync(path.join(filesDir, "fixture.txt"), "small");
    const workdirPath = path.join(tmp(), "workdir");

    Workspace.create({ workdirPath, seed: { ...seed, filesDir }, config: {} });

    expect(totalBytes(workdirPath)).toBeLessThan(1024 * 1024);   // the spec's budget
  });
});
```

`Workspace.create` compiles for real (compilation is pure, no LLM), so test agents must be valid Agency. Compiled JS is deliberately inside the 1 MB budget.

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run lib/eval/workspace.test.ts > /tmp/t3.txt 2>&1
grep -E "FAIL|Cannot find" /tmp/t3.txt | grep -v worktree
```
Expected: FAIL — `Cannot find module './workspace.js'`.

- [ ] **Step 3: Write `lib/eval/workspace.ts`**

The body is declarative: plan the seed as a pure map, reject collisions, materialize, overlay, compile. Each helper does one job.

```ts
import * as fs from "fs";
import * as path from "path";

import type { AgencyConfig } from "@/config.js";
import { compile } from "@/cli/commands.js";
import { RunStrategy } from "@/importStrategy.js";
import { copyProjectTree } from "@/utils/projectTree.js";

import type { EvalInputRunner } from "./runEvalInput.js";

export type SeededSeed = {
  kind: "seeded";
  baseDir: string;
  agentRelPath: string;
  closureFiles: string[];
  filesDir?: string;
};
export type LegacyCloneSeed = {
  kind: "legacyClone";
  baseDir: string;
  agentRelPath: string;
  cloneDir: string;
};
export type RunSeed = SeededSeed | LegacyCloneSeed;

/** Project files read from cwd at run time; seeded when the project has them. */
const PROJECT_CONFIG_FILES = ["agency.json", ".env"];

/** One planned seed entry: where the file comes from, and which ingredient
 *  provided it (collision messages name the ingredient). */
type SeedEntry = { sourceAbs: string; origin: "agent" | "test files" };

/** Resolve `rel` against `root`, refusing escapes. Carried over from
 *  runWorkdir.ts unchanged — overlay keys come from optimizer candidates today
 *  but may flow in from less-trusted callers later. */
function resolveWithin(root: string, rel: string): string {
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, rel);
  if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path ${JSON.stringify(rel)} escapes the workdir ${resolvedRoot}`);
  }
  return abs;
}

/** Every file under `dir`, as dir-relative paths, sorted. */
function listFilesRecursive(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

/** The seed as a pure map of workdir-relative path → entry. Throws on a
 *  test-file/agent collision, naming the path and both sources. */
function planSeed(seed: SeededSeed): Record<string, SeedEntry> {
  const agentEntries: Record<string, SeedEntry> = Object.fromEntries([
    ...seed.closureFiles.map((abs): [string, SeedEntry] =>
      [path.relative(seed.baseDir, abs), { sourceAbs: abs, origin: "agent" }]),
    ...PROJECT_CONFIG_FILES
      .filter((name) => fs.existsSync(path.join(seed.baseDir, name)))
      .map((name): [string, SeedEntry] =>
        [name, { sourceAbs: path.join(seed.baseDir, name), origin: "agent" }]),
  ]);
  const testEntries: Record<string, SeedEntry> = Object.fromEntries(
    (seed.filesDir ? listFilesRecursive(seed.filesDir) : []).map((rel): [string, SeedEntry] =>
      [rel, { sourceAbs: path.join(seed.filesDir as string, rel), origin: "test files" }]),
  );

  const collisions = Object.keys(testEntries).filter((rel) => agentEntries[rel] !== undefined);
  if (collisions.length > 0) {
    const rel = collisions[0];
    throw new Error(
      `Seed collision at "${rel}": provided by both the test files (${testEntries[rel].sourceAbs}) ` +
      `and the agent (${agentEntries[rel].sourceAbs}). Tests must not ship agent files — ` +
      `the agent is seeded separately so one suite can grade any agent.`,
    );
  }
  return { ...agentEntries, ...testEntries };
}

/** The only filesystem writes in seeding. */
function materialize(workdirPath: string, entries: Record<string, SeedEntry>): void {
  fs.mkdirSync(workdirPath, { recursive: true });
  for (const [rel, entry] of Object.entries(entries)) {
    const dest = resolveWithin(workdirPath, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(entry.sourceAbs, dest);
  }
}

function applyOverlay(workdirPath: string, overlayFiles: Record<string, string> | undefined): void {
  for (const [rel, source] of Object.entries(overlayFiles ?? {})) {
    const dest = resolveWithin(workdirPath, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, source);
  }
}

/** Deprecated working_dir path: the old full clone, verbatim — including
 *  copyProjectTree's known self-copy-guard quirk under symlinked temp dirs.
 *  Do not "fix" that here; this whole branch dies with working_dir. */
function cloneLegacy(workdirPath: string, seed: LegacyCloneSeed): string[] {
  copyProjectTree(seed.cloneDir, workdirPath);
  return listFilesRecursive(workdirPath);
}

/** The two-ingredient seed: plan (pure, collision-checked), then write. */
function seedFromPlan(workdirPath: string, seed: SeededSeed): string[] {
  const entries = planSeed(seed);
  materialize(workdirPath, entries);
  return Object.keys(entries).sort();
}

function compileEntry(workdirPath: string, agentRelPath: string, config: AgencyConfig): string {
  const entryAgency = resolveWithin(workdirPath, agentRelPath);
  const compiledEntryPath = compile(config, entryAgency, undefined, {
    importStrategy: new RunStrategy(),
    quiet: true,
  });
  if (compiledEntryPath === null) {
    throw new Error(`Failed to compile ${entryAgency}`);
  }
  return compiledEntryPath;
}

/**
 * One isolated run directory: seeded from the test's files plus the agent's
 * closure, compiled in place, executed with cwd = workdir. Replaces the old
 * clone-the-whole-project prepareRunDir.
 */
export class Workspace {
  private constructor(
    readonly workdirPath: string,
    readonly compiledEntryPath: string,
    readonly seededFiles: string[],
  ) {}

  static create(args: {
    workdirPath: string;
    seed: RunSeed;
    overlayFiles?: Record<string, string>;
    config: AgencyConfig;
  }): Workspace {
    const seededFiles = args.seed.kind === "legacyClone"
      ? cloneLegacy(args.workdirPath, args.seed)
      : seedFromPlan(args.workdirPath, args.seed);
    applyOverlay(args.workdirPath, args.overlayFiles);
    return new Workspace(
      args.workdirPath,
      compileEntry(args.workdirPath, args.seed.agentRelPath, args.config),
      seededFiles,
    );
  }

  run(
    runner: EvalInputRunner,
    args: { node: string; args: Record<string, any>; statelogPath: string },
  ): ReturnType<EvalInputRunner> {
    return runner({
      compiledEntryPath: this.compiledEntryPath,
      node: args.node,
      args: args.args,
      cwd: this.workdirPath,
      statelogPath: args.statelogPath,
    });
  }
}
```


- [ ] **Step 4: Run the new tests**

```bash
npx vitest run lib/eval/workspace.test.ts > /tmp/t3.txt 2>&1
grep -E "FAIL|Tests " /tmp/t3.txt | grep -v worktree
```
Expected: PASS.

- [ ] **Step 5: Rewire the consumers, update the workdir tests, delete `runWorkdir.*`**

`lib/eval/runEvalInput.ts` — the `seed` parameter becomes `RunSeed`; the `prepareRunDir` block and runner call become:

```ts
import { Workspace, type RunSeed } from "./workspace.js";
```

```ts
  let workspace: Workspace;
  try {
    workspace = Workspace.create({
      workdirPath: prepared.workdirPath,
      seed: args.seed,
      overlayFiles: args.overlayFiles,
      config: args.config,
    });
  } catch (err) {
    const message = errMessage(err);
    console.error(`[evalRun] workspace seeding failed for input ${inputId}: ${message}`);
    return recordInputRunFailure(prepared, message);
  }

  const runResult = await workspace.run(args.runner, {
    node: args.input.node ?? args.defaultNode,
    args: args.input.args,
    statelogPath: prepared.statelogPath,
  });
  if (!runResult.ok) {
    return recordInputRunFailure(prepared, withSeedListing(runResult.errorMessage, workspace.seededFiles));
  }
```

with the diagnostic helper (the failure mode declared seeding introduces — note it distinguishes the two fixes, per review finding 1):

```ts
const MAX_LISTED_SEEDED_FILES = 50;

/** Append what the workdir contained, so "the agent read a file nobody
 *  seeded" is diagnosable from error.txt alone — and the fix differs by
 *  what kind of file is missing. */
function withSeedListing(errorMessage: string, seededFiles: string[]): string {
  const listed = seededFiles.slice(0, MAX_LISTED_SEEDED_FILES).join(", ");
  const truncated = seededFiles.length > MAX_LISTED_SEEDED_FILES ? ", …" : "";
  return `${errorMessage}\n\nWorkdir was seeded with ${seededFiles.length} file(s): ${listed}${truncated}\n` +
    `If a data file the test needs is missing, add it to the input's "files". ` +
    `If a file the AGENT imports is missing, the closure scan missed it — that is a bug worth reporting.`;
}
```

`lib/cli/eval/run.ts`:

```ts
import { agentClosure } from "@/analysis/closure.js";
import type { RunSeed, SeededSeed } from "@/eval/workspace.js";

/** Derive seed from agent file via closure walk. Called at most once per
 *  `evalRunLoadedInputs` invocation, never per input. */
function deriveSeedFromAgent(agentFile: string, absoluteAgent: string): SeededSeed {
  const closure = agentClosure(agentFile);
  return {
    kind: "seeded",
    baseDir: closure.baseDir,
    agentRelPath: path.relative(closure.baseDir, absoluteAgent),
    closureFiles: closure.files,
  };
}

function resolveInputSeed(
  input: Input,
  defaultSeed: SeededSeed,
  absoluteAgent: string,
  callerSetSeed: boolean,
): RunSeed {
  if (!input.working_dir) return defaultSeed;
  if (callerSetSeed) {
    throw new Error(`input.working_dir cannot be combined with a caller-supplied seed (input id=${input.id ?? "(no id)"})`);
  }
  console.warn(
    `[evalRun] input ${input.id ?? "(no id)"}: working_dir is deprecated; use "files" for test fixtures — ` +
    `the agent's own files are seeded automatically.`,
  );
  const resolved = fs.realpathSync(path.resolve(input.working_dir));
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Eval input working_dir is not a directory: ${input.working_dir}`);
  }
  const rel = path.relative(resolved, absoluteAgent);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`working_dir must contain the agent file (working_dir=${resolved}, agent=${absoluteAgent})`);
  }
  return { kind: "legacyClone", baseDir: resolved, agentRelPath: rel, cloneDir: resolved };
}
```

`EvalRunLoadedInputsOptions.seed` becomes `seed?: SeededSeed` (callers supply the computed form; only `working_dir` produces legacy clones). `defaultSeed`'s type follows.

`lib/optimize/baseOptimizer.ts` (`runInputViaEval`):

```ts
      seed: {
        kind: "seeded",
        baseDir: source.baseDir,
        agentRelPath: source.entryFile,
        closureFiles: Object.values(source.files).map((sourceFile) => sourceFile.absoluteFile),
      },
```

`lib/optimize/baseOptimizer.workdir.test.ts:85` — the assertion changes with the shape (review finding 2; this is an expected, deliberate edit, not a regression):

```ts
    expect(call.seed).toMatchObject({ kind: "seeded", baseDir: src, agentRelPath: "agent.agency" });
    expect(call.seed.closureFiles.length).toBeGreaterThan(0);
```

Delete both `runWorkdir` files and fix stragglers:

```bash
git rm lib/eval/runWorkdir.ts lib/eval/runWorkdir.test.ts
grep -rn "runWorkdir" lib scripts --include='*.ts' | grep -v worktree
```

- [ ] **Step 6: Run the affected suites**

```bash
npx vitest run lib/eval lib/cli/eval lib/optimize > /tmp/t3b.txt 2>&1
grep -E "FAIL|Tests " /tmp/t3b.txt | grep -v worktree
```
Expected: PASS, including `lib/cli/eval/run.workdir.test.ts` **unchanged**. Any other failure is either (a) the seed-shape change reaching a test not listed here — update the assertion to `RunSeed` — or (b) a test whose agent read a file that only arrived via the old full clone; fix (b) by adding the file to that test's seed or fixture, never by re-widening seeding.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm run typecheck && pnpm run lint:structure
git add -A lib
printf 'eval: seed workdirs from the agent closure, not a project clone\n\nWorkspace.create copies the entry agent, its .agency imports, their local\nTypeScript dependencies, and agency.json/.env when present - plus an\noptional test fixture directory at the workdir root. Collisions between\nthe two ingredients are hard errors: tests must not ship agent files, so\none suite can grade any agent. Optimizer overlays apply last; the old\ncopy-the-whole-cwd path survives only behind deprecated working_dir.\n\nA 1 GB workdir becomes kilobytes; the size guard pins seeded workdirs\nunder 1 MB. Run failures list what was seeded and say which fix applies:\nmissing data file -> add to files; missing agent import -> closure bug.\n' > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
```

---

### Task 4: The `files` field on inputs (light form)

**Files:**
- Modify: `packages/agency-lang/lib/eval/runTypes.ts`, `packages/agency-lang/lib/eval/loadInputs.ts`, `packages/agency-lang/lib/cli/eval/run.ts`
- Test: `packages/agency-lang/lib/eval/loadInputs.test.ts`, `packages/agency-lang/lib/cli/eval/run.test.ts`

**Interfaces:**
- Consumes: `SeededSeed.filesDir` from Task 3.
- Produces: `Input.files?: string` — after loading, an **absolute directory path**. `resolveInputSeed` maps it to `filesDir`. Task 7 widens the raw string to a git source; this task is local paths only.

- [ ] **Step 1: Write the failing tests**

Add to `lib/eval/loadInputs.test.ts`:

```ts
describe("files field", () => {
  it("resolves files relative to the inputs file and requires a directory", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    fs.mkdirSync(path.join(suiteDir, "fixtures", "report"), { recursive: true });
    fs.writeFileSync(path.join(suiteDir, "fixtures", "report", "q3.txt"), "data");
    const inputsFile = path.join(suiteDir, "inputs.json");
    fs.writeFileSync(inputsFile, JSON.stringify({
      inputs: [{ id: "a", goal: "g", args: {}, files: "./fixtures/report" }],
    }));

    const [input] = loadInputs(inputsFile);

    expect(input.files).toBe(fs.realpathSync(path.join(suiteDir, "fixtures", "report")));
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("rejects a files value that is not a directory", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    fs.writeFileSync(path.join(suiteDir, "not-a-dir.txt"), "x");
    const inputsFile = path.join(suiteDir, "inputs.json");
    fs.writeFileSync(inputsFile, JSON.stringify({
      inputs: [{ id: "a", goal: "g", args: {}, files: "./not-a-dir.txt" }],
    }));

    expect(() => loadInputs(inputsFile)).toThrow(/files must name a directory/i);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("rejects files combined with working_dir", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    fs.mkdirSync(path.join(suiteDir, "fixture-dir"));
    const inputsFile = path.join(suiteDir, "inputs.json");
    fs.writeFileSync(inputsFile, JSON.stringify({
      inputs: [{ id: "a", goal: "g", args: {}, files: "./fixture-dir", working_dir: "./fixture-dir" }],
    }));

    expect(() => loadInputs(inputsFile)).toThrow(/files.*working_dir/i);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run lib/eval/loadInputs.test.ts > /tmp/t4.txt 2>&1
grep -E "FAIL|Tests " /tmp/t4.txt | grep -v worktree
```
Expected: FAIL.

- [ ] **Step 3: Implement**

`lib/eval/runTypes.ts`, on `Input` below `working_dir`:

```ts
  /** The test's fixture directory. Contents are copied into the workdir root;
   *  the agent's own files are seeded automatically from its import closure.
   *  A raw spec may hold a relative path or (from Task 7) a git source —
   *  after loading it is always an absolute directory path. */
  files?: string;
```

and `working_dir`'s comment becomes: `/** DEPRECATED: use files. Directory cloned wholesale into the workdir; must contain the agent file. */`

`lib/eval/loadInputs.ts`, in `normalizeInput` beside the `working_dir` checks:

```ts
  if (spec.files !== undefined && typeof spec.files !== "string") {
    throw new Error("Eval input files must be a string when provided");
  }
  if (spec.files !== undefined && spec.working_dir !== undefined) {
    throw new Error('Eval input cannot specify both "files" and the deprecated "working_dir"');
  }
```

in the `out` assembly (after `out.id` is fixed, so Task 7 can key provenance by id):

```ts
  if (typeof spec.files === "string") out.files = resolveFilesDir(spec.files, baseDir, options, out.id ?? "");
```

and the helper (Task 7 adds the git branch; the signature already carries what it will need):

```ts
/** Resolve a files entry to an absolute directory. Local paths only until the
 *  sources task teaches this to accept git sources. */
function resolveFilesDir(raw: string, baseDir: string, options: LoadOptions, inputId: string): string {
  const resolved = path.resolve(baseDir, raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Eval input files must name a directory (got ${raw}, resolved to ${resolved})`);
  }
  return fs.realpathSync(resolved);
}
```

`lib/cli/eval/run.ts`, `resolveInputSeed`, before the `working_dir` branch:

```ts
  if (input.files) {
    return { ...defaultSeed, filesDir: input.files };
  }
```

- [ ] **Step 4: End-to-end check — the fixture is visible to the agent**

Add to `lib/cli/eval/run.test.ts` (inline runner/extractor style, as that file does):

```ts
  it("seeds an input's files directory into the workdir", async () => {
    const filesDir = path.join(tmpDir, "fixtures");
    fs.mkdirSync(path.join(filesDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(filesDir, "data", "report.txt"), "q3");
    const agentDir = path.join(tmpDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const agent = path.join(agentDir, "agent.agency");
    fs.writeFileSync(agent, "node main() {}\n");

    let sawFixture = false;
    const result = await evalRunLoadedInputs(
      {
        agent,
        inputs: [{ id: "a", goal: "g", args: {}, files: filesDir }],
        inputsSource: "test",
        runsDir: path.join(tmpDir, "runs"),
        runId: "files-e2e",
      },
      {
        runner: async ({ cwd, statelogPath }) => {
          sawFixture = fs.existsSync(path.join(cwd, "data", "report.txt"));
          fs.writeFileSync(statelogPath, "{}\n");
          return { ok: true };
        },
        extractor: async () => {},
      },
    );

    expect(result.inputs[0].status).toBe("success");
    expect(sawFixture).toBe(true);
  });
```

- [ ] **Step 5: Run, typecheck, lint, commit**

```bash
npx vitest run lib/eval/loadInputs.test.ts lib/cli/eval/run.test.ts > /tmp/t4.txt 2>&1
grep -E "FAIL|Tests " /tmp/t4.txt | grep -v worktree
pnpm run typecheck && pnpm run lint:structure
git add -A lib
printf 'eval inputs: a files field names the test fixture directory\n\nA test declares its files; the agent is seeded separately from its import\nclosure. files resolves relative to the inputs file, must be a directory,\nand is mutually exclusive with the deprecated working_dir (which fused the\ntwo ingredients into one directory).\n' > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
```

---

### Task 5: Test directories (heavy form) and `--inputs <dir>` disambiguation

`loadInputsFromDirectory` (`lib/eval/loadInputs.ts:40-48`) reads a directory as one `.json` per input; that keeps working. Two additions: subdirectories with `test.json` are tests, and — review finding 3 — a lone `.json` whose parsed shape has a top-level `inputs` array is the *file* form, because that is what a git suite repo's root looks like (`--inputs git@github.com:you/evals.git` pointing at a repo holding one `inputs.json`).

**Files:**
- Modify: `packages/agency-lang/lib/eval/loadInputs.ts`
- Test: `packages/agency-lang/lib/eval/loadInputs.test.ts`

**Interfaces:**
- Consumes: `normalizeInput`, `resolveFilesDir` from Task 4; `loadInputsFromFile` (existing).
- Produces: `loadInputsFromDirectory` handling all three shapes with mixed-shape errors. A test directory `t/` desugars to `id = basename(t)`, `files = t/files` when present.

- [ ] **Step 1: Write the failing tests**

```ts
describe("test directories (heavy form)", () => {
  function makeSuite(): string {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
    fs.mkdirSync(path.join(suiteDir, "capital-france"));
    fs.writeFileSync(path.join(suiteDir, "capital-france", "test.json"),
      JSON.stringify({ goal: "Return the capital of France", args: {}, expected: "Paris" }));
    fs.mkdirSync(path.join(suiteDir, "summarize", "files", "data"), { recursive: true });
    fs.writeFileSync(path.join(suiteDir, "summarize", "test.json"),
      JSON.stringify({ goal: "Summarize the report", args: {} }));
    fs.writeFileSync(path.join(suiteDir, "summarize", "files", "data", "report.txt"), "q3");
    return suiteDir;
  }

  it("loads a directory of test directories, defaulting id and files", () => {
    const suiteDir = makeSuite();
    const inputs = loadInputs(suiteDir);

    const byId = Object.fromEntries(inputs.map((input) => [input.id, input]));
    expect(Object.keys(byId).sort()).toEqual(["capital-france", "summarize"]);
    expect(byId["capital-france"].files).toBeUndefined();
    expect(byId["summarize"].files).toBe(fs.realpathSync(path.join(suiteDir, "summarize", "files")));
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("an explicit id in test.json beats the directory name", () => {
    const suiteDir = makeSuite();
    fs.writeFileSync(path.join(suiteDir, "capital-france", "test.json"),
      JSON.stringify({ id: "france", goal: "g", args: {} }));
    const inputs = loadInputs(suiteDir);
    expect(inputs.map((input) => input.id).sort()).toEqual(["france", "summarize"]);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("a lone inputs.json with a top-level inputs array loads as the file form", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
    fs.writeFileSync(path.join(suiteDir, "inputs.json"), JSON.stringify({
      inputs: [{ id: "a", goal: "g", args: {} }, { id: "b", goal: "g", args: {} }],
    }));
    const inputs = loadInputs(suiteDir);
    expect(inputs.map((input) => input.id)).toEqual(["a", "b"]);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("errors when a directory mixes loose input files with test directories", () => {
    const suiteDir = makeSuite();
    fs.writeFileSync(path.join(suiteDir, "loose-input.json"), JSON.stringify({ id: "x", goal: "g", args: {} }));

    expect(() => loadInputs(suiteDir)).toThrow(/mixes.*loose-input\.json.*capital-france/s);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("errors when a wrapper inputs file sits beside other json files", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
    fs.writeFileSync(path.join(suiteDir, "inputs.json"), JSON.stringify({ inputs: [{ id: "a", goal: "g", args: {} }] }));
    fs.writeFileSync(path.join(suiteDir, "b.json"), JSON.stringify({ id: "b", goal: "g", args: {} }));

    expect(() => loadInputs(suiteDir)).toThrow(/inputs\.json.*b\.json/s);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });

  it("subdirectories without test.json are ignored (fixture dirs can sit beside loose inputs)", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
    fs.writeFileSync(path.join(suiteDir, "a.json"), JSON.stringify({ id: "a", goal: "g", args: {} }));
    fs.mkdirSync(path.join(suiteDir, "shared-fixtures"));
    const inputs = loadInputs(suiteDir);
    expect(inputs.map((input) => input.id)).toEqual(["a"]);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify failure** (`/tmp/t5.txt`, same grep.)

- [ ] **Step 3: Implement**

Replace `loadInputsFromDirectory` in `lib/eval/loadInputs.ts`:

```ts
/** A parsed json file whose top-level shape is the suite-file wrapper. */
function isWrapperFile(filePath: string): boolean {
  const parsed = readJson(filePath);
  return typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).inputs);
}

function loadInputsFromDirectory(directoryPath: string, makeId: MakeId, options: LoadOptions): Input[] {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  const jsonFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort();
  const testDirs = entries
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(directoryPath, entry.name, "test.json")))
    .map((entry) => entry.name)
    .sort();
  const wrapperFiles = jsonFiles.filter((name) => isWrapperFile(path.join(directoryPath, name)));
  const looseFiles = jsonFiles.filter((name) => !wrapperFiles.includes(name));

  const shapes = [wrapperFiles, looseFiles, testDirs].filter((group) => group.length > 0);
  if (shapes.length > 1) {
    throw new Error(
      `Input directory ${directoryPath} mixes suite shapes ` +
      `(${shapes.map((group) => group[0]).join(", ")}). Use one form per directory: ` +
      `a single inputs file with an "inputs" array, one-input .json files, or test directories.`,
    );
  }
  if (wrapperFiles.length > 1) {
    throw new Error(`Input directory ${directoryPath} has multiple suite files: ${wrapperFiles.join(", ")}`);
  }
  if (wrapperFiles.length === 1) {
    return loadInputsFromFile(path.join(directoryPath, wrapperFiles[0]), makeId, options);
  }
  if (testDirs.length > 0) {
    return validateInputs(testDirs.map((name) => loadTestDir(path.join(directoryPath, name), makeId, options)));
  }
  return validateInputs(
    looseFiles.map((name) => normalizeInput(readJson(path.join(directoryPath, name)), directoryPath, makeId, options)),
  );
}

/** The heavy form: test.json beside an optional files/ directory. Desugars to
 *  the same Input the light form produces — id defaults to the directory
 *  name, files to the sibling files/. */
function loadTestDir(testDir: string, makeId: MakeId, options: LoadOptions): Input {
  const raw = readJson(path.join(testDir, "test.json"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path.join(testDir, "test.json")} must contain a JSON object`);
  }
  const spec = { ...(raw as Record<string, unknown>) };
  if (spec.id === undefined) spec.id = path.basename(testDir);
  if (spec.files === undefined && fs.existsSync(path.join(testDir, "files"))) spec.files = "./files";
  return normalizeInput(spec, testDir, makeId, options);
}
```

(`normalizeInput` resolves `files` against its `baseDir` argument — the test directory here — so `"./files"` lands correctly.)

- [ ] **Step 4: Run, typecheck, lint, commit**

```bash
npx vitest run lib/eval/loadInputs.test.ts > /tmp/t5.txt 2>&1
grep -E "FAIL|Tests " /tmp/t5.txt | grep -v worktree
pnpm run typecheck && pnpm run lint:structure
git add -A lib
printf 'eval inputs: a directory of test directories is a suite\n\nA test directory holds test.json beside a files/ fixture dir - the\nTerminal Bench shape, self-contained and shareable - and desugars to the\nsame Input the files field produces. A lone inputs.json with a top-level\ninputs array loads as the file form, which is what a git suite repo root\nlooks like. The loose one-input-per-file form keeps working; mixing\nshapes in one directory is an error.\n' > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
```

---

### Task 6: Sources — parse and resolve `local path | git URL` with `//subdir` and `?ref=`

**Files:**
- Create: `packages/agency-lang/lib/eval/sources.ts`, `packages/agency-lang/lib/eval/sources.test.ts`, `packages/agency-lang/lib/eval/testUtils.ts`

**Interfaces:**
- Consumes: nothing in-repo (git via `execFileSync`). **Deliberately not** `_gitRun` from `lib/stdlib/git.ts`: that helper is `async` (the loader path here is synchronous, and three `loadInputs` call sites depend on that), and stdlib support code backs Agency-language builtins — `lib/eval` importing it would invert the layering this work exists to straighten. The helper below is the eval layer's only git invoker; Task 9's audit enforces exactly two invokers in the codebase, each owned by its layer.
- Produces:

```ts
export type ParsedSource =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; subdir?: string; ref?: string; display: string };
export function parseSource(raw: string, baseDir: string): ParsedSource;

export type ResolvedSource = { dir: string; sha?: string; display: string };
export function resolveSource(parsed: ParsedSource, opts?: { cacheRoot?: string }): ResolvedSource;
```

```ts
// lib/eval/testUtils.ts — shared fixture (also used by Task 7's tests)
export function makeRepo(): { repo: string; first: string; second: string };
```

Default cache root: `path.join(os.homedir(), ".agency", "cache", "git")` (precedent: `lib/cli/schedule/index.ts:42` uses `~/.agency/schedules`). Tests always pass an explicit `cacheRoot`.

- [ ] **Step 1: Create `lib/eval/testUtils.ts`**

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

/** A local git repo with two commits on main and a v1 tag at the first.
 *  Callers own cleanup of the returned directory. */
export function makeRepo(): { repo: string; first: string; second: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  fs.writeFileSync(path.join(repo, "tests", "a.txt"), "v1");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one");
  const first = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "tests", "a.txt"), "v2");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two");
  const second = git("rev-parse", "HEAD");
  git("tag", "v1", first);
  return { repo, first, second };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// lib/eval/sources.test.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { afterEach, describe, expect, it } from "vitest";

import { parseSource, resolveSource } from "./sources.js";
import { makeRepo } from "./testUtils.js";

const dirs: string[] = [];
afterEach(() => {
  // Raw rmSync, not safeDelete: mkdtemp paths sit outside any project root,
  // which safeDelete refuses by design. Same reasoning as runArtifacts.ts.
  for (const tempDir of dirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
function tmp(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "src-"));
  dirs.push(tempDir);
  return tempDir;
}
function trackedRepo(): ReturnType<typeof makeRepo> {
  const made = makeRepo();
  dirs.push(made.repo);
  return made;
}

describe("parseSource", () => {
  const base = "/base";

  it("a plain path is local, resolved against baseDir", () => {
    expect(parseSource("./fixtures/x", base)).toEqual({ kind: "local", path: "/base/fixtures/x" });
  });

  it("ssh URLs are git", () => {
    expect(parseSource("git@github.com:egonSchiele/agency-evals.git", base)).toEqual({
      kind: "git", url: "git@github.com:egonSchiele/agency-evals.git",
      display: "git@github.com:egonSchiele/agency-evals.git",
    });
  });

  it("GitHub https URLs derive the clone URL; //subdir and ?ref= parse out", () => {
    expect(parseSource("https://github.com/egonSchiele/agency-evals//tests/git-tasks?ref=v1.2", base)).toEqual({
      kind: "git", url: "https://github.com/egonSchiele/agency-evals.git",
      subdir: "tests/git-tasks", ref: "v1.2",
      display: "https://github.com/egonSchiele/agency-evals//tests/git-tasks?ref=v1.2",
    });
  });

  it("a schemeless github.com form works", () => {
    expect(parseSource("github.com/egonSchiele/agency-evals//tests?ref=main", base)).toMatchObject({
      kind: "git", url: "https://github.com/egonSchiele/agency-evals.git", subdir: "tests", ref: "main",
    });
  });

  it("a local path with ?ref= is a git source cloning from that path", () => {
    expect(parseSource("./fixtures?ref=8d601eb1", base)).toMatchObject({
      kind: "git", url: "/base/fixtures", ref: "8d601eb1",
    });
  });

  it("an empty ref is an error", () => {
    expect(() => parseSource("./fixtures?ref=", base)).toThrow(/ref/);
  });
});

describe("resolveSource", () => {
  it("a local source passes through with no sha", () => {
    const localDir = tmp();
    expect(resolveSource({ kind: "local", path: localDir })).toEqual({ dir: localDir, display: localDir });
  });

  it("resolves a sha ref to that exact commit and records it", () => {
    const { repo, first } = trackedRepo();
    const resolved = resolveSource(parseSource(`${repo}//tests?ref=${first}`, "/"), { cacheRoot: tmp() });
    expect(resolved.sha).toBe(first);
    expect(fs.readFileSync(path.join(resolved.dir, "a.txt"), "utf8")).toBe("v1");
  });

  it("resolves a tag and a branch, recording the resolved sha", () => {
    const { repo, first, second } = trackedRepo();
    const cacheRoot = tmp();
    expect(resolveSource(parseSource(`${repo}//tests?ref=v1`, "/"), { cacheRoot }).sha).toBe(first);
    expect(resolveSource(parseSource(`${repo}//tests?ref=main`, "/"), { cacheRoot }).sha).toBe(second);
  });

  it("a branch re-resolves after the upstream moves", () => {
    const { repo, second } = trackedRepo();
    const cacheRoot = tmp();
    resolveSource(parseSource(`${repo}?ref=main`, "/"), { cacheRoot });
    fs.writeFileSync(path.join(repo, "tests", "a.txt"), "v3");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "three"], { cwd: repo });

    const moved = resolveSource(parseSource(`${repo}?ref=main`, "/"), { cacheRoot });

    expect(moved.sha).not.toBe(second);
    expect(fs.readFileSync(path.join(moved.dir, "tests", "a.txt"), "utf8")).toBe("v3");
  });

  it("errors clearly on a bad ref, naming the source", () => {
    const { repo } = trackedRepo();
    expect(() => resolveSource(parseSource(`${repo}?ref=nope-does-not-exist`, "/"), { cacheRoot: tmp() }))
      .toThrow(/nope-does-not-exist/);
  });

  it("errors clearly when the subdir does not exist at the ref", () => {
    const { repo, first } = trackedRepo();
    expect(() => resolveSource(parseSource(`${repo}//no-such-dir?ref=${first}`, "/"), { cacheRoot: tmp() }))
      .toThrow(/no-such-dir/);
  });
});
```

Run to verify failure (`/tmp/t6.txt`): `Cannot find module './sources.js'`.

- [ ] **Step 3: Implement `lib/eval/sources.ts`**

The parser is three independent peels — a ref suffix, a subdir infix, a URL normalization — and reads as that grammar; every intermediate is `const`.

```ts
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

export type ParsedSource =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; subdir?: string; ref?: string; display: string };

export type ResolvedSource = { dir: string; sha?: string; display: string };

const REF_SEPARATOR = "?ref=";
/** 24 hex chars of the (url, ref) hash: collision-safe for a local cache while
 *  keeping directory names readable. */
const CACHE_KEY_LENGTH = 24;
const DEFAULT_CACHE_ROOT = path.join(os.homedir(), ".agency", "cache", "git");

function looksLikeGitUrl(candidate: string): boolean {
  return candidate.startsWith("git@") || candidate.includes("://")
    || /^github\.com\//.test(candidate) || candidate.endsWith(".git");
}

/** Peel `?ref=<rev>` off the end. */
function splitRef(raw: string): { base: string; ref?: string } {
  const separatorIndex = raw.indexOf(REF_SEPARATOR);
  if (separatorIndex === -1) return { base: raw };
  const ref = raw.slice(separatorIndex + REF_SEPARATOR.length);
  if (ref === "") throw new Error(`Source ${raw}: ?ref= is empty`);
  return { base: raw.slice(0, separatorIndex), ref };
}

/** Peel `//subdir` off, skipping a scheme's own "//". */
function splitSubdir(base: string): { base: string; subdir?: string } {
  const schemeEnd = base.indexOf("://");
  const searchFrom = schemeEnd === -1 ? 0 : schemeEnd + 3;
  const separatorIndex = base.indexOf("//", searchFrom);
  if (separatorIndex === -1) return { base };
  const subdir = base.slice(separatorIndex + 2);
  return { base: base.slice(0, separatorIndex), subdir: subdir === "" ? undefined : subdir };
}

/** The clone URL: a local repo path resolved, a schemeless github.com form
 *  given its scheme, a GitHub https URL given its .git suffix. */
function cloneUrl(base: string, baseDir: string): string {
  const withScheme = /^github\.com\//.test(base) ? `https://${base}` : base;
  const resolved = looksLikeGitUrl(withScheme) ? withScheme : path.resolve(baseDir, withScheme);
  return /^https:\/\/github\.com\//.test(resolved) && !resolved.endsWith(".git")
    ? `${resolved}.git`
    : resolved;
}

/** Parse `local path | git URL [//subdir] [?ref=rev]`. */
export function parseSource(raw: string, baseDir: string): ParsedSource {
  const { base: withoutRef, ref } = splitRef(raw);
  if (ref === undefined && !looksLikeGitUrl(withoutRef)) {
    return { kind: "local", path: path.resolve(baseDir, withoutRef) };
  }
  const { base, subdir } = splitSubdir(withoutRef);
  return { kind: "git", url: cloneUrl(base, baseDir), subdir, ref, display: raw };
}

/** The eval layer's one git invoker. Not stdlib's _gitRun: that is async
 *  (this path must stay synchronous for loadInputs) and stdlib support code
 *  should not be imported upward into the eval layer. */
function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function looksLikeSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(ref);
}

/**
 * Resolve a parsed source to a local directory, plus the resolved sha for git
 * sources. One checkout per (url, ref) under cacheRoot: a sha entry never
 * refetches; a branch/tag/default entry re-fetches per call.
 */
export function resolveSource(parsed: ParsedSource, opts: { cacheRoot?: string } = {}): ResolvedSource {
  if (parsed.kind === "local") {
    return { dir: parsed.path, display: parsed.path };
  }

  const cacheRoot = opts.cacheRoot ?? DEFAULT_CACHE_ROOT;
  const cacheKey = crypto.createHash("sha256")
    .update(`${parsed.url}\n${parsed.ref ?? ""}`)
    .digest("hex")
    .slice(0, CACHE_KEY_LENGTH);
  const cacheDir = path.join(cacheRoot, cacheKey);
  const pinnedToSha = parsed.ref !== undefined && looksLikeSha(parsed.ref);

  if (!fs.existsSync(cacheDir)) {
    materialize(parsed, cacheDir, cacheRoot);
  } else if (!pinnedToSha) {
    try {
      git(["fetch", "--depth", "1", "origin", parsed.ref ?? "HEAD"], cacheDir);
      git(["reset", "--hard", "FETCH_HEAD"], cacheDir);
    } catch (err) {
      throw sourceError(parsed, err);
    }
  }

  const sha = git(["rev-parse", "HEAD"], cacheDir);
  const dir = parsed.subdir ? path.join(cacheDir, parsed.subdir) : cacheDir;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Source ${parsed.display}: subdir "${parsed.subdir}" does not exist at ${sha.slice(0, 12)}`);
  }
  return { dir, sha, display: parsed.display };
}

/** Clone into a temp sibling, then atomically rename into place. Two runs
 *  racing on the same (url, ref) both succeed: the loser discards its clone. */
function materialize(parsed: ParsedSource & { kind: "git" }, cacheDir: string, cacheRoot: string): void {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const tempDir = `${cacheDir}.tmp-${process.pid}-${Date.now()}`;
  try {
    if (parsed.ref !== undefined && looksLikeSha(parsed.ref)) {
      fs.mkdirSync(tempDir, { recursive: true });
      git(["init", "-q"], tempDir);
      git(["remote", "add", "origin", parsed.url], tempDir);
      try {
        git(["fetch", "--depth", "1", "origin", parsed.ref], tempDir);
      } catch (shallowErr) {
        // Some servers refuse arbitrary-sha fetches (GitHub allows them).
        // Fall back to a full fetch — but keep the original reason visible in
        // case the full fetch fails for the same underlying problem.
        console.warn(`[sources] shallow sha fetch failed for ${parsed.display}; retrying with a full fetch ` +
          `(${shallowErr instanceof Error ? shallowErr.message.split("\n")[0] : String(shallowErr)})`);
        git(["fetch", "origin"], tempDir);
      }
      git(["checkout", "-q", parsed.ref], tempDir);
    } else {
      const branchArgs = parsed.ref !== undefined ? ["--branch", parsed.ref] : [];
      git(["clone", "-q", "--depth", "1", ...branchArgs, parsed.url, tempDir]);
    }
    try {
      fs.renameSync(tempDir, cacheDir);
    } catch (renameErr) {
      const code = (renameErr as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") throw renameErr;
      // Lost the race: someone else materialized the same (url, ref).
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw sourceError(parsed, err);
  }
}

function sourceError(parsed: ParsedSource & { kind: "git" }, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(`Failed to resolve source ${parsed.display} (url=${parsed.url}, ref=${parsed.ref ?? "(default)"}): ${detail}`);
}
```

(`EPERM` in the rename allowlist: Windows reports the lost race as `EPERM`. A permissions failure on a first materialization surfaces anyway on the next line, when `rev-parse` runs against a missing `cacheDir`.)

- [ ] **Step 4: Run, typecheck, lint, commit**

```bash
npx vitest run lib/eval/sources.test.ts > /tmp/t6.txt 2>&1
grep -E "FAIL|Tests " /tmp/t6.txt | grep -v worktree
pnpm run typecheck && pnpm run lint:structure
git add -A lib
printf 'eval: sources - local paths and git URLs resolve to directories\n\nA source is a local path or a git URL with optional //subdir and ?ref=\n(anything rev-parse accepts). Git sources resolve through a clone cache\nkeyed by (url, ref): shas cache forever, branches re-fetch per run, and\nevery resolution reports the resolved sha so runs are pinnable after the\nfact. Concurrent resolutions race safely via clone-to-temp + rename.\n' > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
```

---

### Task 7: Wire sources into `--inputs` and `files`, with provenance in config.json

**Files:**
- Modify: `packages/agency-lang/lib/cli/eval/run.ts`, `packages/agency-lang/lib/eval/loadInputs.ts`, `packages/agency-lang/lib/eval/runArtifacts.ts`, `packages/agency-lang/lib/config.ts`, `packages/agency-lang/scripts/agency.ts` (help text)
- Test: `packages/agency-lang/lib/eval/loadInputs.test.ts`, `packages/agency-lang/lib/cli/eval/run.test.ts`

**Interfaces:**
- Consumes: `parseSource`/`resolveSource` (Task 6), `resolveFilesDir` (Task 4), `makeRepo` from `lib/eval/testUtils.ts`, `sha256Text` from `@/optimize/targets.js`.
- Produces (named types — the `{ source, sha? }` shape appears once):

```ts
// lib/eval/runArtifacts.ts
export type SourceProvenance = { source: string; sha?: string };
export type ClosureFileProvenance = { file: string; sha256: string };
export type AgentProvenance = { entry: string; closure: ClosureFileProvenance[] };
export type EvalRunProvenance = {
  inputsSource: SourceProvenance;
  /** Keyed by input id. Ids the loader GENERATED (nanoid, for id-less specs)
   *  are random per run — stable within this config.json, not across runs.
   *  Do not diff these keys between runs; diff the recorded sources. */
  files: Record<string, SourceProvenance>;
  agent: AgentProvenance;
};
```

  - `LoadOptions` gains `forbidGitFiles?: boolean` (one-level rule), `filesProvenance?: Record<string, SourceProvenance>` (caller-owned accumulator), `sourceCacheRoot?: string`.
  - `initializeEvalRun` accepts `provenance?: EvalRunProvenance`, written into `config.json` as a `provenance` key.
  - **Assembly lives beside the type**, so "what does config.json's provenance contain" has one answer — `runArtifacts.ts` also exports:

```ts
export function buildProvenance(args: {
  inputsSource: SourceProvenance;
  files: Record<string, SourceProvenance>;
  seed: { baseDir: string; agentRelPath: string; closureFiles: string[] };
}): EvalRunProvenance;
```

  - `AgencyConfig.eval.sourceCacheRoot?: string` (type + zod `sourceCacheRoot: z.string().optional()`).

- [ ] **Step 1: Write the failing tests**

Add to `lib/eval/loadInputs.test.ts`:

```ts
import { makeRepo } from "./testUtils.js";

describe("git sources for files", () => {
  it("resolves a files git source and records provenance", () => {
    const { repo, first } = makeRepo();
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    const inputsFile = path.join(suiteDir, "inputs.json");
    const filesSource = `${repo}//tests?ref=${first}`;
    fs.writeFileSync(inputsFile, JSON.stringify({
      inputs: [{ id: "a", goal: "g", args: {}, files: filesSource }],
    }));

    const provenance: Record<string, { source: string; sha?: string }> = {};
    const [input] = loadInputs(inputsFile, nanoid, {
      filesProvenance: provenance,
      sourceCacheRoot: path.join(suiteDir, "cache"),
    });

    expect(fs.readFileSync(path.join(input.files!, "a.txt"), "utf8")).toBe("v1");
    expect(provenance["a"]).toEqual({ source: filesSource, sha: first });
    fs.rmSync(suiteDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("forbids git files sources when the suite itself came from git (one-level rule)", () => {
    const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"));
    const inputsFile = path.join(suiteDir, "inputs.json");
    fs.writeFileSync(inputsFile, JSON.stringify({
      inputs: [{ id: "a", goal: "g", args: {}, files: "git@github.com:x/y.git" }],
    }));

    expect(() => loadInputs(inputsFile, nanoid, { forbidGitFiles: true }))
      .toThrow(/one level|vendor/i);
    fs.rmSync(suiteDir, { recursive: true, force: true });
  });
});
```

Add to `lib/cli/eval/run.test.ts` (needs `execFileSync` imported):

```ts
  it("accepts a git source for --inputs and records provenance in config.json", async () => {
    // A local repo of test directories; local path + ?ref= exercises the same
    // resolver path as a remote URL, with no network.
    const suiteRepo = path.join(tmpDir, "suite-repo");
    fs.mkdirSync(path.join(suiteRepo, "capital", "files"), { recursive: true });
    fs.writeFileSync(path.join(suiteRepo, "capital", "test.json"), JSON.stringify({ goal: "g", args: {} }));
    fs.writeFileSync(path.join(suiteRepo, "capital", "files", "hint.txt"), "Paris");
    const gitInSuite = (...gitArgs: string[]) => execFileSync("git", gitArgs, { cwd: suiteRepo, encoding: "utf8" }).trim();
    gitInSuite("init", "-q", "-b", "main");
    gitInSuite("add", "-A");
    gitInSuite("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "suite");
    const suiteSha = gitInSuite("rev-parse", "HEAD");

    const agentDir = path.join(tmpDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const agent = path.join(agentDir, "agent.agency");
    fs.writeFileSync(agent, "node main() {}\n");

    const result = await evalRun(
      {
        agent,
        inputs: `${suiteRepo}?ref=${suiteSha}`,
        runsDir: path.join(tmpDir, "runs"),
        runId: "gitsuite",
        grade: false,
        config: { eval: { sourceCacheRoot: path.join(tmpDir, "cache") } },
      },
      {
        runner: async ({ cwd, statelogPath }) => {
          fs.writeFileSync(statelogPath, "{}\n");
          return fs.existsSync(path.join(cwd, "hint.txt"))
            ? { ok: true }
            : { ok: false, errorMessage: "fixture missing" };
        },
        extractor: async () => {},
      },
    );

    expect(result.inputs[0].status).toBe("success");
    const runConfig = JSON.parse(fs.readFileSync(path.join(tmpDir, "runs", "gitsuite", "config.json"), "utf8"));
    expect(runConfig.provenance.inputsSource).toEqual({ source: `${suiteRepo}?ref=${suiteSha}`, sha: suiteSha });
    expect(runConfig.provenance.agent.closure.length).toBeGreaterThan(0);
    expect(runConfig.provenance.agent.closure[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
```

Run to verify failure (`/tmp/t7.txt`).

- [ ] **Step 2: Implement the loader side**

`lib/eval/loadInputs.ts` — extend `LoadOptions` as in Interfaces, and grow `resolveFilesDir`'s git branch:

```ts
import { parseSource, resolveSource } from "./sources.js";
import type { SourceProvenance } from "./runArtifacts.js";
```

```ts
function resolveFilesDir(raw: string, baseDir: string, options: LoadOptions, inputId: string): string {
  const parsed = parseSource(raw, baseDir);
  if (parsed.kind === "git") {
    if (options.forbidGitFiles) {
      throw new Error(
        `Input ${inputId}: files "${raw}" is a git source, but this suite was itself loaded from git. ` +
        `Sources resolve one level deep — vendor the fixtures into the suite repo instead.`,
      );
    }
    const resolved = resolveSource(parsed, { cacheRoot: options.sourceCacheRoot });
    if (options.filesProvenance) options.filesProvenance[inputId] = { source: raw, sha: resolved.sha };
    return resolved.dir;
  }
  if (!fs.existsSync(parsed.path) || !fs.statSync(parsed.path).isDirectory()) {
    throw new Error(`Eval input files must name a directory (got ${raw}, resolved to ${parsed.path})`);
  }
  if (options.filesProvenance) options.filesProvenance[inputId] = { source: raw };
  return fs.realpathSync(parsed.path);
}
```

- [ ] **Step 3: Implement the CLI and artifacts side**

`lib/cli/eval/run.ts` — the branching lives behind one declarative helper; each branch is early-return `const`s, no reassigned state:

```ts
type LoadedSuite = {
  inputs: Input[];
  provenance: { inputsSource: SourceProvenance; files: Record<string, SourceProvenance> };
};

/** Load the suite named by --inputs/--goal, resolving a git source when given
 *  one, collecting source provenance for config.json as it goes. */
function loadSuite(args: {
  selection: "inputs" | "goal";
  inputs?: string;
  goal?: string;
  requireGoal: boolean;
  cacheRoot?: string;
}): LoadedSuite {
  if (args.selection === "goal") {
    return {
      inputs: [inputFromGoal(args.goal ?? "")],
      provenance: { inputsSource: { source: "inline:--goal" }, files: {} },
    };
  }
  const filesProvenance: Record<string, SourceProvenance> = {};
  const loadOptions = { requireGoal: args.requireGoal, filesProvenance, sourceCacheRoot: args.cacheRoot };
  const parsed = parseSource(args.inputs ?? "", process.cwd());
  if (parsed.kind === "git") {
    const resolved = resolveSource(parsed, { cacheRoot: args.cacheRoot });
    return {
      inputs: loadInputs(resolved.dir, nanoid, { ...loadOptions, forbidGitFiles: true }),
      provenance: { inputsSource: { source: args.inputs ?? "", sha: resolved.sha }, files: filesProvenance },
    };
  }
  return {
    inputs: loadInputs(parsed.path, nanoid, loadOptions),
    provenance: { inputsSource: { source: parsed.path }, files: filesProvenance },
  };
}
```

and `evalRun`'s body becomes one call:

```ts
  const suite = loadSuite({
    selection,
    inputs: opts.inputs,
    goal: opts.goal,
    requireGoal: graders !== undefined && gradersPath === undefined,
    cacheRoot: opts.config?.eval?.sourceCacheRoot,
  });
```

passing `inputs: suite.inputs` and `provenance: suite.provenance` into `evalRunLoadedInputs` (new optional field `provenance?: { inputsSource: SourceProvenance; files: Record<string, SourceProvenance> }` on `EvalRunLoadedInputsOptions`). The `filesProvenance` accumulator — a mutable record the loader fills as it resolves each input's `files` — is deliberately *private to `loadSuite`*: the imperative detail is encapsulated, and every caller sees only the returned `LoadedSuite`. Inside `evalRunLoadedInputs`, after `defaultSeed`, assembly is one call:

```ts
  const provenance = buildProvenance({
    inputsSource: opts.provenance?.inputsSource ?? { source: opts.inputsSource },
    files: opts.provenance?.files ?? {},
    seed: defaultSeed,
  });
```

passed to `initializeEvalRun({ ..., provenance })`. In `lib/eval/runArtifacts.ts`, add the provenance types (Interfaces block above), the builder — the only place the closure gets hashed:

```ts
import { sha256Text } from "@/utils/hash.js";

/** The one assembler of config.json's provenance key. */
export function buildProvenance(args: {
  inputsSource: SourceProvenance;
  files: Record<string, SourceProvenance>;
  seed: { baseDir: string; agentRelPath: string; closureFiles: string[] };
}): EvalRunProvenance {
  return {
    inputsSource: args.inputsSource,
    files: args.files,
    agent: {
      entry: args.seed.agentRelPath,
      closure: args.seed.closureFiles.map((closureFile) => ({
        file: path.relative(args.seed.baseDir, closureFile),
        sha256: sha256Text(fs.readFileSync(closureFile, "utf8")),
      })),
    },
  };
}
```

and in `initializeEvalRun`'s `writeJson` object add `provenance: args.provenance` — `JSON.stringify` drops `undefined` properties, so no conditional spread is needed.

`lib/config.ts`: add `sourceCacheRoot?: string;` to the `eval` block (typed interface **and** zod schema).

`scripts/agency.ts`: `--inputs` description on `eval run` becomes `"Input suite: a JSON file, a directory, or a git source (URL[//subdir][?ref=...])"`.

- [ ] **Step 4: Run, typecheck, lint, commit**

```bash
npx vitest run lib/eval/loadInputs.test.ts lib/eval/sources.test.ts lib/cli/eval/run.test.ts > /tmp/t7.txt 2>&1
grep -E "FAIL|Tests " /tmp/t7.txt | grep -v worktree
pnpm run typecheck && pnpm run lint:structure
git add -A lib scripts
printf 'eval: --inputs and files accept git sources; config.json records provenance\n\nA suite can live in its own repo and a test can pull fixtures from one.\nWhatever the source string said, config.json records the resolved sha plus\nthe agent closure with per-file content hashes, so any run is reproducible\nand two runs are comparable exactly when their shas match. Suites loaded\nfrom git may not point files at further git sources (one-level rule).\n' > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
```

---

### Task 8: Run-directory layout — `agent/` per input, `verifier/` at the run root

Evidence vs opinion. Per-input statelog/eval-record/error.txt move under `agent/`. Grading output lands in `verifier/` **at the run root** (grading is suite-level; one `grading.json` covers every input via `perInput`), with re-grades in `verifier-N/` where N is **one more than the highest existing** number (the spec's rule — not first-gap: a deleted `verifier-3` stays retired). `input.json` and `workdir/` do not move; `workdirFor` (`lib/eval/grading/gradeRun.ts:156`) keeps working unchanged — verify, don't touch.

**Files:**
- Modify: `packages/agency-lang/lib/eval/runArtifacts.ts`, `packages/agency-lang/lib/eval/readRun.ts`, `packages/agency-lang/lib/cli/eval/run.ts`, `packages/agency-lang/lib/cli/eval/grade.ts`, `packages/agency-lang/lib/optimize/testUtils.ts`
- Test: `packages/agency-lang/lib/eval/readRun.test.ts` (create if missing), `packages/agency-lang/lib/cli/eval/grade.test.ts`, `packages/agency-lang/lib/cli/eval/run.test.ts`

**Interfaces:**
- Consumes: `PreparedInput`, `EvalRunGrading`.
- Produces: `prepareInput` paths under `inputDir/agent/`; `readEvalRun` dual-layout fallbacks; and **one writer** for the verifier artifact, in `runArtifacts.ts`, used by both the inline-grading path and `eval grade` so two files can never drift on its location or shape:

```ts
/** Write a grading pass into the run's next verifier directory (verifier/,
 *  then verifier-N by highest existing + 1 — a deleted number stays retired).
 *  Returns the path written. The ONLY writer of this artifact. */
export function writeVerifierGrading(runDir: string, grading: EvalRunGrading): string;
```

  A fresh run has no `verifier/`, so the inline path naturally writes `verifier/grading.json` and re-grades get `verifier-2/`… — one numbering rule, one implementation. The summary carries **absolute** paths, so readers follow automatically; only path constructors change, and the fallback code only runs for results with empty paths (prepare failures) or hand-built directories.

- [ ] **Step 1: Write the failing tests**

`lib/eval/readRun.test.ts`:

```ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { readEvalRun } from "./readRun.js";

function makeRun(layout: "legacy" | "current"): string {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "readrun-"));
  const inputDir = path.join(runDir, "inputs", "a");
  const recordDir = layout === "current" ? path.join(inputDir, "agent") : inputDir;
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(path.join(recordDir, "eval-record.json"), JSON.stringify({ evalOutputs: [] }));
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({
    runId: "r", runDir, agent: "a:main", okCount: 1, errorCount: 0,
    // Empty evalRecordPath forces the constructed-path fallback — the only
    // layout-sensitive code path.
    inputs: [{ inputId: "a", status: "success", evalRecordPath: "", statelogPath: "", workdirPath: "" }],
  }));
  return runDir;
}

describe("readEvalRun layouts", () => {
  it("finds the record under agent/ (current layout)", () => {
    const runDir = makeRun("current");
    expect(readEvalRun(runDir).inputsById["a"].status).toBe("ok");
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it("still finds the record at the legacy flat path", () => {
    const runDir = makeRun("legacy");
    expect(readEvalRun(runDir).inputsById["a"].status).toBe("ok");
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
```

`lib/cli/eval/grade.test.ts` — add (and update the two existing assertions that expect `<runDir>/grading.json` to expect `verifier/grading.json`; `-o` behavior unchanged):

```ts
  it("writes verifier/grading.json first, then verifier-N by highest existing + 1", async () => {
    const runDir = makeRunDir("hello");

    await evalGrade(runDir, { graders: makeGraders(), config: {} });
    await evalGrade(runDir, { graders: makeGraders(), config: {} });
    // A deleted number stays retired: with verifier and verifier-2 present,
    // removing verifier-2 and re-grading must produce verifier-3, not reuse 2.
    fs.rmSync(path.join(runDir, "verifier-2"), { recursive: true, force: true });
    fs.mkdirSync(path.join(runDir, "verifier-4"));   // simulate an even later grade
    await evalGrade(runDir, { graders: makeGraders(), config: {} });

    expect(fs.existsSync(path.join(runDir, "verifier", "grading.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "verifier-5", "grading.json"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "verifier-2"))).toBe(false);
  });
```

`lib/cli/eval/run.test.ts` — extend the existing "writes a grading block into summary.json" test:

```ts
      expect(fs.existsSync(path.join(tmpDir, "runs", "graded", "verifier", "grading.json"))).toBe(true);
```

Run to verify failure (`/tmp/t8.txt`).

- [ ] **Step 2: Implement**

`lib/eval/runArtifacts.ts`, `prepareInput`:

```ts
  const inputDir = path.join(state.inputsDir, id);
  const agentDir = path.join(inputDir, "agent");
  const workdirPath = path.join(inputDir, "workdir");
  fs.mkdirSync(agentDir, { recursive: true });
```

```ts
  const prepared: PreparedInput = {
    input,
    inputDir,
    inputJsonPath: path.join(inputDir, "input.json"),
    statelogPath: path.join(agentDir, "statelog.jsonl"),
    evalRecordPath: path.join(agentDir, "eval-record.json"),
    workdirPath,
    errorPath: path.join(agentDir, "error.txt"),
  };
```

`lib/eval/readRun.ts` — constructed-path fallbacks:

```ts
/** The first existing candidate, else the first candidate — so "missing"
 *  errors point at the current-layout location. */
function firstExisting(...candidates: string[]): string {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
```

```ts
    const recordPath = result.evalRecordPath
      || firstExisting(
        path.join(inputDir, "agent", "eval-record.json"),
        path.join(inputDir, "eval-record.json"),      // pre-layout runs
      );
```

```ts
    const errorMessage = status === "failed"
      ? readOptionalText(firstExisting(
          path.join(inputDir, "agent", "error.txt"),
          path.join(inputDir, "error.txt"),
        )) ?? result.errorMessage
      : undefined;
```

`lib/eval/runArtifacts.ts` — the single verifier writer, beside the other artifact writers (pure numbering; the writer does the mkdir):

```ts
/** One more than the highest existing verifier directory (the spec's rule:
 *  a deleted number stays retired, never reused). verifier == 1. */
function nextVerifierNumber(runDir: string): number {
  const numbers = fs.readdirSync(runDir)
    .map((name) => (name === "verifier" ? 1 : Number(/^verifier-(\d+)$/.exec(name)?.[1])))
    .filter((candidate) => Number.isInteger(candidate));
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

/** Write a grading pass into the run's next verifier directory. The ONLY
 *  writer of this artifact — the inline eval-run path and `eval grade` both
 *  call it, so its location and shape cannot drift between them. */
export function writeVerifierGrading(runDir: string, grading: EvalRunGrading): string {
  const verifierNumber = nextVerifierNumber(runDir);
  const verifierDir = path.join(runDir, verifierNumber === 1 ? "verifier" : `verifier-${verifierNumber}`);
  fs.mkdirSync(verifierDir, { recursive: true });
  const gradingPath = path.join(verifierDir, "grading.json");
  fs.writeFileSync(gradingPath, JSON.stringify(grading, null, 2));
  return gradingPath;
}
```

(`EvalRunGrading` lives in `runTypes.ts`, which `runArtifacts.ts` already imports from.)

`lib/cli/eval/grade.ts` — the write site becomes:

```ts
  if (opts.out !== undefined) {
    fs.writeFileSync(opts.out, JSON.stringify(grading, null, 2));
  } else {
    writeVerifierGrading(resolvedRunDir, grading);
  }
```

(With `-o`, `writeVerifierGrading` is never called, so no empty `verifier-N/` appears on `-o` runs.)

`lib/cli/eval/run.ts` — inline grading calls the same writer after `summary.grading` is assigned, before the summary rewrite:

```ts
  writeVerifierGrading(summary.runDir, summary.grading);
```

(A fresh run directory has no `verifier/`, so this lands at `verifier/grading.json` — the numbering rule needs no special case for the inline path.)

`lib/optimize/testUtils.ts` — `fakeRun` fabricates the new layout:

```ts
  const agentDir = path.join(inputDir, "agent");
  fs.mkdirSync(path.join(inputDir, "workdir"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const recordPath = path.join(agentDir, "eval-record.json");
  // ... statelogPath: path.join(agentDir, "statelog.jsonl"),
```

Also move the fixture layouts in `lib/eval/grading/gradeRun.test.ts` and `lib/cli/eval/grade.test.ts` (`makeRun`/`makeRunDir`) to `agent/` paths — they pass explicit absolute paths so they would keep working, but fixtures should match reality.

- [ ] **Step 3: Run the affected suites**

```bash
npx vitest run lib/eval lib/cli/eval lib/optimize > /tmp/t8.txt 2>&1
grep -E "FAIL|Tests " /tmp/t8.txt | grep -v worktree
```
Expected: PASS. Stragglers are tests hand-constructing the old flat paths.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
pnpm run typecheck && pnpm run lint:structure
git add -A lib
printf 'eval: run layout separates agent evidence from verifier opinion\n\nPer input, statelog/eval-record/error.txt move under agent/. Grading\nwrites verifier/grading.json at the run root (grading is suite-level);\nre-grades write verifier-N by highest existing + 1 so a deleted number\nstays retired, and -o still writes out of tree. readEvalRun reads both\nlayouts so old runs stay judgeable and gradable.\n' > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
```

---

### Task 9: Documentation and final audit

**Files:**
- Modify: `packages/agency-lang/docs/site/cli/eval.md`, `packages/agency-lang/docs/dev/writing-optimizers.md`

- [ ] **Step 1: Update `docs/site/cli/eval.md`**

Three edits:

1. Usage block: `(--inputs <file|dir|git-url> | --goal <text>)`.
2. Replace the "Each run writes" layout block:

````markdown
```text
runs/<run-id>/
  config.json           # resolved provenance: agent closure with file hashes,
                        #   inputs source (resolved sha when git), options
  summary.json          # counts + the latest grading block
  verifier/
    grading.json        # what the graders concluded; re-grades write
                        #   verifier-2/, verifier-3/ instead of overwriting
  inputs/<input-id>/
    input.json          # the resolved input spec
    agent/
      statelog.jsonl    # what the agent did
      eval-record.json  # the normalized trace
      error.txt         # only on error
    workdir/            # the isolated directory the agent ran in
```
````

3. Add a "Test files and suites" section after the options list:

````markdown
## Test files and suites

A workdir is seeded from **two ingredients**: the input's declared files and the
agent's own code — the entry `.agency` file, everything it transitively imports,
and any local TypeScript files those imports use (computed; never list agent
files by hand). The same suite can therefore grade any agent.

An input declares its fixture directory with `files`; the contents land at the
workdir root:

```jsonc
{ "id": "summarize", "goal": "Summarize the report into summary.md",
  "args": {}, "files": "./fixtures/summarize" }
```

For file-heavy tests, a directory form is equivalent: a directory of test
directories, each holding `test.json` (the input spec; `id` defaults to the
directory name) and an optional `files/` directory. Point `--inputs` at the
parent. A directory holds one suite shape: a single `inputs.json`, loose
one-input `.json` files, or test directories — never a mix.

Suites and fixtures can come from git. Anywhere a directory is accepted, a git
source works too:

```bash
agency eval run --agent a.agency --inputs 'github.com/you/evals//tests?ref=v1.2'
```

`//subdir` names a directory inside the repo; `?ref=` takes a branch, tag, or
commit sha (a local path with `?ref=` reads that repo's files as of the commit).
Whatever you wrote, `config.json` records the **resolved sha**, so any past run
is pinnable by copying its sha into `?ref=`. Clones cache under
`~/.agency/cache/git/`; branch refs re-fetch per run, shas never do. A suite
loaded from git may not point `files` at another git source (sources resolve
one level deep).

An agent that reads a project file that was never seeded gets a file-not-found
error inside the workdir; the run's `error.txt` lists what was seeded and which
fix applies. The `working_dir` field is deprecated — it fused fixtures and agent
files into one directory, which tied a test to one agent.
````

- [ ] **Step 2: Update `docs/dev/writing-optimizers.md`**

The Testing table's `runInput` row appends: "`fakeRun` writes the record under the run layout's `agent/` directory."

- [ ] **Step 3: Pre-PR anti-pattern audit and full local check**

Read `packages/agency-lang/docs/dev/anti-patterns.md`, then review `git diff main...HEAD` against it. Check at minimum: no narrating comments; no `Map`/`Set`-as-state/`interface`; no dynamic imports; no conditional spreads; no in-memory module-global caches (the sources cache is on **disk**); `sources.ts`'s `git()` is the only new git invoker; no single-character identifiers; magic numbers are named.

```bash
npx vitest run lib/eval lib/cli/eval lib/optimize > /tmp/t9.txt 2>&1
grep -E "FAIL|Tests " /tmp/t9.txt | grep -v worktree
pnpm run typecheck && pnpm run lint:structure
```

- [ ] **Step 4: Commit docs; push and open the PR**

```bash
git add -A docs
printf 'docs: seeded workdirs, test suites, git sources, run layout\n' > /tmp/commitmsg.txt
git commit -F /tmp/commitmsg.txt
git push -u origin adit/eval-workdirs
```

Write the PR body to `/tmp/prbody.md` — covering: the 1.0 GB → <1 MB measurement, the two-ingredient seed (including the TS-interop closure), sources with sha provenance, the layout change with dual-layout reading, `working_dir` deprecation, and what was deliberately not done (git tracking of workdirs, pruning, setup scripts) — then:

```bash
gh pr create --title "Eval workdirs: seed from test files + agent closure, git-source suites, agent/verifier layout" --body-file /tmp/prbody.md
```

---

## Self-Review

**Spec coverage.** Sources (syntax, resolution, cache, one-level rule, inert-data safety) → Tasks 6–7. Formats (light `files`, heavy test dirs, wrapper-file rule, disambiguation) → Tasks 4–5. Seeding (agency + TS closure, config files, collisions, legacy clone, unseeded-read diagnostics, compile in place) → Tasks 2–4. Layout (`agent/` per input, `verifier/` at run root, highest-plus-one numbering, dual-layout reads, `fakeRun`) → Task 8. Provenance → Task 7. `CachePartition` rename → Task 1. 1 MB size guard → Task 3. Docs → Task 9.

**Deliberate deviations from the spec, recorded:**
1. The unseeded-read diagnostic lands in `error.txt`/`errorMessage`, not the eval record — a failed run frequently has no record to annotate, and `error.txt` is where a user debugging a failure already looks. The message distinguishes a missing *test data file* (add to `files`) from a missing *agent dependency* (a closure-scan bug), per review finding 1.
2. `Workspace.run` takes an injected `EvalInputRunner` rather than owning subprocess execution (spec v2 already sketches this form): it preserves the seam every existing test injects and keeps `Workspace` out of the subprocess-limits business.
3. The optimizer's seed uses its existing `.agency`-only closure (`OptimizeTargetSet.files`) rather than `agentClosure` — preserving its current behavior exactly; adopting the TS-aware walk there is a separate, easy follow-up if ever needed.

**Review findings, disposition:** 1 → Task 2 (esbuild TS deps) + Task 3's two-fix diagnostic; 2 → Task 3 Files list + explicit assertion edit; 3 → Task 5's wrapper-file rule + spec edit (done); 4 → Task 8's `nextVerifierNumber` (highest + 1, with the deleted-number test); 5 → deviation 2 above + spec edit (done); 6 → Task 6's recorded `_gitRun` rationale; 7 → the single `writeVerifierGrading` writer (never called under `-o`); 8 → the generated-id caveat on `EvalRunProvenance.files`.

**Second anti-pattern audit (v2.1 code, post-consolidation):** four violations found in blocks added after the reviewer's audit, all fixed in place — the nested-ternary chain in `nonAgencyLocalImportTargets` (now the `importedModulePath` helper with braced ifs), the `Set` dedup in `agentClosure` (now the catalog's own indexOf-filter idiom), the comma-expression + IIFE in `Workspace.create` (now named `cloneLegacy`/`seedFromPlan` strategies), and the `let`-reassignment branching in `evalRun` (now the early-return `loadSuite` helper, with the provenance accumulator private to it). Two deliberate judgment calls stand: the rename `catch` in `materialize` stays silent for the three race errnos only (commented; rethrows everything else), and `loadTestDir` fills defaults by mutating a local copy of the spec — the alternative is a banned conditional spread.

**Grouping (owner-requested consolidations):** the closure walk lives in `lib/analysis/closure.ts` — not the optimizer — so eval never imports from `lib/optimize` (`sha256Text` re-homed to `lib/utils/hash.ts` for the same reason); `verifier/grading.json` has exactly one writer (`writeVerifierGrading` in `runArtifacts.ts`), called by both the inline path and `eval grade`; provenance has exactly one assembler (`buildProvenance` in `runArtifacts.ts`, beside its type). Addendum: A1 (parser as three peels), A2 (planSeed/materialize/applyOverlay/compileEntry), A3 (folded into finding 4), A4 (declarative `listFilesRecursive`), A5 (no conditional spreads anywhere; `toEqual` treats `undefined`-valued keys as absent, so the parser tests hold), A6 (logged fetch fallback; rename catch narrowed to race errno codes), A7 (named `SourceProvenance`/`ClosureFileProvenance`/`AgentProvenance`), A8 (`RunSeed` discriminated union), A9 (`CACHE_KEY_LENGTH`, `MAX_LISTED_SEEDED_FILES`, `REF_SEPARATOR`), A10 (no single-character names, tests included), A11 (`makeRepo` in `lib/eval/testUtils.ts`, shared).

**Type consistency:** `RunSeed`/`SeededSeed`/`LegacyCloneSeed` defined once (Task 3) and consumed in Tasks 4, 7, and the optimizer wiring; `agentClosure` (Task 2) → `deriveSeedFromAgent` (Task 3); `ParsedSource`/`ResolvedSource` (Task 6) → Task 7; `SourceProvenance` shared between `LoadOptions` and `EvalRunProvenance`; `nextVerifierNumber` private to `runArtifacts.ts` behind the exported `writeVerifierGrading`; `CachePartition` (Task 1) precedes the eval `Workspace` (Task 3); `agentClosure`/`walkAgencyClosure`/`closureBaseDir` live in `@/analysis/closure.js` and are imported from there by Tasks 3 and 7 and by `lib/optimize/targets.ts` — nothing imports them from optimize.
