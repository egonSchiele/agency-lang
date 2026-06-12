# Optimize Declaration Modifier V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace legacy `@optimize(...)` prompt tags with an `optimize` declaration modifier and deterministic multi-file target discovery/patching for local Agency import trees.

**Architecture:** Add parser/formatter support for `optimize` on variable declarations, ignore the modifier at runtime, discover marked string declarations across the root file plus local `.agency` imports, and apply mutator changes through a declarative patch-plan pipeline. Candidate artifacts materialize only the Agency file set under `iter-N/agent/`; writeback updates root/imported local files only after hash verification.

**Tech Stack:** TypeScript, tarsec parser combinators, Agency AST/generator, TypeScript builder, Vitest, existing `lib/optimize/*` loop modules, eval run/judge primitives from the preceding plans.

---

## Source spec

Spec: `docs/superpowers/specs/2026-06-10-optimize-declaration-modifier-design.md`

This plan supersedes `docs/superpowers/plans/2026-06-10-optimize-declaration-modifier.md` where that older plan assumes the pre-refactor optimize loop or `rubric` task terminology.

## File structure

### Create

- `lib/optimize/targets.ts`
  - Discovers `assignment.optimize === true` in the root file and local relative `.agency` import tree.
  - Owns target IDs, source file hashes, import traversal, nested-block rejection, legacy tag rejection, supported value validation, duplicate ID checks, and sorted target output.
- `lib/optimize/targets.test.ts`
  - Parser-backed tests for discovery, local imports, cycles, skipped imports, duplicate IDs, unsupported values, nested declarations, deterministic sorting, and legacy tag rejection.
- `lib/optimize/patch.ts`
  - Implements `buildOptimizePatchPlan()`, `validateOptimizePatchPlan()`, and `applyOptimizePatchPlan()`.
  - Owns old-value checks, interpolation preservation, target-level changes, rendered file outputs, and diffs.
- `lib/optimize/patch.test.ts`
  - Unit tests for string/multiline changes, unknown targets, old-value mismatch, interpolation preservation, changed-file rendering, and diff output.

### Modify

- `lib/types.ts`
  - Add `optimize?: boolean` to `Assignment`.
- `lib/parsers/parsers.ts`
  - Parse strict forms: `optimize const`, `optimize let`, `optimize static const`.
  - Reject `static optimize const`, `const optimize name`, `optimize name =`, and `export optimize` combinations in v1.
- `lib/parsers/assignment.test.ts`
  - Add valid and invalid modifier tests.
- `lib/parsers/exportConst.test.ts`
  - Preserve existing export/static behavior and reject export+optimize combinations.
- `lib/backends/agencyGenerator.ts`
  - Emit canonical `optimize static const` ordering.
- `lib/backends/agencyGenerator.test.ts`
  - Formatter tests for all valid optimize declarations.
- `lib/backends/typescriptBuilder/assignmentEmitter.ts` and tests
  - Ensure generated TypeScript ignores `optimize`.
- `lib/optimize/types.ts`
  - Replace single-prompt types with target-level changes and file-set target config.
- `lib/optimize/validation.ts`
  - Generalize interpolation validation for any optimized string value.
- `lib/optimize/mutator.ts`
  - Mutator input becomes target list + suite goals + history; output becomes `changes[]`.
- `lib/agents/mutatePrompt.agency`
  - Keep filename if simplest, but update schema to target-level mutation output.
- `lib/optimize/artifacts.ts`
  - Remove broad workspace copying; write `targets.json`, `mutation.json`, `mutation.md`, `diff.patch`, `iter-N/agent/`, and `champion/agent/` file sets.
- `lib/optimize/loop.ts`
  - Use target discovery/patching and multi-file materialization.
- `lib/cli/eval/optimize.ts`
  - Build file-oriented target config; accept declaration targets instead of tags.
- `scripts/agency.ts`
  - Update `eval optimize` syntax from tagged prompt to optimized declarations if this plan lands before the top-level optimize plan.
- `docs/site/cli/eval.md`
  - Remove `@optimize(...)` examples.

## Implementation notes

- V1 supports only optimized declarations at top level, directly inside a function body, or directly inside a node body.
- Supported value domains are string literal and multiline string literal only.
- Target ID format is `<relative-file>:<scope>:<variable>` using POSIX separators. The base directory is the CWD from which the CLI was invoked (where the user typed `agency optimize foo.agency`), not the CLI install directory.
- Discovery follows only local relative `.agency` imports. Skip `std::`, `pkg::`, JS/TS, and bare imports.
- Targets are sorted by ID everywhere.
- Candidate materialization must not broadly copy the workspace.
- Patch application uses parsed AST + `AgencyGenerator` to render changed files. `AgencyGenerator` preserves comments. Reformatting of the rest of the file is acceptable because all Agency source is expected to be `agency format`'d as a prerequisite.
- Writeback aborts all files if any target file hash changed externally, **or** if the discovered target ID set differs from the set captured at run start.
- Stale fixture directories such as `runs/optimize/foo-smoke/` that contain copied workspace/stdlib content must be deleted as part of this work, since the new artifact layout no longer broadly copies the workspace.

---

### Task 1: Add parser, AST, and formatter support

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/parsers/parsers.ts`
- Modify: `lib/parsers/assignment.test.ts`
- Modify: `lib/parsers/exportConst.test.ts`
- Modify: `lib/backends/agencyGenerator.ts`
- Modify: `lib/backends/agencyGenerator.test.ts`

- [ ] **Step 1: Write failing parser tests for valid forms**

In `lib/parsers/assignment.test.ts`:

```ts
expect(parseAssignment("optimize const prompt = \"hi\"")).toMatchObject({ optimize: true, declKind: "const" });
expect(parseAssignment("optimize let prompt = \"hi\"")).toMatchObject({ optimize: true, declKind: "let" });
expect(parseAssignment("optimize static const prompt = \"hi\"")).toMatchObject({ optimize: true, static: true, declKind: "const" });
```

Use the existing parser helper names from nearby tests rather than inventing new helpers.

- [ ] **Step 2: Write failing invalid-form tests**

Assert parse failure for:

```agency
static optimize const prompt = "hi"
const optimize prompt = "hi"
optimize prompt = "hi"
export optimize const prompt = "hi"
optimize export const prompt = "hi"
```

Also assert that `optimize` keeps working as an ordinary identifier when it is **not** followed by `const|let|static`. The parser must only treat `optimize` as a declaration modifier when the lookahead is one of those keywords. Add tests:

```ts
// `optimize` is still a valid identifier in expression position
expect(parseStatement("const optimize = 5")).toMatchObject({ name: "optimize" });
expect(parseStatement("optimize(x)")).toMatchObject({ type: "functionCall" });
expect(parseStatement("optimize = 1")).toMatchObject({ type: "assignment" });
```

- [ ] **Step 3: Write failing formatter tests**

Assert generation preserves canonical order:

```agency
optimize static const prompt = "hi"
```

- [ ] **Step 4: Run RED**

```bash
pnpm test:run lib/parsers/assignment.test.ts lib/parsers/exportConst.test.ts lib/backends/agencyGenerator.test.ts > /tmp/optimize-decl-parser-red.log 2>&1
```

- [ ] **Step 5: Add AST field**

In `lib/types.ts` assignment type:

```ts
optimize?: boolean;
```

- [ ] **Step 6: Implement strict parser grammar**

In `lib/parsers/parsers.ts`, parse optional `optimize` before optional `static` and before `const|let`. Keep existing non-optimized `export`/`static` behavior unchanged.

**Critical:** `optimize` must only be consumed as a modifier when the lookahead is `static`, `const`, or `let`. In any other position it must continue to parse as an ordinary identifier (`const optimize = 5`, `optimize(x)`, `optimize = 1`). Use a guarded match (e.g., `seq(str("optimize"), lookahead(oneOf("static", "const", "let")))`) rather than a bare `opt(str("optimize"))`, otherwise expression-position uses will break.

Also reject `export optimize` and `optimize export` combinations explicitly in v1.

- [ ] **Step 7: Emit modifier in generator**

In `lib/backends/agencyGenerator.ts`, emit `optimize ` immediately before the existing `static`/`export`/`const`/`let` prefix in canonical order: `[export ][optimize ][static ](const|let) name = value`. Read the current assignment-emission code in `agencyGenerator.ts` first and adapt the existing prefix-composition pattern rather than introducing a new local variable layout — the snippet below is illustrative, not prescriptive:

```ts
// Illustrative only — adapt to whatever shape the current generator uses.
const optimizePrefix = node.optimize ? "optimize " : "";
```

- [ ] **Step 8: Run GREEN**

```bash
pnpm test:run lib/parsers/assignment.test.ts lib/parsers/exportConst.test.ts lib/backends/agencyGenerator.test.ts > /tmp/optimize-decl-parser-green.log 2>&1
```

- [ ] **Step 9: Commit**

```bash
git add lib/types.ts lib/parsers/parsers.ts lib/parsers/assignment.test.ts lib/parsers/exportConst.test.ts lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.test.ts
git commit -m "optimize: parse declaration modifier"
```

---

### Task 2: Verify TypeScript generation ignores `optimize`

**Files:**
- Modify: `lib/backends/typescriptBuilder/assignmentEmitter.ts` only if needed
- Modify: `lib/backends/typescriptBuilder.integration.test.ts` and fixture files under `tests/typescriptBuilder/` if the existing fixture pattern is the easiest way to assert generated output
- Modify: `lib/backends/typescriptBuilder.test.foo.ts` only if it is still the local place for direct assignment-emitter regression tests
- Add or modify focused Agency runtime test if local pattern prefers execution tests

- [ ] **Step 1: Write failing/safety tests**

Assert generated TS for:

```agency
optimize const prompt = "hi"
node main() { return prompt }
```

is equivalent to non-optimized `const prompt = "hi"`.

- [ ] **Step 2: Run RED or safety baseline**

```bash
pnpm test:run lib/backends/typescriptBuilder.integration.test.ts > /tmp/optimize-decl-codegen-red.log 2>&1
```

- [ ] **Step 3: Implement no-op behavior**

If assignment emitter already ignores unknown fields, no implementation change is needed. Otherwise, ensure it does not emit an `optimize` identifier.

- [ ] **Step 4: Run GREEN**

```bash
pnpm test:run lib/backends/typescriptBuilder.integration.test.ts > /tmp/optimize-decl-codegen-green.log 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder lib/backends/*.test.ts tests/agency
git commit -m "optimize: treat modifier as runtime no-op"
```

---

### Task 3: Discover optimize targets across local Agency import tree

**Files:**
- Create: `lib/optimize/targets.ts`
- Create: `lib/optimize/targets.test.ts`
- Modify: `lib/optimize/ast.ts` only to delete or leave legacy helpers unused later

- [ ] **Step 1: Write failing discovery tests**

Use temp directories with `.agency` files. Cover:

```ts
it("finds root, function-local, node-local, and imported optimize targets", () => {});
it("sorts targets by deterministic id", () => {});
it("skips std, pkg, js, ts, and bare imports", () => {});
it("handles import cycles once", () => {});
it("collapses duplicate import spellings by canonical path", () => {});
it("rejects nested-block optimize declarations", () => {});
it("rejects duplicate target ids", () => {});
it("rejects unsupported initializer values", () => {});
it("rejects legacy @optimize tags", () => {});
```

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/targets.test.ts > /tmp/optimize-targets-red.log 2>&1
```

- [ ] **Step 3: Implement target types**

In `lib/optimize/targets.ts`:

```ts
export type OptimizeTarget = {
  id: string;
  file: string;
  absoluteFile: string;
  scope: string;
  variable: string;
  valueKind: "string" | "multilineString";
  value: string;
};

export type OptimizeSourceFile = {
  file: string;
  absoluteFile: string;
  source: string;
  sha256: string;
};

export type OptimizeTargetSet = {
  baseDir: string;
  entryFile: string;
  files: Record<string, OptimizeSourceFile>;
  targets: OptimizeTarget[];
};
```

Do not expose AST nodes in long-lived public artifacts unless patching truly needs them. If patching needs parsed documents, keep them in an internal field not written to JSON.

- [ ] **Step 4: Implement traversal**

Parse each discovered file using the parse path that returns the user's literal AST **without** synthetic `std::*` import injection. (Confirm the right entrypoint by reading `parser.ts` / `parseAgency` — discovery must not recurse into stdlib.) Traverse import nodes for local relative `.agency` files only. Use a plain object of canonical absolute paths for visited files. Add a test that a root file with no explicit `std::` imports does not produce stdlib-derived targets.

- [ ] **Step 5: Implement target ID and scope detection**

Supported scopes:

- `global` for top-level assignments.
- function name for direct function-body assignments.
- node name for direct node-body assignments.

Reject optimized assignments discovered deeper than those direct bodies.

- [ ] **Step 6: Implement value extraction**

Accept only `value.type === "string"` or `"multiLineString"`. Convert segments to the user-facing string using the same interpolation rendering currently used by `lib/optimize/ast.ts`.

- [ ] **Step 7: Run GREEN**

```bash
pnpm test:run lib/optimize/targets.test.ts > /tmp/optimize-targets-green.log 2>&1
```

- [ ] **Step 8: Commit**

```bash
git add lib/optimize/targets.ts lib/optimize/targets.test.ts lib/optimize/ast.ts
git commit -m "optimize: discover declaration targets"
```

---

### Task 4: Add declarative optimize patch pipeline

**Files:**
- Create: `lib/optimize/patch.ts`
- Create: `lib/optimize/patch.test.ts`
- Modify: `lib/optimize/validation.ts`
- Modify: `lib/optimize/validation.test.ts`

- [ ] **Step 1: Write failing patch-plan tests**

Cover:

```ts
buildOptimizePatchPlan(targetSet, [{ id, value, rationale }]);
validateOptimizePatchPlan(plan);
applyOptimizePatchPlan(plan);
```

Assertions:

- Unknown target is rejected.
- Old value mismatch is rejected.
- New value must be non-empty string.
- Interpolation multiset is preserved with multiplicity.
- String and multiline initializers render valid Agency source.
- Result includes `files`, `changes`, and `diff`.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/patch.test.ts lib/optimize/validation.test.ts > /tmp/optimize-patch-red.log 2>&1
```

- [ ] **Step 3: Implement types and builder**

In `lib/optimize/patch.ts`:

```ts
export type OptimizeTargetChangeInput = { id: string; value: string; rationale: string };
export type OptimizePatchPlanChange = { id: string; oldValue: string; newValue: string; rationale: string };
export type OptimizePatchPlan = { targetSet: OptimizeTargetSet; changes: OptimizePatchPlanChange[] };
export type OptimizePatchResult = { files: Record<string, string>; changes: OptimizePatchPlanChange[]; diff: string };
```

- [ ] **Step 4: Implement validation**

Move prompt interpolation logic from `validateMutationPrompt()` into a reusable helper:

```ts
export function validateOptimizedStringValue(oldValue: string, newValue: string): ValidationResult;
```

- [ ] **Step 5: Implement application**

Use parsed AST + `AgencyGenerator` to render changed files. The plan does **not** fall back to source-slice replacement: `AgencyGenerator` preserves comments, and any reformatting of unrelated whitespace is acceptable because Agency source is expected to already be `agency format`'d before optimize runs. Mutate the relevant `Assignment` node's initializer (string or multiline string) and re-emit the entire file.

- [ ] **Step 6: Produce diffs**

Use an existing diff dependency if present in `package.json`; otherwise implement a small unified diff helper scoped to changed files. Do not add a new package just for basic diff output unless repo already uses one.

- [ ] **Step 7: Run GREEN**

```bash
pnpm test:run lib/optimize/patch.test.ts lib/optimize/validation.test.ts > /tmp/optimize-patch-green.log 2>&1
```

- [ ] **Step 8: Commit**

```bash
git add lib/optimize/patch.ts lib/optimize/patch.test.ts lib/optimize/validation.ts lib/optimize/validation.test.ts
git commit -m "optimize: apply target patch plans"
```

---

### Task 5: Change mutator to target-level input/output

**Files:**
- Modify: `lib/optimize/types.ts`
- Modify: `lib/optimize/mutator.ts`
- Modify: `lib/optimize/mutator.test.ts`
- Modify: `lib/agents/mutatePrompt.agency`

- [ ] **Step 1: Write failing mutator tests**

Assert the prompt/message includes sorted target IDs and values, suite goals in task ID order, and validation feedback. Assert parsed output shape:

```json
{
  "changes": [{ "id": "foo.agency:main:prompt", "value": "...", "rationale": "..." }],
  "rationale": "..."
}
```

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/mutator.test.ts > /tmp/optimize-mutator-targets-red.log 2>&1
```

- [ ] **Step 3: Update TS mutation types**

In `lib/optimize/types.ts`:

```ts
export type MutationProposal = {
  changes: { id: string; value: string; rationale: string }[];
  rationale: string;
};
```

- [ ] **Step 4: Update mutator message**

The mutator receives:

- overall intent from one goal or a deterministic suite goal summary,
- current target IDs/values,
- recent history,
- optional validation failure.

- [ ] **Step 5: Update Agency mutator schema**

In `lib/agents/mutatePrompt.agency`, define target input/change/mutation types and return the new shape. Keep correct Agency syntax (`type`, `node`, curly braces).

- [ ] **Step 6: Run GREEN**

```bash
pnpm test:run lib/optimize/mutator.test.ts > /tmp/optimize-mutator-targets-green.log 2>&1
```

- [ ] **Step 7: Commit**

```bash
git add lib/optimize/types.ts lib/optimize/mutator.ts lib/optimize/mutator.test.ts lib/agents/mutatePrompt.agency
git commit -m "optimize: mutate target-level changes"
```

---

### Task 6: Rewrite optimize artifacts for Agency file sets

**Files:**
- Modify: `lib/optimize/artifacts.ts`
- Modify: `lib/optimize/artifacts.test.ts`

- [ ] **Step 1: Write failing artifact tests**

Assert layout:

```text
runDir/targets.json
runDir/iter-0/agent/foo.agency
runDir/iter-1/agent/helpers/prompts.agency
runDir/iter-1/mutation.json
runDir/iter-1/mutation.md
runDir/iter-1/diff.patch
runDir/champion/agent/foo.agency
```

Also create a non-Agency file in the working dir and assert it is not copied.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/artifacts.test.ts > /tmp/optimize-artifacts-fileset-red.log 2>&1
```

- [ ] **Step 3: Remove broad workspace copying**

Delete `prepareWorkspace()` / `copyDirectory()` behavior from optimize artifacts. Replace with a helper that writes exactly `Record<relativeFile, source>` under `iter-N/agent/`.

- [ ] **Step 4: Write target and mutation artifacts**

Add methods:

```ts
writeTargets(targets: OptimizeTarget[]): string;
writeIterationAgent(iter: number, files: Record<string, string>): IterationArtifact;
writeMutation(iter: number, result: OptimizePatchResult, rationale: string): { mutationJsonPath: string; mutationMdPath: string; diffPath: string };
```

- [ ] **Step 5: Enforce run-dir collision**

Before creating `runDir`, throw if it exists.

- [ ] **Step 6: Run GREEN**

```bash
pnpm test:run lib/optimize/artifacts.test.ts > /tmp/optimize-artifacts-fileset-green.log 2>&1
```

- [ ] **Step 7: Commit**

```bash
git add lib/optimize/artifacts.ts lib/optimize/artifacts.test.ts
git commit -m "optimize: materialize Agency file artifacts"
```

---

### Task 7: Integrate discovery and patching into the optimize loop

**Files:**
- Modify: `lib/optimize/loop.ts`
- Modify: `lib/optimize/loop.test.ts`
- Modify: `lib/cli/eval/optimize.ts`

- [ ] **Step 1: Write failing loop tests**

Cover:

- no targets fails before baseline run,
- startup reporter prints every target,
- mutator receives all current target values,
- candidate writes all Agency files to `iter-N/agent/`,
- accepted candidate updates champion file set,
- rejected candidate leaves champion unchanged,
- writeback updates root and imported local files,
- writeback hash mismatch aborts all writes.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/loop.test.ts lib/cli/eval/optimize.test.ts > /tmp/optimize-loop-targets-red.log 2>&1
```

- [ ] **Step 3: Update loop config**

In `lib/optimize/types.ts`:

```ts
target: {
  entryFile: string;
  entryNode: string;
  workingDir: string;
  files: Record<string, string>;
  targets: OptimizeTarget[];
  writebackPaths?: Record<string, string>;
}
```

- [ ] **Step 4: Replace legacy tag validation**

Remove `validateOptimizeTarget()` / `findOptimizeTargets()` usage from `lib/optimize/ast.ts`. Use `discoverOptimizeTargets(entryFile, config)` at startup.

- [ ] **Step 5: Patch per iteration**

Loop flow:

```text
current target set from champion file set
propose target-level mutation
buildOptimizePatchPlan
validateOptimizePatchPlan
applyOptimizePatchPlan
write iter-N agent files
eval candidate
judge candidate
accept/reject whole patch set
```

- [ ] **Step 6: Implement multi-file writeback**

At run start, store:

1. SHA-256 of every discovered source file, and
2. the sorted set of discovered target IDs.

At writeback, re-read all files that would change. Abort before writing any file if **either**:

- any source-file hash differs, or
- re-running `discoverOptimizeTargets()` produces a different sorted target ID set than the snapshot.

This protects against external edits that introduce or remove `optimize` declarations mid-run, which would otherwise silently shift the target set on the next iteration.

- [ ] **Step 7: Run GREEN**

```bash
pnpm test:run lib/optimize/loop.test.ts lib/cli/eval/optimize.test.ts > /tmp/optimize-loop-targets-green.log 2>&1
```

- [ ] **Step 8: Commit**

```bash
git add lib/optimize/loop.ts lib/optimize/loop.test.ts lib/optimize/types.ts lib/cli/eval/optimize.ts lib/cli/eval/optimize.test.ts
git commit -m "optimize: drive loop from declaration targets"
```

---

### Task 8: Remove legacy `@optimize(...)` support, delete legacy CLI, update docs

**Files:**
- Delete: `lib/cli/optimize.ts` (the pre-refactor 307-line tag-based CLI that registered the old `agency optimize` top-level command)
- Modify: `scripts/agency.ts` (remove the registration of the legacy top-level `agency optimize` command — see "Command surface" note below)
- Modify/Delete: `lib/optimize/ast.ts`
- Modify/Delete: `lib/optimize/ast.test.ts`
- Delete: `runs/optimize/foo-smoke/` and any other stale fixture directories produced by the previous broad workspace-copy artifact layout
- Modify: `docs/site/cli/eval.md`
- Modify: any optimize docs that mention tags

**Command surface note:** We are **not** adding a new top-level `agency optimize` command. The only supported entrypoint is `agency eval optimize <file>[:<node>]`. Any existing top-level `agency optimize` registration in `scripts/agency.ts` must be removed in this task. Do not add a top-level alias.

- [ ] **Step 1: Grep legacy optimize tags and the legacy CLI**

```bash
grep -R "@optimize\|tagged prompt" -n lib docs tests stdlib scripts > /tmp/optimize-legacy-grep.log 2>&1 || true
grep -R "lib/cli/optimize\|from.*cli/optimize" -n lib scripts >> /tmp/optimize-legacy-grep.log 2>&1 || true
```

- [ ] **Step 2: Delete legacy CLI, ast helpers, and tests**

Delete `lib/cli/optimize.ts` and any imports of it. Remove the `program.command("optimize")` block from `scripts/agency.ts`. Move any useful interpolation/string tests into `patch.test.ts`; delete tag-target tests. Delete stale fixture dirs under `runs/optimize/`.

- [ ] **Step 3: Update diagnostics and docs**

Startup validation for legacy tags should fail with:

```text
`@optimize(...)` is no longer supported.
Mark the declaration to optimize instead, for example:

  optimize const prompt = "..."
```

- [ ] **Step 4: Run focused tests**

```bash
pnpm test:run lib/optimize/targets.test.ts lib/optimize/patch.test.ts lib/optimize/loop.test.ts > /tmp/optimize-legacy-removal-green.log 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add lib/optimize docs tests
git commit -m "optimize: remove legacy tag targets"
```

---

### Task 9: Update `stdlib/agency/eval.agency` `optimize()` wrapper to match new CLI semantics

Whenever the CLI surface changes, the stdlib must expose the same functionality so that users can build agents that call the optimizer from inside Agency. The current `optimize()` in `stdlib/agency/eval.agency` (lines 358–411) still describes the legacy `@optimize(prompt)` tag model and accepts a single `agentSource` string. This must be updated to match the declaration-modifier model.

**Files:**
- Modify: `stdlib/agency/eval.agency` — `optimize()` export and `OptimizeIterationResult` / `OptimizeResult` types
- Modify: `lib/stdlib/agencyEval.ts` (or wherever `_optimize` is bound) so the TS implementation matches the new signature
- Modify: `lib/stdlib/agencyEval.test.ts`
- Modify: `docs/site/stdlib/agency/eval.md` (regenerated via `agency doc` from updated docstrings)

- [ ] **Step 1: Decide stdlib boundary**

Per the spec §"Stdlib Boundary", choose one of:

1. Replace `agentSource: string` with `entryFile: string` and `workingDir: string`, mirroring the CLI exactly (preferred — supports multi-file imports).
2. Keep an `agentSource` overload but reject any source that contains non-empty local relative `.agency` imports (degraded single-file mode only).

Recommendation: choose option (1). If option (2) is selected, document the limitation in the docstring and emit a clear runtime error when local imports are detected.

- [ ] **Step 2: Update signature, types, and docstring**

Replace the `@optimize(prompt)` references with the declaration-modifier model. Remove `acceptThreshold` and `judgeSamples` from optimize-level options if the eval pipeline plan moves them onto judge policy — keep parameters that have no corresponding judge equivalent (`iterations`, `runsDir`, `runId`, `mutatorModel`, etc.). Add a brief example showing `optimize const prompt = "..."` in the docstring so generated docs are accurate.

- [ ] **Step 3: Update `_optimize` binding**

Match the new `OptimizeLoopConfig.target` shape (see Task 7). The binding should accept file paths and pass them straight through to `optimizeLoop()` without re-implementing target discovery in the stdlib layer.

- [ ] **Step 4: Update / add tests**

```bash
pnpm test:run lib/stdlib/agencyEval.test.ts > /tmp/optimize-stdlib-green.log 2>&1
```

- [ ] **Step 5: Rebuild stdlib**

```bash
make
```

- [ ] **Step 6: Commit**

```bash
git add stdlib/agency/eval.agency lib/stdlib/agencyEval.ts lib/stdlib/agencyEval.test.ts docs/site/stdlib/agency/eval.md
git commit -m "optimize: align stdlib optimize() with declaration-modifier model"
```

---

## Verification

- [ ] Run focused optimize declaration tests:

```bash
pnpm test:run \
  lib/parsers/assignment.test.ts \
  lib/parsers/exportConst.test.ts \
  lib/backends/agencyGenerator.test.ts \
  lib/optimize/targets.test.ts \
  lib/optimize/patch.test.ts \
  lib/optimize/validation.test.ts \
  lib/optimize/mutator.test.ts \
  lib/optimize/artifacts.test.ts \
  lib/optimize/loop.test.ts \
  lib/cli/eval/optimize.test.ts \
  > /tmp/optimize-declaration-modifier-v2-final.log 2>&1
```

- [ ] If stdlib optimize files are touched, run `make` per repo guidance for stdlib changes.
- [ ] Do not run the full agency test suite locally.
