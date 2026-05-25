# Generics Follow-Ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tie up three loose ends left after the generics PR (#171) was merged:

1. **Fully remove the `object` primitive** from the parser and type checker. It was already removed from docs / stdlib in PR #171, but the parser still accepts it and the checker still has special-case branches for it.
2. **Replace the exported-generic-alias runtime stub with proper type-only import skipping.** Today, every exported `type Container<T> = ...` emits `export const Container = undefined;` so downstream `import { Container }` doesn't crash at runtime. A cleaner fix is to detect that the imported name is a *type-only* symbol and skip the runtime import (or the runtime import binding) entirely.
3. **Add dedicated regression tests** for the two fixes that landed in PR #171 without targeted coverage: the pipe-chain `zodSchemaFor` routing and the exported-generic-alias cross-module path.

**Architecture:** Each follow-up is independent — they can be implemented in any order and reviewed separately. The work is small (`<200` lines per follow-up) and uses existing infrastructure (parser, `SymbolTable` lookups, vitest fixtures, agency tests).

**Spec:** none — implementation is straightforward enough to skip a separate spec doc. The PR #171 thread is the design context: <https://github.com/egonSchiele/agency-lang/pull/171>.

---

## Key Risks and Gotchas

1. **Removing `object` is a breaking change.** Any user code that still has `: object` annotations will fail to parse. Mitigation: search the repo for residual uses first (`rg "\b: object\b" tests/ examples/ stdlib/`), migrate them to `Record<string, any>`, and call this out clearly in the commit message. The user docs already say `Record<string, any>` is the way.

2. **Removing the `object` primitive frees the identifier.** A user could legitimately write `type object = ...` after the change. That's almost certainly an accident, but it's not the parser's job to forbid it. Document this in the commit message and move on.

3. **`processNode` paths still mention "object" for the `Record<string, any>` lowering** in [typescriptBuilder.ts:1257](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptBuilder.ts#L1257) and [:2415](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptBuilder.ts#L2415). Those are unrelated — they're zod method names (`.prop("object")` is a builder call). Don't touch them.

4. **Type-only import skipping must not break re-exports.** Re-exporting a generic alias (`export { Container } from "./a"`) needs to keep working. The cleanest way is to filter the import *binding list* (drop names that resolve to a type symbol with `typeParams`) rather than skipping whole import statements. If the resulting binding list is empty, drop the whole `import { } from "..."` statement.

5. **Cross-module symbol lookup at codegen-time.** The TS builder already consults `SymbolTable` for re-export resolution ([resolveReExports.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/preprocessors/resolveReExports.ts)). Reuse the same lookup path rather than crawling files yourself.

6. **Pipe-chain validation regression test needs the deep-resolve path.** A test that just uses a non-generic validated pipe (`x!: number = a |> f`) wouldn't catch a regression in the `zodSchemaFor` routing — that would silently still work via the old direct `mapTypeToValidationSchema` call. The test must use a *generic alias* in the validated type position.

---

## File Structure

**New files:**
- `lib/backends/typescriptBuilder/pipeChainGenerics.test.ts` — focused regression test for the pipe-chain `zodSchemaFor` deep-resolve.
- `lib/backends/typescriptBuilder/typeAliasExportStub.test.ts` — focused test for the type-only import skipping (after Follow-Up 2) or the runtime stub emission (before).

**Files modified:**

| File | Purpose |
|------|---------|
| `lib/parsers/parsers.ts` | Remove `str("object")` from `primitiveTypeParser`'s `or(...)` list |
| `lib/typeChecker/assignability.ts` | Remove the two `value === "object"` branches in `isAssignable` |
| `lib/backends/typescriptGenerator/typeToZodSchema.ts` | Remove the `case "object":` arm in `mapTypeToSchema` |
| `lib/backends/typescriptGenerator/typeToString.ts` | Remove the `value === "object"` branch |
| `lib/typeChecker/primitives.ts` | (if there is an `OBJECT_T` constant) remove it |
| `lib/backends/typescriptBuilder.ts` | Filter generic-alias names out of import binding lists (Follow-Up 2) |
| `lib/backends/typescriptBuilder.ts` (`processTypeAlias`) | Drop the `export const Container = undefined;` stub (Follow-Up 2) |
| Possibly `lib/preprocessors/resolveReExports.ts` | Same filtering for re-exports |
| Possibly a couple of integration `.mjs` fixtures | Re-generated via `make fixtures` after the stub is removed |

---

## Follow-Up 1: Remove the `object` primitive

**Files:**
- Modify: `lib/parsers/parsers.ts`, `lib/typeChecker/assignability.ts`, `lib/backends/typescriptGenerator/typeToZodSchema.ts`, `lib/backends/typescriptGenerator/typeToString.ts`, possibly `lib/typeChecker/primitives.ts`

- [ ] **Step 1: Inventory residual uses**

Run (from `packages/agency-lang`):

```bash
rg -n '\b: object\b|\b: object,|\b: object;|\bvalue: "object"' lib/ tests/ examples/ stdlib/
```

For every `.agency` hit, migrate `: object` → `: Record<string, any>`. There should be no remaining `.agency` hits after PR #171, but verify before touching the parser.

For every `.ts` hit *outside* the four files listed in the table above, decide case-by-case whether it's a real reference (delete) or unrelated (e.g. `.prop("object")` zod builder methods — keep).

- [ ] **Step 2: Drop `str("object")` from `primitiveTypeParser`**

In [lib/parsers/parsers.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/parsers.ts) around line 682, remove the `str("object"),` line from the `or(...)` chain.

- [ ] **Step 3: Drop the `object` arm from the zod mapper**

In [lib/backends/typescriptGenerator/typeToZodSchema.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptGenerator/typeToZodSchema.ts), remove `case "object": return "z.record(z.string(), z.any())";`.

- [ ] **Step 4: Drop the `object` arm from `typeToString`**

In [lib/backends/typescriptGenerator/typeToString.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptGenerator/typeToString.ts), remove the `value === "object"` branch.

- [ ] **Step 5: Drop the `object`-special-cases in `isAssignable`**

In [lib/typeChecker/assignability.ts:439](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/typeChecker/assignability.ts#L439) and [:458](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/typeChecker/assignability.ts#L458), remove the `resolvedTarget.value === "object"` / `resolvedSource.value === "object"` branches. With `object` no longer in the language, no input to `isAssignable` can hit them.

- [ ] **Step 6: Add a parser test that rejects `object` as a primitive**

Add to [lib/parsers/typeHints.test.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/parsers/typeHints.test.ts):

```typescript
it("does NOT recognize `object` as a primitive type", () => {
  // After the v0.3 cleanup, `object` is just an identifier — it parses as a
  // typeAliasVariable, not a primitiveType.
  const result = primitiveTypeParser("object");
  // Either the parse fails outright or it leaves `object` unconsumed.
  // Pick whichever your `primitiveTypeParser` semantics imply.
  expect(result.success).toBe(false);
});

it("still accepts `Record<string, any>` as the replacement form", () => {
  const result = variableTypeParser("Record<string, any>");
  expect(result.success).toBe(true);
});
```

- [ ] **Step 7: Verify**

```bash
npx tsc --noEmit
pnpm run lint:structure
pnpm test:run > /tmp/run1.log 2>&1
make
```

Any failing test is almost certainly a fixture that still uses `: object` — migrate it to `Record<string, any>` and re-run `make fixtures`.

**Acceptance:**
- `rg ": object\b" lib/ tests/ examples/ stdlib/` returns nothing.
- New parser test passes.
- Full test suite still green, possibly after migrating a stray fixture.

---

## Follow-Up 2: Replace exported-generic-alias runtime stub with type-only import skipping

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts`
- Possibly modify: `lib/preprocessors/resolveReExports.ts`
- Regenerate: any integration `.mjs` fixtures that change

- [ ] **Step 1: Confirm the current behavior**

Skim [lib/backends/typescriptBuilder.ts:582-604](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptBuilder.ts#L582-L604) (`processTypeAlias`) and [:1057](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/backends/typescriptBuilder.ts#L1057) (`processImportStatement`). Today:
- `processTypeAlias` returns `export const Container = undefined;` for an exported generic alias.
- `processImportStatement` emits `import { Container } from "./a.js"` regardless of whether `Container` resolves to a generic alias.

The result is a runtime-noop `undefined` that just keeps the import from crashing. We can do better.

- [ ] **Step 2: Add a `SymbolTable` helper for "is this exported name a generic alias?"**

In [lib/symbolTable.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/lib/symbolTable.ts), add a small helper:

```typescript
/**
 * True if the given exported name on the given module resolves to a generic
 * type alias (has `typeParams`). Used by codegen to drop type-only imports
 * that have no runtime value.
 */
export function isGenericTypeExport(
  table: SymbolTable,
  modulePath: string,
  exportedName: string,
): boolean {
  const sym = table.lookupExport(modulePath, exportedName);
  return sym?.kind === "type" && (sym.typeParams?.length ?? 0) > 0;
}
```

Reuse whatever module / re-export lookup `resolveReExports` already uses. Don't roll a second one.

- [ ] **Step 3: Filter generic-alias names out of import binding lists in codegen**

In `processImportStatement`, partition the bindings into "runtime" vs "type-only generic" using the new helper. Emit the import only for the runtime bindings; drop the import statement entirely if the runtime list ends up empty.

- [ ] **Step 4: Drop the runtime stub in `processTypeAlias`**

Now that no downstream module emits an import binding for a generic alias, the stub is dead code. In `processTypeAlias`, change:

```typescript
if (node.typeParams && node.typeParams.length > 0) {
  if (!node.exported) return ts.empty();
  return ts.raw(`export const ${node.aliasName} = undefined;`);
}
```

to:

```typescript
if (node.typeParams && node.typeParams.length > 0) return ts.empty();
```

- [ ] **Step 5: Regenerate any fixtures that change**

```bash
make fixtures
```

Likely affected fixtures: anything that exports a generic alias (search `tests/typescriptGenerator/` for `export type` followed by `<`). The generic-alias validation fixture from PR #171 (`genericAliasValidation.mjs`) is the most obvious candidate.

- [ ] **Step 6: Verify with the existing cross-module agency test**

```bash
pnpm run agency test tests/agency/imports/genericContainerImport.agency
```

This is the same test that exercised the stub before — it must still pass after the stub is removed.

- [ ] **Step 7: Verify the full suite**

```bash
npx tsc --noEmit
pnpm run lint:structure
pnpm test:run > /tmp/run2.log 2>&1
```

**Acceptance:**
- The cross-module agency test still passes.
- No exported `const X = undefined;` lines remain in any generated `.mjs` fixture.
- A search for `= undefined;` in the codegen output of `genericAliasValidation.mjs` returns nothing.
- Re-exports of non-generic aliases still work (verify with [tests/agency/imports/typeImport.agency](file:///Users/adityabhargava/agency-lang/packages/agency-lang/tests/agency/imports/typeImport.agency)).

---

## Follow-Up 3: Targeted regression tests for the PR #171 fixes

**Files:**
- New: `lib/backends/typescriptBuilder/pipeChainGenerics.test.ts`
- New (or extend existing): `lib/backends/typescriptBuilder/typeAliasExportStub.test.ts`

Note: pick test paths that match this repo's conventions. The existing
`pipeReceiverCodegen.test.ts` neighbour is a good template.

- [ ] **Step 1: Test the pipe-chain `zodSchemaFor` deep-resolve**

Reproduce the scenario the PR #171 fix addressed: a validated pipe assignment whose declared type is a user-defined generic alias. Before the fix, codegen called `mapTypeToValidationSchema` directly and crashed on the unresolved generic.

In `pipeChainGenerics.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseAgency } from "../../parser.js";
import { generateTypeScript } from "../typescriptGenerator.js";

describe("pipe-chain validated assignments with generic alias types", () => {
  it("emits a concrete zod schema, not an unresolved generic name", () => {
    const src = `
type Container<T> = { value: T }

def wrap(n: number): Container<number> {
  return { value: n }
}

node main() {
  let c!: Container<number> = 41 |> wrap
  print(c.value)
}
`;
    const ast = parseAgency(src, {}, false);
    expect(ast.success).toBe(true);
    if (!ast.success) return;

    // Codegen must not throw "Unresolved generic type at codegen: Container".
    let generated: string;
    expect(() => {
      generated = generateTypeScript(ast.result, undefined, undefined, "pipe.agency");
    }).not.toThrow();

    // The validation step must emit a concrete z.object(...) for the
    // Container<number> body, not the bare alias name.
    expect(generated!).toMatch(/z\.object\(\{\s*"value":\s*z\.number\(\)\s*\}\)/);
    expect(generated!).not.toMatch(/__validateType\([^,]+,\s*Container\b/);
  });
});
```

- [ ] **Step 2: Test the exported-generic-alias cross-module emission**

Before Follow-Up 2:

```typescript
import { describe, it, expect } from "vitest";
import { parseAgency } from "../../parser.js";
import { generateTypeScript } from "../typescriptGenerator.js";

describe("exported generic type aliases", () => {
  it("emits a runtime stub so cross-module imports resolve at runtime", () => {
    const src = `export type Container<T> = { value: T }\n`;
    const ast = parseAgency(src, {}, false);
    expect(ast.success).toBe(true);
    if (!ast.success) return;
    const out = generateTypeScript(ast.result, undefined, undefined, "container.agency");
    expect(out).toMatch(/export const Container = undefined;/);
  });

  it("does NOT emit a runtime stub for a non-exported generic alias", () => {
    const src = `type Container<T> = { value: T }\n`;
    const ast = parseAgency(src, {}, false);
    expect(ast.success).toBe(true);
    if (!ast.success) return;
    const out = generateTypeScript(ast.result, undefined, undefined, "container.agency");
    expect(out).not.toMatch(/Container = undefined/);
  });
});
```

After Follow-Up 2 lands, replace the first test's expectation: the stub should be gone, and a separate test should assert that an importing module's generated code no longer contains `import { Container } from "..."` for a generic-alias binding.

- [ ] **Step 3: Verify**

```bash
pnpm test:run lib/backends/typescriptBuilder/pipeChainGenerics.test.ts lib/backends/typescriptBuilder/typeAliasExportStub.test.ts
```

Both files green. Full suite still green:

```bash
pnpm test:run > /tmp/run3.log 2>&1
```

**Acceptance:**
- The pipe-chain test fails if `PipeChainEmitter.expand` is reverted to call `mapTypeToValidationSchema` directly.
- The stub test (or its post-Follow-Up-2 successor) fails if `processTypeAlias` reverts to skipping all generic-alias emission unconditionally.

---

## Combined Verification

After all three follow-ups land:

```bash
make
pnpm test:run > /tmp/full.log 2>&1
npx tsc --noEmit
pnpm run lint:structure
```

And spot-check the cross-module agency test, which exercises Follow-Ups 1 + 2 end-to-end:

```bash
pnpm run agency test tests/agency/imports/genericContainerImport.agency
```

---

## Ordering Notes

- **Follow-Up 1** is independent and can ship first.
- **Follow-Up 2** is independent and can ship second (or in parallel).
- **Follow-Up 3** depends on the final state of #2 — write the regression test after the stub is gone if you do them together, or write it against today's behavior and update it as part of #2 if you do them separately.

Suggested ordering: 1 → 3 (current-behavior tests against the stub) → 2 (update test in same commit).
