# Declarative Optimize Mutator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a declarative source mutator that previews and applies optimize target operations by ID, starting with variable initializer replacement and reserving the operation shape for future optimized types.

**Architecture:** Consume `OptimizeTargetSet` from declaration-target discovery, validate operation records against the target catalog, render candidate Agency file sets with `AgencyGenerator`, and return target-level changes plus unified diffs. Keep the LLM proposal mutator separate: it proposes declarative operations; `OptimizeSourceMutator` applies them safely.

**Tech Stack:** TypeScript, Vitest, Agency parser/AST/generator, `lib/optimize/targets.ts`, `lib/optimize/validation.ts`, existing optimize mutator wrapper and artifact pipeline.

---

## Source spec

Spec: `docs/superpowers/specs/2026-06-11-declarative-optimize-mutator-design.md`

Prerequisites:

- `docs/superpowers/plans/2026-06-11-optimize-declaration-modifier-v2.md`

Follow-up consumers:

- `docs/superpowers/plans/2026-06-11-optimize-refactored-eval-pipeline.md`

## File structure

### Create

- `lib/optimize/sourceMutator.ts`
  - Owns declarative operation types, `OptimizeSourceMutator`, `preview()`, `apply()`, `mutate()` shorthand, context-specific validation, AST replacement, full candidate file rendering, and unified diff output.
- `lib/optimize/sourceMutator.test.ts`
  - Unit tests for operation validation, variable initializer replacement, atomicity, diff output, shorthand behavior, and reserved type-operation rejection.

### Modify

- `lib/optimize/validation.ts`
  - Generalize interpolation validation for optimized string values.
- `lib/optimize/validation.test.ts`
  - Focused interpolation and value-domain tests shared by source mutator and the existing prompt optimizer migration.
- `lib/optimize/types.ts`
  - Export mutation proposal types as declarative operations if this is the shared optimize type module.
- `lib/optimize/mutator.ts`
  - Convert LLM mutation proposal output to declarative operations; do not apply source edits here.
- `lib/optimize/mutator.test.ts`
  - Assert the LLM mutator emits operation records and passes validation diagnostics back into retry prompts.
- `lib/agents/mutatePrompt.agency`
  - Update the bundled mutation agent schema to return target operation records while preserving correct Agency syntax.

## Implementation notes

- The source mutator consumes a previously discovered `OptimizeTargetSet`; it does not discover targets by walking files itself.
- V1 supports only `{ kind: "variable", op: "replaceInitializer" }`.
- `mutate(id, value)` is sugar over the operation API and infers the operation from the discovered target kind.
- Top-level variable IDs use `global`, e.g. `foo.agency:global:systemPrompt`.
- `kind: "type"` / `op: "replaceTypeDefinition"` should be represented in the type union but rejected in v1 with a clear unsupported-operation diagnostic.
- Replacement `value` is Agency source text in the target's syntactic context. For variables, include the string quotes: `"\"new prompt\""`.
- Use parsed AST plus `AgencyGenerator`; do not use blind source-slice replacement.
- Reformatting changed Agency files is acceptable. The full candidate file set should include unchanged discovered Agency files.
- Multiple operations for the same target in one batch are rejected.
- Preview/apply is atomic: any invalid operation prevents all file changes.

---

### Task 1: Add source mutator operation types and validation skeleton

**Files:**
- Create: `lib/optimize/sourceMutator.ts`
- Create: `lib/optimize/sourceMutator.test.ts`
- Modify: `lib/optimize/types.ts` if shared exports belong there after reading current optimize type conventions

- [ ] **Step 1: Write failing operation validation tests**

In `lib/optimize/sourceMutator.test.ts`, build a minimal `OptimizeTargetSet` fixture with:

```ts
{
  id: "foo.agency:bar:prompt",
  kind: "variable",
  file: "foo.agency",
  scope: "bar",
  name: "prompt",
  valueKind: "string",
  value: "xyz",
}
```

Add tests that assert diagnostics for:

- unknown target,
- kind mismatch,
- unsupported operation,
- duplicate operations for the same target,
- stale `expected` value,
- reserved `kind: "type"` operation in v1.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/sourceMutator.test.ts > /tmp/optimize-source-mutator-types-red.log 2>&1
```

- [ ] **Step 3: Implement operation and diagnostic types**

In `lib/optimize/sourceMutator.ts`:

```ts
export type ReplaceVariableInitializerOperation = {
  target: string;
  kind: "variable";
  op: "replaceInitializer";
  value: string;
  expected?: string;
  rationale?: string;
};

export type ReplaceTypeDefinitionOperation = {
  target: string;
  kind: "type";
  op: "replaceTypeDefinition";
  value: string;
  expected?: string;
  rationale?: string;
};

export type OptimizeMutationOperation = ReplaceVariableInitializerOperation | ReplaceTypeDefinitionOperation;
```

Add `OptimizeMutationDiagnostic`, `OptimizeAppliedChange`, and `OptimizeMutationPreview` types matching the spec. If `lib/optimize/types.ts` already centralizes optimize public types, re-export from there rather than duplicating definitions.

- [ ] **Step 4: Implement validation skeleton**

Add `new OptimizeSourceMutator({ targetSet })` and internal operation validation that returns diagnostics without changing files yet.

- [ ] **Step 5: Run GREEN**

```bash
pnpm test:run lib/optimize/sourceMutator.test.ts > /tmp/optimize-source-mutator-types-green.log 2>&1
```

- [ ] **Step 6: Commit**

```bash
git add lib/optimize/sourceMutator.ts lib/optimize/sourceMutator.test.ts lib/optimize/types.ts
git commit -m "optimize: define declarative source mutation operations"
```

---

### Task 2: Generalize optimized string validation

**Files:**
- Modify: `lib/optimize/validation.ts`
- Modify: `lib/optimize/validation.test.ts`
- Modify: `lib/optimize/sourceMutator.ts`
- Modify: `lib/optimize/sourceMutator.test.ts`

- [ ] **Step 1: Write failing interpolation validation tests**

Cover:

- unchanged interpolation placeholder passes,
- reordered placeholders pass if multiset is equal,
- duplicate placeholders preserve multiplicity,
- missing placeholder fails,
- added placeholder fails,
- semantically equivalent placeholder formatting compares by canonical rendered expression if an existing parser helper supports this.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/validation.test.ts lib/optimize/sourceMutator.test.ts > /tmp/optimize-source-mutator-validation-red.log 2>&1
```

- [ ] **Step 3: Extract reusable validation helper**

Move existing prompt interpolation logic into:

```ts
export function validateOptimizedStringValue(oldValue: string, newValue: string): ValidationResult;
```

Read `lib/optimize/validation.ts` before editing and preserve its local result type/style. If the current helper uses a different `ValidationResult` shape, adapt the function signature to the existing convention rather than introducing a second result type.

- [ ] **Step 4: Call helper from source mutator validation**

`replaceInitializer` should reject interpolation mismatches before rendering candidate files.

- [ ] **Step 5: Run GREEN**

```bash
pnpm test:run lib/optimize/validation.test.ts lib/optimize/sourceMutator.test.ts > /tmp/optimize-source-mutator-validation-green.log 2>&1
```

- [ ] **Step 6: Commit**

```bash
git add lib/optimize/validation.ts lib/optimize/validation.test.ts lib/optimize/sourceMutator.ts lib/optimize/sourceMutator.test.ts
git commit -m "optimize: validate optimized string replacements"
```

---

### Task 3: Preview variable initializer replacements and diffs

**Files:**
- Modify: `lib/optimize/sourceMutator.ts`
- Modify: `lib/optimize/sourceMutator.test.ts`

- [ ] **Step 1: Write failing preview tests**

Use parser-backed target sets with source files. Cover:

```agency
def bar() {
  optimize const prompt = "xyz"
  const result = llm(prompt)
}
```

and:

```agency
optimize static const systemPrompt = "old"
```

Assert `preview()`:

- replaces only the initializer expression,
- preserves `optimize` and `static`,
- includes changed and unchanged discovered Agency files in `files`,
- includes target-level `changes`,
- includes a unified `diff`,
- returns no files when validation fails.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/sourceMutator.test.ts > /tmp/optimize-source-mutator-preview-red.log 2>&1
```

- [ ] **Step 3: Parse replacement values in expression context**

For `replaceInitializer`, parse `operation.value` as an Agency expression/initializer. Reject valid TypeScript but invalid Agency source. Reject non-string/non-multiline-string expression AST nodes in v1.

- [ ] **Step 4: Replace AST nodes and render files**

Use the parsed document references retained by `OptimizeTargetSet`. If `OptimizeTargetSet` intentionally omits AST nodes from public artifacts, keep parsed documents in an internal/non-serialized field for source mutator use. Render changed files with `AgencyGenerator`.

- [ ] **Step 5: Produce unified diffs**

Use an existing diff helper/dependency if present in `package.json`; otherwise add a tiny file-scoped unified diff helper inside `sourceMutator.ts`. Do not add a new package solely for basic diff output unless the repo already uses one.

- [ ] **Step 6: Run GREEN**

```bash
pnpm test:run lib/optimize/sourceMutator.test.ts > /tmp/optimize-source-mutator-preview-green.log 2>&1
```

- [ ] **Step 7: Commit**

```bash
git add lib/optimize/sourceMutator.ts lib/optimize/sourceMutator.test.ts
git commit -m "optimize: preview source mutation candidates"
```

---

### Task 4: Add apply and mutate shorthand

**Files:**
- Modify: `lib/optimize/sourceMutator.ts`
- Modify: `lib/optimize/sourceMutator.test.ts`

- [ ] **Step 1: Write failing apply/shorthand tests**

Cover:

- `mutate("foo.agency:bar:prompt", "\"new\"")` infers `replaceInitializer`,
- shorthand rejects unsupported target kinds,
- `apply(preview, destination)` writes candidate files under the destination directory preserving relative paths,
- `apply(preview)` either returns the preview unchanged or writes according to the existing local API convention chosen after reading nearby optimize artifact writers,
- apply never runs if preview contains diagnostics.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/sourceMutator.test.ts > /tmp/optimize-source-mutator-apply-red.log 2>&1
```

- [ ] **Step 3: Implement shorthand and apply**

Keep `mutate(id, value)` as a thin wrapper:

```ts
return this.preview([{ target: id, kind: target.kind, op: inferredOp, value }]);
```

For destination writes, use the repo's existing fs helper style. Create parent directories as needed and write only files from the preview file set.

- [ ] **Step 4: Run GREEN**

```bash
pnpm test:run lib/optimize/sourceMutator.test.ts > /tmp/optimize-source-mutator-apply-green.log 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/sourceMutator.ts lib/optimize/sourceMutator.test.ts
git commit -m "optimize: apply declarative source mutation previews"
```

---

### Task 5: Make the LLM mutator emit declarative operations

**Files:**
- Modify: `lib/optimize/types.ts`
- Modify: `lib/optimize/mutator.ts`
- Modify: `lib/optimize/mutator.test.ts`
- Modify: `lib/agents/mutatePrompt.agency`

- [ ] **Step 1: Write failing LLM mutator tests**

Assert the prompt/message includes sorted target IDs, target kinds, current values, suite goals in task ID order, recent history, and validation diagnostics from a prior rejected preview.

Assert parsed output shape uses operation records:

```json
{
  "operations": [
    {
      "target": "foo.agency:bar:prompt",
      "kind": "variable",
      "op": "replaceInitializer",
      "value": "\"new prompt\"",
      "rationale": "The new prompt matches the goal."
    }
  ],
  "rationale": "Updated the main prompt."
}
```

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/mutator.test.ts > /tmp/optimize-llm-mutator-operations-red.log 2>&1
```

- [ ] **Step 3: Update TS mutation proposal types**

In the shared optimize type module, use the operation union from `sourceMutator.ts`:

```ts
export type MutationProposal = {
  operations: OptimizeMutationOperation[];
  rationale: string;
};
```

Avoid duplicating a separate `{ id, value }` change shape.

- [ ] **Step 4: Update mutator prompt and parser**

The LLM mutator proposes operations only. It must not call source mutation helpers, render files, or produce diffs.

- [ ] **Step 5: Update Agency mutator schema**

In `lib/agents/mutatePrompt.agency`, define operation/proposal types with correct Agency syntax. Example shape:

```agency
type OptimizeMutationOperation = {
  target: string;
  kind: string;
  op: string;
  value: string;
  rationale: string;
}

type OptimizeMutationProposal = {
  operations: OptimizeMutationOperation[];
  rationale: string;
}
```

Keep the schema stringly typed if Agency union literal support is insufficient; TypeScript validation will enforce allowed `kind`/`op` values.

- [ ] **Step 6: Run GREEN**

```bash
pnpm test:run lib/optimize/mutator.test.ts lib/optimize/sourceMutator.test.ts > /tmp/optimize-llm-mutator-operations-green.log 2>&1
```

- [ ] **Step 7: Commit**

```bash
git add lib/optimize/types.ts lib/optimize/mutator.ts lib/optimize/mutator.test.ts lib/agents/mutatePrompt.agency
git commit -m "optimize: propose declarative mutation operations"
```

---

### Task 6: Integrate source mutator previews with optimize artifacts

**Files:**
- Modify: `lib/optimize/artifacts.ts`
- Modify: `lib/optimize/artifacts.test.ts`
- Modify: `lib/optimize/sourceMutator.ts` only if preview metadata needs a small adjustment

- [ ] **Step 1: Write failing artifact tests**

Assert an `OptimizeMutationPreview` can be written as:

```text
iter-1/agent/foo.agency
iter-1/mutation.json
iter-1/mutation.md
iter-1/diff.patch
```

`mutation.json` should record operation-level and target-level details, including `target`, `kind`, `op`, `oldValue`, `newValue`, and `rationale`.

- [ ] **Step 2: Run RED**

```bash
pnpm test:run lib/optimize/artifacts.test.ts lib/optimize/sourceMutator.test.ts > /tmp/optimize-source-mutator-artifacts-red.log 2>&1
```

- [ ] **Step 3: Add artifact writer methods**

Read the current `OptimizeArtifacts` API before naming helpers. Add or adapt methods equivalent to:

```ts
writeIterationAgent(iter: number, files: Record<string, string>): IterationArtifact;
writeMutationPreview(iter: number, preview: OptimizeMutationPreview): MutationArtifact;
```

Keep artifact writing separate from source mutator validation/application.

- [ ] **Step 4: Run GREEN**

```bash
pnpm test:run lib/optimize/artifacts.test.ts lib/optimize/sourceMutator.test.ts > /tmp/optimize-source-mutator-artifacts-green.log 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add lib/optimize/artifacts.ts lib/optimize/artifacts.test.ts lib/optimize/sourceMutator.ts
git commit -m "optimize: write declarative mutation artifacts"
```

---

## Verification

- [ ] Run focused source mutator tests:

```bash
pnpm test:run \
  lib/optimize/sourceMutator.test.ts \
  lib/optimize/validation.test.ts \
  lib/optimize/mutator.test.ts \
  lib/optimize/artifacts.test.ts \
  > /tmp/declarative-optimize-mutator-final.log 2>&1
```

- [ ] If `lib/agents/mutatePrompt.agency` or stdlib Agency files are changed, run `make` per repo guidance.
- [ ] Do not run the full agency test suite locally.
