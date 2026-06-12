# Optimize Declaration Modifier V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace legacy `@optimize(...)` prompt tags with an `optimize` declaration modifier and deterministic multi-file target discovery/cataloging for local Agency import trees.

**Architecture:** Add parser/formatter support for `optimize` on variable declarations, ignore the modifier at runtime, and discover marked string declarations across the root file plus local `.agency` imports. This plan produces the target catalog contract consumed by `docs/superpowers/plans/2026-06-11-declarative-optimize-mutator.md`; it does not implement the declarative source-editing API itself.

**Tech Stack:** TypeScript, tarsec parser combinators, Agency AST/generator, TypeScript builder, Vitest, `lib/optimize/targets.ts`.

---

## Source spec

Spec: `docs/superpowers/specs/2026-06-10-optimize-declaration-modifier-design.md`

This plan supersedes `docs/superpowers/plans/2026-06-10-optimize-declaration-modifier.md` where that older plan assumes the pre-refactor optimize loop or `rubric` task terminology.

## File structure

### Create

- `lib/optimize/targets.ts`
  - Discovers `assignment.optimize === true` in the root file and local relative `.agency` import tree.
  - Owns target IDs, target catalog entries, source file hashes, import traversal, nested-block rejection, legacy tag rejection, supported value validation, duplicate ID checks, and sorted target output.
- `lib/optimize/targets.test.ts`
  - Parser-backed tests for discovery, local imports, cycles, skipped imports, duplicate IDs, unsupported values, nested declarations, deterministic sorting, catalog shape, and legacy tag rejection.

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
- `scripts/agency.ts`
  - Remove legacy top-level `agency optimize` registration if it still exists; do not add a replacement top-level alias.
- `docs/site/cli/eval.md`
  - Remove `@optimize(...)` examples.

## Implementation notes

- V1 supports only optimized declarations at top level, directly inside a function body, or directly inside a node body.
- Supported value domains are string literal and multiline string literal only.
- Target ID format for variables is `<relative-file>:<scope>:<variable>` using POSIX separators. The base directory is the CWD from which the CLI was invoked (where the user typed `agency eval optimize foo.agency`), not the CLI install directory.
- Top-level optimized variables use scope `global`, e.g. `foo.agency:global:systemPrompt`. Use `global` for both ordinary top-level and `static` variables; Agency cannot have a static and global variable with the same name.
- The target catalog reserves `kind: "type"` and top-level type IDs of the form `<relative-file>:<type-name>` for future `optimize type` support, but this plan implements only `kind: "variable"` targets.
- Discovery follows only local relative `.agency` imports. Skip `std::`, `pkg::`, JS/TS, and bare imports.
- Targets are sorted by ID everywhere.
- Declarative mutation, candidate materialization, diffs, and writeback are owned by `docs/superpowers/plans/2026-06-11-declarative-optimize-mutator.md` and the refactored eval pipeline plan.
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
  kind: "variable";
  file: string;
  absoluteFile: string;
  scope: string;
  name: string;
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

Every target entry must include `kind: "variable"`, `file`, `scope`, `name`, `valueKind`, and `value`. Use `name`, not `variable`, so the catalog can later share a common shape with `kind: "type"` entries.

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

### Task 4: Remove legacy `@optimize(...)` support, delete legacy CLI, update docs

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

Delete `lib/cli/optimize.ts` and any imports of it. Remove the `program.command("optimize")` block from `scripts/agency.ts`. Move any useful legacy tag-detection tests into `targets.test.ts`; leave interpolation/string replacement tests for the declarative mutator plan. Delete stale fixture dirs under `runs/optimize/`.

- [ ] **Step 3: Update diagnostics and docs**

Startup validation for legacy tags should fail with:

```text
`@optimize(...)` is no longer supported.
Mark the declaration to optimize instead, for example:

  optimize const prompt = "..."
```

- [ ] **Step 4: Run focused tests**

```bash
pnpm test:run lib/optimize/targets.test.ts lib/cli/eval/optimize.test.ts > /tmp/optimize-legacy-removal-green.log 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add lib/cli/optimize.ts scripts/agency.ts lib/optimize/ast.ts lib/optimize/ast.test.ts docs/site/cli/eval.md runs/optimize
git commit -m "optimize: remove legacy tag targets"
```

---

### Task 5: Update `stdlib/agency/eval.agency` `optimize()` wrapper to match new CLI semantics

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

Replace the `@optimize(prompt)` references with the declaration-modifier model. Remove `acceptThreshold` and `judgeSamples` from optimize-level options if the eval pipeline plan moves them onto judge policy — keep parameters that have no corresponding judge equivalent (`iterations`, `runsDir`, `runId`, `mutatorModel`, etc.). Add a brief example showing `optimize const prompt = "..."` in the docstring so generated docs are accurate. Do not document a top-level `agency optimize` command.

- [ ] **Step 3: Update `_optimize` binding**

Match the `OptimizeLoopConfig.target` shape from the refactored eval pipeline plan. The binding should accept file paths and pass them straight through to `optimizeLoop()` without re-implementing target discovery in the stdlib layer.

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
  lib/cli/eval/optimize.test.ts \
  > /tmp/optimize-declaration-modifier-v2-final.log 2>&1
```

Patch, mutator, artifact, and loop verification are covered by the declarative mutator and refactored eval pipeline plans.

- [ ] If stdlib optimize files are touched, run `make` per repo guidance for stdlib changes.
- [ ] Do not run the full agency test suite locally.
