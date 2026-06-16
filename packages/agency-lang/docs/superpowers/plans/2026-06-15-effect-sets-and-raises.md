# Effect Sets and `raises` Declarations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Agency functions/nodes declare the interrupt effects they may raise (`raises <...>`), verified at compile time against the transitively-inferred set, plus a `raise` statement and importable `effectSet` declarations.

**Architecture:** Effect sets lower onto the existing string-literal **union type** infrastructure: `effectSet X = <a, b>` becomes a `typeAlias` AST node with `isEffectSet: true`, and `<...>` becomes a flagged `UnionType`. This makes import/export, assignability (subset checking), and handler narrowing reuse existing machinery. The only genuinely new type-check is a small diagnostic that compares each function's declared `raises` set against the labels already computed by `analyzeInterruptsFromScopes`. The `raise` statement parses into the existing `interruptStatement` node, reusing its codegen unchanged.

**Tech Stack:** TypeScript; tarsec parser combinators (`lib/parsers/parsers.ts`); vitest for unit tests; Agency execution tests (`tests/agency/`) for runtime behavior.

**Reference spec:** `docs/superpowers/specs/2026-06-15-effect-sets-and-raises-design.md`

---

## Background the implementer must know

- **Pipeline:** `parse → SymbolTable.build → buildCompilationUnit → TypescriptPreprocessor → TypeScriptBuilder.build() → printTs()`.
- **All parsing lives in one file:** `lib/parsers/parsers.ts` (~4450 lines). Parsers are tarsec combinators: `seqC`, `capture`, `set`, `str`, `char`, `optional`, `or`, `sepBy`, `sepBy1`, `seqR`, `map`, `lazy`, `memo`, `withLoc`, `label`, `succeed`, `many1`, `spaces`, `optionalSpaces`, `optionalSpacesOrNewline`, `many1WithJoin`, `varNameChar`, `optionalSemicolon`. Debug parse failures with `DEBUG=1 pnpm run ast foo.agency`.
- **Effects are always namespaced.** `namespaceIdentifier` (parsers.ts:2522) *requires* `::` — bare `interrupt(...)` already falls back to effect `"unknown"`. This is why effect labels inside `<...>` carry `::` and bare names are effect-set references.
- **`return interrupt(...)` and bare `interrupt(...)` generate identical code** — both call `processInterruptStatement` (typescriptBuilder.ts:1932, dispatched at :577 and :2618). So a `raise` parsed as an `interruptStatement` needs no new codegen.
- **There is already a `throw(...)` builtin** that lowers to `throw new Error(...)` (typescriptBuilder.ts:2056). Do NOT touch it. The interrupt-raise statement is `raise`, deliberately distinct.
- **Existing interrupt analysis** (`lib/typeChecker/interruptAnalysis.ts`): `analyzeInterruptsFromScopes(scopes, ctx)` returns `Record<funcName, InterruptEffect[]>` (transitively closed). `InterruptEffect` is `{ effect: string }` (from `lib/symbolTable.ts`). Diagnostics are wired in `lib/typeChecker/index.ts` around lines 296–313.
- **Test commands:**
  - Unit tests (parser/typechecker): `pnpm test:run <path>` (runs once). Save output: `pnpm test:run <path> 2>&1 | tee /tmp/test-out.txt`.
  - Agency execution tests: `pnpm run agency test <path>`. Save output to a file — these are slow/expensive; never rerun just to re-see failures.
  - Do NOT run the full agency suite locally; CI runs it.
- **Banned patterns** (see `docs/dev/coding-standards.md`): no dynamic imports; objects not maps; arrays not sets; `type` not `interface`.

## How to test (read before writing any test)

Two distinct harnesses; using the wrong one produces tests that pass even
when the feature is absent.

**Typecheck errors are vitest-only.** The Agency execution-test framework
(`tests/agency/*.agency` + `.js` + `.test.json`) only asserts a node's
**runtime `expectedOutput`** — it has **no** way to assert "this file
should produce a typecheck error" (verified: no `.test.json` expresses
one). So every "the typechecker should/shouldn't flag X" assertion is a
vitest test that runs the real pipeline and inspects `errors`.

**The pipeline matters.** `typeCheck(program, config, info?)` needs the
`info` (CompilationUnit) third argument; without it `ctx.functionDefs`,
`ctx.nodeDefs`, and `ctx.getTypeAliases()` are empty and the new
diagnostic silently never fires — a green test for absent code. Always go
through parse → SymbolTable.build → buildCompilationUnit → typeCheck, like
`lib/typeChecker/fixtureTypeCheck.integration.test.ts` does.

Add this shared helper once (e.g. `lib/typeChecker/testUtils.ts`) and use
it from every typecheck test in this plan:

```typescript
import fs from "fs";
import os from "os";
import path from "path";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

/** Run the full typecheck pipeline on a source string and return errors.
 *  Writes to a temp .agency file because SymbolTable.build resolves imports
 *  (incl. stdlib) by path. */
export function typecheckSource(src: string): TypeCheckError[] {
  const parsed = parseAgency(src);
  if (!parsed.success) throw new Error(`parse failed: ${(parsed as any).message}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-tc-"));
  const file = path.join(dir, "main.agency");
  fs.writeFileSync(file, src);
  const symbols = SymbolTable.build(file);
  const info = buildCompilationUnit(parsed.result, symbols, file, src);
  return typeCheck(parsed.result, {}, info).errors;
}

export function raisesErrors(src: string): TypeCheckError[] {
  return typecheckSource(src).filter((e) => /raises/.test(e.message));
}
```

Confirm the exact `parseAgency` return shape, `SymbolTable.build`
signature, and `buildCompilationUnit` argument order against
`fixtureTypeCheck.integration.test.ts` (lines ~40–55) before relying on
this; adapt if they differ. NOTE: although `tests/agency` files live under
the package, `SymbolTable.build` does resolve relative/stdlib imports, so a
temp file outside the package may fail to resolve `import ... from "std::"`.
If stdlib imports are needed in a test, write the temp file **inside** the
package tree (e.g. under `tests/tmp/`) instead of `os.tmpdir()`. For the
self-contained tests in this plan (which use `raise std::read(...)` rather
than importing stdlib), `os.tmpdir()` is fine.

## Pre-execution orientation (do this before Tasks 8–9, 13)

These tasks touch typechecker internals the plan author has read only
partially. Before implementing them, read:
- `lib/typeChecker/index.ts` `TypeChecker.check()` and how `info`
  (CompilationUnit) populates `functionDefs`, `nodeDefs`, and the type-alias
  registry exposed by `getTypeAliases()`.
- `lib/compilationUnit.ts` around `unit.typeAliases.add(...)` (lines
  ~227/280/362) to confirm **imported** effect-set aliases land in the
  importing module's `getTypeAliases()` (Task 13 depends on this).
- `lib/typeChecker/interruptAnalysis.ts` `collectProfiles` — how
  **imported** functions' effects are seeded (relevant to transitive checks
  across modules).

If any assumption fails, adjust the affected task before writing its test.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `lib/types/typeHints.ts` | Type AST (`UnionType`, `TypeAlias`, `BlockType`, `FunctionRefType`) | Add `isEffectSet?` and `raises?` fields |
| `lib/types/function.ts` | `FunctionDefinition` | Add `raises?: VariableType` |
| `lib/types/graphNode.ts` | `GraphNodeDefinition` | Add `raises?: VariableType` |
| `lib/types/interruptStatement.ts` | `InterruptStatement` | Add `viaRaise?: boolean` |
| `lib/parsers/parsers.ts` | All parsing | Add effect-set literal, `effectSet` decl, `raises` clause, `raise` statement; wire into dispatch |
| `lib/typeChecker/effectSets.ts` | **New.** Resolve an effect-set type to `string[]` labels | Create |
| `lib/typeChecker/raisesDiagnostic.ts` | **New.** Subset check + `raises`-references-an-effect-set validation | Create |
| `lib/typeChecker/index.ts` | Diagnostic wiring | Call the new diagnostic |
| `lib/backends/agencyGenerator.ts` | Formatter | Print `effectSet`, `<...>`, `raises` clauses, `raise` statement |

No changes needed to the symbol table, compilation unit, or the TypeScript backend's interrupt codegen.

---

## Task 1: Add AST fields

**Files:**
- Modify: `lib/types/typeHints.ts` (`UnionType` ~157, `TypeAlias` ~209, `BlockType` ~120, `FunctionRefType` ~224)
- Modify: `lib/types/function.ts` (`FunctionDefinition` ~45)
- Modify: `lib/types/graphNode.ts` (`GraphNodeDefinition` ~8)
- Modify: `lib/types/interruptStatement.ts`

- [ ] **Step 1: Add `isEffectSet` to `UnionType`**

In `lib/types/typeHints.ts`, add to the `UnionType` type:

```typescript
export type UnionType = {
  type: "unionType";
  types: VariableType[];
  tags?: Tag[];
  /** True when this union came from effect-set syntax `<a, b>`. Used only
   *  for diagnostics wording and formatter round-tripping — never for
   *  core type-checking (subset checks run on union assignability). */
  isEffectSet?: boolean;
};
```

- [ ] **Step 2: Add `isEffectSet` to `TypeAlias`**

In `lib/types/typeHints.ts`, add `isEffectSet?: boolean;` to the `TypeAlias` type (the node produced by an `effectSet` declaration):

```typescript
export type TypeAlias = BaseNode & {
  type: "typeAlias";
  aliasName: string;
  aliasedType: VariableType;
  typeParams?: TypeParam[];
  valueParams?: ValueParam[];
  exported?: boolean;
  docComment?: AgencyMultiLineComment;
  tags?: Tag[];
  /** True when declared via `effectSet X = <...>` rather than `type X = ...`. */
  isEffectSet?: boolean;
};
```

- [ ] **Step 3: Add `raises` to `BlockType` and `FunctionRefType`**

In `lib/types/typeHints.ts`, add `raises?: VariableType;` to both `BlockType` and `FunctionRefType`:

```typescript
export type BlockType = {
  type: "blockType";
  params: { name: string; typeAnnotation: VariableType }[];
  returnType: VariableType;
  tags?: Tag[];
  /** Effect set this function-typed value may raise (`-> T raises <...>`). */
  raises?: VariableType;
};
```

```typescript
export type FunctionRefType = {
  type: "functionRefType";
  name: string;
  params: FunctionParameter[];
  returnType: VariableType | null;
  returnTypeValidated?: boolean;
  tags?: Tag[];
  raises?: VariableType;
};
```

- [ ] **Step 4: Add `raises` to `FunctionDefinition`**

In `lib/types/function.ts`, add to `FunctionDefinition`:

```typescript
  /** Declared effect set this function may raise (`raises <...>`).
   *  Absent = unconstrained (may raise anything). */
  raises?: VariableType;
```

- [ ] **Step 5: Add `raises` to `GraphNodeDefinition`**

In `lib/types/graphNode.ts`, add the same `raises?: VariableType;` field to `GraphNodeDefinition`.

- [ ] **Step 6: Add `viaRaise` to `InterruptStatement`**

In `lib/types/interruptStatement.ts`:

```typescript
export type InterruptStatement = BaseNode & {
  type: "interruptStatement";
  effect: string; // e.g. "std::read", "myapp::deploy"
  arguments: (Expression | SplatExpression | NamedArgument)[];
  /** True when written as a `raise` statement (vs `interrupt(...)`).
   *  Codegen is identical; this only drives formatter output. */
  viaRaise?: boolean;
};
```

- [ ] **Step 7: Verify the project still builds**

Run: `pnpm test:run lib/typeChecker/assignability.test.ts 2>&1 | tee /tmp/build.txt`
Expected: PASS (the additions are optional fields; nothing breaks). If TypeScript compile errors appear about exhaustive switches, they indicate a `VariableType` *variant* was expected — there isn't one here (only field additions), so there should be none.

- [ ] **Step 8: Commit**

```bash
git add lib/types/typeHints.ts lib/types/function.ts lib/types/graphNode.ts lib/types/interruptStatement.ts
git commit -m "feat(types): add raises/effectSet/viaRaise AST fields"
```

---

## Task 2: Effect-set literal parser (`<...>`, `<>`, `<*>`)

**Files:**
- Modify: `lib/parsers/parsers.ts` (add near the union parsers, ~line 1255, after `unionTypeParser`)
- Test: `lib/parsers/effectSet.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/parsers/effectSet.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { effectSetLiteralParser } from "./parsers.js";

describe("effectSetLiteralParser", () => {
  it("parses a two-label set", () => {
    const r = effectSetLiteralParser("<std::read, std::write>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "unionType",
      isEffectSet: true,
      types: [
        { type: "stringLiteralType", value: "std::read" },
        { type: "stringLiteralType", value: "std::write" },
      ],
    });
  });

  it("parses a single-label set as a one-member union", () => {
    const r = effectSetLiteralParser("<std::read>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "unionType",
      isEffectSet: true,
      types: [{ type: "stringLiteralType", value: "std::read" }],
    });
  });

  it("parses the empty set as an empty flagged union", () => {
    const r = effectSetLiteralParser("<>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({ type: "unionType", isEffectSet: true, types: [] });
  });

  it("parses <*> as the any primitive", () => {
    const r = effectSetLiteralParser("<*>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({ type: "primitiveType", value: "any" });
  });

  it("parses a bare identifier as an effect-set reference (TypeAliasVariable)", () => {
    const r = effectSetLiteralParser("<FsKinds, std::shell>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "unionType",
      isEffectSet: true,
      types: [
        { type: "typeAliasVariable", aliasName: "FsKinds" },
        { type: "stringLiteralType", value: "std::shell" },
      ],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/parsers/effectSet.test.ts 2>&1 | tee /tmp/t2.txt`
Expected: FAIL — `effectSetLiteralParser` is not exported.

- [ ] **Step 3: Implement the parser**

In `lib/parsers/parsers.ts`, immediately after `unionTypeParser` (~line 1255), add:

```typescript
// An item inside an effect-set literal `<...>`: a namespaced label
// (`std::read`) is unambiguously a literal effect → StringLiteralType. A
// bare identifier (`FsKinds`, `deploy`) is ambiguous at parse time — it may
// name an effect set (to spread) OR be a bare literal effect — so it is
// stored as a TypeAliasVariable and disambiguated later by
// `resolveEffectSet` (known set → spread; otherwise → literal effect).
// Effects are NOT required to be namespaced.
const effectSetItemParser: Parser<VariableType> = (input: string) => {
  const label = namespaceIdentifier(input);
  if (label.success) {
    return success(
      { type: "stringLiteralType", value: label.result } as StringLiteralType,
      label.rest,
    );
  }
  const bare = many1WithJoin(varNameChar)(input);
  if (!bare.success) return bare as ParserResult<VariableType>;
  return success(
    { type: "typeAliasVariable", aliasName: bare.result } as TypeAliasVariable,
    bare.rest,
  );
};

export const effectSetLiteralParser: Parser<VariableType> = memo(
  "effectSetLiteralParser",
  (input: string): ParserResult<VariableType> => {
    // `<*>` → the `any` primitive (the "raises anything" top).
    const star = seqC(
      char("<"),
      optionalSpaces,
      char("*"),
      optionalSpaces,
      char(">"),
    )(input);
    if (star.success) {
      return success(
        { type: "primitiveType", value: "any" } as PrimitiveType,
        star.rest,
      );
    }
    // `<>` or `<a, b, ...>` → a flagged union (possibly empty).
    const parser = seqC(
      char("<"),
      optionalSpaces,
      capture(
        sepBy(seqR(optionalSpaces, char(","), optionalSpaces), effectSetItemParser),
        "types",
      ),
      optionalSpaces,
      char(">"),
    );
    const r = parser(input);
    if (!r.success) return r as ParserResult<VariableType>;
    return success(
      { type: "unionType", types: (r.result as any).types, isEffectSet: true } as UnionType,
      r.rest,
    );
  },
);
```

If `StringLiteralType`, `TypeAliasVariable`, `PrimitiveType`, `UnionType`, `ParserResult` are not already imported at the top of `parsers.ts`, add them to the existing type imports (most are already imported — verify and add only the missing ones).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/parsers/effectSet.test.ts 2>&1 | tee /tmp/t2.txt`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/effectSet.test.ts
git commit -m "feat(parser): effect-set literal parser <...>, <>, <*>"
```

---

## Task 3: `effectSet` declaration parser

**Files:**
- Modify: `lib/parsers/parsers.ts` (add after `typeAliasParser`, ~line 1571; wire into dispatch lists ~3328 and ~3359/3372)
- Test: `lib/parsers/effectSet.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `lib/parsers/effectSet.test.ts`:

```typescript
import { effectSetDeclParser } from "./parsers.js";

describe("effectSetDeclParser", () => {
  it("parses a declaration into a typeAlias with isEffectSet", () => {
    const r = effectSetDeclParser("effectSet FsKinds = <std::read, std::write>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "typeAlias",
      aliasName: "FsKinds",
      isEffectSet: true,
      aliasedType: {
        type: "unionType",
        isEffectSet: true,
        types: [
          { type: "stringLiteralType", value: "std::read" },
          { type: "stringLiteralType", value: "std::write" },
        ],
      },
    });
  });

  it("parses an exported declaration", () => {
    const r = effectSetDeclParser("export effectSet NetKinds = <std::http>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({ aliasName: "NetKinds", exported: true, isEffectSet: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/parsers/effectSet.test.ts 2>&1 | tee /tmp/t3.txt`
Expected: FAIL — `effectSetDeclParser` not exported.

- [ ] **Step 3: Implement the parser**

In `lib/parsers/parsers.ts`, after `typeAliasParser` (~line 1571), add:

```typescript
const baseEffectSetDeclParser: Parser<TypeAlias> = withLoc(
  (input: string): ParserResult<TypeAlias> => {
    const parser = seqC(
      set("type", "typeAlias"),
      set("isEffectSet", true),
      str("effectSet"),
      spaces,
      capture(many1WithJoin(varNameChar), "aliasName"),
      optionalSpaces,
      str("="),
      optionalSpaces,
      capture(effectSetLiteralParser, "aliasedType"),
      optionalSemicolon,
      optionalSpacesOrNewline,
    );
    return parser(input) as ParserResult<TypeAlias>;
  },
);

export const effectSetDeclParser: Parser<TypeAlias> = label(
  "an effectSet declaration",
  (input: string) => {
    const exportResult = exportKeywordParser(input);
    if (!exportResult.success) return exportResult as ParserResult<TypeAlias>;
    const isExported = exportResult.result;
    const baseResult = baseEffectSetDeclParser(exportResult.rest);
    if (!baseResult.success) return baseResult;
    const result = { ...baseResult.result };
    if (isExported) result.exported = true;
    return { ...baseResult, result };
  },
);
```

- [ ] **Step 4: Wire `effectSetDeclParser` into the statement dispatch**

There are two `or(...)` alternative lists that include `typeAliasParser`: one near line 3359 (top-level program nodes) and the statement list near line 3328/3372 (which lists `interruptStatementParser`). Add `effectSetDeclParser` immediately BEFORE `typeAliasParser` in the top-level list, and also wherever `typeAliasParser` appears so an `effectSet` can be declared at module top-level. Search for `typeAliasParser` usages in dispatch `or(...)` lists:

Run: `grep -n "typeAliasParser" lib/parsers/parsers.ts`

For each occurrence inside an `or(...)` parser-alternatives list (NOT the definition at ~1558), add `effectSetDeclParser,` on the line directly above it. `effectSet` starts with a distinct keyword so there is no ordering conflict with `type`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test:run lib/parsers/effectSet.test.ts 2>&1 | tee /tmp/t3.txt`
Expected: PASS.

- [ ] **Step 6: Verify symbol-table pickup (no new plumbing)**

Create a scratch file `/tmp/check.agency` is NOT allowed (node_modules). Instead add a quick AST assertion test. Append to `lib/parsers/effectSet.test.ts`:

`parseAgency` returns `{ success, result }` (NOT a bare program — see
`fixtureTypeCheck.integration.test.ts`). Append to `lib/parsers/effectSet.test.ts`:

```typescript
import { parseAgency } from "../parser.js";

describe("effectSet at module level", () => {
  it("parses as a top-level typeAlias node", () => {
    const parsed = parseAgency('effectSet FsKinds = <std::read>\nnode main() { print("hi") }');
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // Confirm the program's node-array field name (e.g. `.nodes` or `.body`)
    // from the AgencyProgram type before relying on it.
    const nodes = (parsed.result as any).nodes ?? (parsed.result as any).body;
    const alias = nodes.find((n: any) => n.type === "typeAlias");
    expect(alias).toMatchObject({ aliasName: "FsKinds", isEffectSet: true });
  });
});
```

(Confirm the `AgencyProgram` node-array field name — run `grep -n "type AgencyProgram" lib/types.ts` — and use the real field.)

Run: `pnpm test:run lib/parsers/effectSet.test.ts 2>&1 | tee /tmp/t3.txt`
Expected: PASS. Because the node's `type` is `"typeAlias"`, `SymbolTable.build` (symbolTable.ts `case "typeAlias"`) already collects it — no symbol-table change needed.

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/effectSet.test.ts
git commit -m "feat(parser): effectSet declaration as flagged typeAlias"
```

---

## Task 4: `raises` clause on function definitions

**Files:**
- Modify: `lib/parsers/parsers.ts` (add `raisesClauseParser` ~after line 3947; wire into `_baseFunctionParser` ~3980)
- Test: `lib/parsers/raisesClause.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/parsers/raisesClause.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { functionParser } from "./parsers.js";

describe("raises clause on def", () => {
  it("parses an inline effect-set raises clause after a return type", () => {
    const r = functionParser('def readFile(p: string): string raises <std::read> { return read(p) }');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises).toMatchObject({
      type: "unionType",
      isEffectSet: true,
      types: [{ type: "stringLiteralType", value: "std::read" }],
    });
  });

  it("parses a raises clause with no return type", () => {
    const r = functionParser('def w(p: string) raises <std::write> { raise std::write("ok", {}) }');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises).toMatchObject({ isEffectSet: true });
  });

  it("parses a bare effectSet reference", () => {
    const r = functionParser('def d(): number raises FsKinds { return 1 }');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises).toMatchObject({ type: "typeAliasVariable", aliasName: "FsKinds" });
  });

  it("parses raises <> and raises <*>", () => {
    const empty = functionParser('def s(): number raises <> { return 1 }');
    expect(empty.success).toBe(true);
    if (empty.success) expect(empty.result.raises).toMatchObject({ type: "unionType", types: [] });
    const star = functionParser('def l(): number raises <*> { return 1 }');
    expect(star.success).toBe(true);
    if (star.success) expect(star.result.raises).toMatchObject({ type: "primitiveType", value: "any" });
  });

  it("leaves raises undefined when no clause is present", () => {
    const r = functionParser('def p(x: number): number { return x }');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/parsers/raisesClause.test.ts 2>&1 | tee /tmp/t4.txt`
Expected: FAIL — `raises` is always undefined (clause not parsed).

- [ ] **Step 3: Implement `raisesClauseParser`**

In `lib/parsers/parsers.ts`, right after `functionReturnTypeParser` (~line 3947), add:

```typescript
// `raises <...>` / `raises FsKinds` — the declared effect set. The value
// is a VariableType: a flagged UnionType, the `any` primitive (`<*>`), or
// a TypeAliasVariable referencing a named effectSet.
export const raisesClauseParser: Parser<VariableType> = memo(
  "raisesClauseParser",
  map(
    seqC(
      str("raises"),
      many1(space),
      capture(or(effectSetLiteralParser, typeAliasVariableParser), "value"),
    ),
    (r: any) => r.value as VariableType,
  ),
);
```

- [ ] **Step 4: Wire it into `_baseFunctionParser`**

In `_baseFunctionParser` (~line 3980), the relevant captures are:

```typescript
    capture(optional(functionReturnTypeParser), "returnType"),
    capture(optional(map(str("!"), () => true)), "returnTypeValidated"),
```

Add a `raises` capture immediately after the `returnTypeValidated` line and before the `captureCaptures(parseError("Expected function body", ...))` block:

```typescript
    capture(optional(seqR(optionalSpacesOrNewline, raisesClauseParser)), "raises"),
```

`seqR` discards the leading whitespace and yields the clause's `VariableType`; `optional` yields `null`/`undefined` when there is no clause, so `raises` stays absent. The `raises` key flows through `_functionParserInner`'s `...rest` spread onto the `FunctionDefinition`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test:run lib/parsers/raisesClause.test.ts 2>&1 | tee /tmp/t4.txt`
Expected: PASS (all 5 cases).

- [ ] **Step 6: Regression-check the existing function parser tests**

Run: `pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/t4b.txt`
Expected: PASS (the clause is optional; existing functions are unaffected).

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/raisesClause.test.ts
git commit -m "feat(parser): raises clause on function definitions"
```

---

## Task 5: `raises` clause on node definitions

**Files:**
- Modify: `lib/parsers/parsers.ts` (`graphNodeParser` ~4079, after the `returnTypeValidated` capture ~4106)
- Test: `lib/parsers/raisesClause.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `lib/parsers/raisesClause.test.ts`:

```typescript
import { graphNodeParser } from "./parsers.js";

describe("raises clause on node", () => {
  it("parses raises on a node definition", () => {
    const r = graphNodeParser('node main() raises <std::read, std::write> { print("hi") }');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises).toMatchObject({
      type: "unionType",
      isEffectSet: true,
      types: [
        { type: "stringLiteralType", value: "std::read" },
        { type: "stringLiteralType", value: "std::write" },
      ],
    });
  });

  it("leaves raises undefined when absent on a node", () => {
    const r = graphNodeParser('node main() { print("hi") }');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/parsers/raisesClause.test.ts 2>&1 | tee /tmp/t5.txt`
Expected: FAIL on the node case.

- [ ] **Step 3: Wire `raises` into `graphNodeParser`**

In `graphNodeParser` (~4106), after:

```typescript
      capture(optional(map(str("!"), () => true)), "returnTypeValidated"),
```

add:

```typescript
      capture(optional(seqR(optionalSpacesOrNewline, raisesClauseParser)), "raises"),
```

The node parser's `map` callback (~4122) spreads `...rest`, so `raises` carries through onto `GraphNodeDefinition`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/parsers/raisesClause.test.ts 2>&1 | tee /tmp/t5.txt`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/raisesClause.test.ts
git commit -m "feat(parser): raises clause on node definitions"
```

---

## Task 6: `raises` clause on function types

> SCOPE NOTE: Phase 1 **parses and formats** `raises` on function types so
> the contract can be written and round-tripped, but does NOT check
> callback-raises compatibility (`isAssignable` does not inspect the new
> `BlockType.raises`). Verifying that a callback argument conforms to a
> parameter's declared `raises` is deferred to a later phase (it pairs with
> row polymorphism). Do not add such a check here — and do not write a test
> asserting it works, which would be a phantom-feature test.

**Files:**
- Modify: `lib/parsers/parsers.ts` (`blockTypeParser` ~1280–1314)
- Test: `lib/parsers/raisesClause.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `lib/parsers/raisesClause.test.ts`:

```typescript
import { blockTypeParser } from "./parsers.js";

describe("raises clause on function types", () => {
  it("parses a raises clause after the return type", () => {
    const r = blockTypeParser("(string) -> string raises <std::read>");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises).toMatchObject({ type: "unionType", isEffectSet: true });
  });

  it("leaves raises undefined when absent", () => {
    const r = blockTypeParser("(string) -> string");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result.raises).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/parsers/raisesClause.test.ts 2>&1 | tee /tmp/t6.txt`
Expected: FAIL on the function-type case.

- [ ] **Step 3: Add `raises` to `blockTypeParser`**

In `blockTypeParser` (~1298), the inner `parser` ends with:

```typescript
      optionalSpaces,
      capture(lazy(() => variableTypeParser), "returnType"),
    );
```

Change it to also capture an optional raises clause, and include it in the returned object:

```typescript
      optionalSpaces,
      capture(lazy(() => variableTypeParser), "returnType"),
      capture(optional(seqR(optionalSpaces, raisesClauseParser)), "raises"),
    );
    const result = parser(input);
    if (!result.success) return result;
    return success(
      {
        type: "blockType" as const,
        params: result.result.params as {
          name: string;
          typeAnnotation: VariableType;
        }[],
        returnType: result.result.returnType,
        ...((result.result as any).raises
          ? { raises: (result.result as any).raises }
          : {}),
      },
      result.rest,
    );
```

(`raisesClauseParser` is defined later in the file; because `blockTypeParser`'s body is a closure invoked at parse time, referencing `raisesClauseParser` is fine as long as it is a module-level `const`. If a temporal-dead-zone error occurs, wrap the reference with `lazy(() => raisesClauseParser)`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/parsers/raisesClause.test.ts 2>&1 | tee /tmp/t6.txt`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/raisesClause.test.ts
git commit -m "feat(parser): raises clause on function types"
```

---

## Task 7: `raise` statement parser

**Files:**
- Modify: `lib/parsers/parsers.ts` (add after `interruptStatementParser` ~2571; wire into statement dispatch ~3328/3372)
- Test: `lib/parsers/raiseStatement.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `lib/parsers/raiseStatement.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { raiseStatementParser } from "./parsers.js";

describe("raiseStatementParser", () => {
  it("parses a structured raise into an interruptStatement with viaRaise", () => {
    const r = raiseStatementParser('raise std::write("Are you sure?", { filename: "a" })');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "interruptStatement",
      effect: "std::write",
      viaRaise: true,
    });
    expect(r.result.arguments.length).toBe(2);
  });

  it("parses a NON-namespaced (bare) named effect", () => {
    const r = raiseStatementParser('raise deploy("confirm?", {})');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "interruptStatement",
      effect: "deploy",
      viaRaise: true,
    });
  });

  it("parses a bare raise with effect unknown", () => {
    const r = raiseStatementParser('raise("Are you sure?")');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({
      type: "interruptStatement",
      effect: "unknown",
      viaRaise: true,
    });
  });

  it("does not mis-parse an identifier like raiseHand()", () => {
    const r = raiseStatementParser("raiseHand()");
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/parsers/raiseStatement.test.ts 2>&1 | tee /tmp/t7.txt`
Expected: FAIL — `raiseStatementParser` not exported.

- [ ] **Step 3: Add an `effectIdentifier` that accepts bare OR namespaced effects**

`namespaceIdentifier` (parsers.ts:2522) *requires* `::`. Per the design,
effects may be bare (`deploy`) or namespaced (`std::read`). Add a parser
that accepts either, immediately before `_interruptExprParser` (~2538):

```typescript
// An effect label: namespaced (`std::read`) OR bare (`deploy`). Try the
// namespaced form first so multi-segment names join correctly; fall back
// to a single bare identifier.
const effectIdentifier: Parser<string> = or(
  namespaceIdentifier,
  many1WithJoin(varNameChar),
);
```

- [ ] **Step 4: Relax the existing `interrupt` parser to accept bare effects**

In `_interruptExprParser` (~2538), change the structured form to use
`effectIdentifier` instead of `namespaceIdentifier`:

```typescript
  const structured = seqC(
    set("type", "interruptStatement"),
    str("interrupt"),
    spaces,
    capture(effectIdentifier, "effect"),   // was: namespaceIdentifier
    captureCaptures(argumentListParser),
  )(input);
```

This makes `interrupt deploy("msg")` parse (effect `"deploy"`) while
`interrupt("msg")` still falls through to the bare/unknown form (no space
before `(`), and `interrupt std::read(...)` is unchanged.

- [ ] **Step 5: Add a regression test for bare `interrupt`**

Append to `lib/parsers/interruptStatement.test.ts` (the existing interrupt
parser test file):

```typescript
import { interruptStatementParser } from "./parsers.js";

describe("interrupt with non-namespaced effect", () => {
  it("parses a bare named effect", () => {
    const r = interruptStatementParser('interrupt deploy("confirm?", {})');
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.result).toMatchObject({ type: "interruptStatement", effect: "deploy" });
  });
  it("still parses a namespaced effect", () => {
    const r = interruptStatementParser('interrupt std::read("m")');
    expect(r.success).toBe(true);
    if (r.success) expect(r.result.effect).toBe("std::read");
  });
  it("still parses bare interrupt() as unknown", () => {
    const r = interruptStatementParser('interrupt("m")');
    expect(r.success).toBe(true);
    if (r.success) expect(r.result.effect).toBe("unknown");
  });
});
```

Run: `pnpm test:run lib/parsers/interruptStatement.test.ts 2>&1 | tee /tmp/t7i.txt`
Expected: PASS (existing cases + the 3 new ones).

- [ ] **Step 6: Implement the `raise` parser**

In `lib/parsers/parsers.ts`, after `interruptStatementParser` (~line 2571), add:

```typescript
// `raise std::write(args)` / `raise deploy(args)` / `raise(args)` — raise
// an interrupt as a statement. Lowers to the same `interruptStatement`
// node as `interrupt(...)` (so codegen and effect inference are
// unchanged); the `viaRaise` marker only drives formatter output. Mirrors
// `_interruptExprParser`. NOTE: distinct from the `throw(...)` builtin,
// which raises a JS Error.
const _raiseExprParser: Parser<InterruptStatement> = (input: string) => {
  const structured = seqC(
    set("type", "interruptStatement"),
    set("viaRaise", true),
    str("raise"),
    spaces,
    capture(effectIdentifier, "effect"),
    captureCaptures(argumentListParser),
  )(input);
  if (structured.success) {
    return success(structured.result as InterruptStatement, structured.rest);
  }
  const bare = seqC(
    set("type", "interruptStatement"),
    set("viaRaise", true),
    str("raise"),
    set("effect", "unknown"),
    captureCaptures(argumentListParser),
  )(input);
  if (!bare.success) return bare;
  return success(bare.result as InterruptStatement, bare.rest);
};

export const raiseStatementParser: Parser<InterruptStatement> = label(
  "a raise statement",
  withLoc((input: string) => {
    const result = _raiseExprParser(input);
    if (!result.success) return result;
    const semiResult = optionalSemicolon(result.rest);
    const afterSemi = semiResult.success ? semiResult.rest : result.rest;
    const wsResult = optionalSpacesOrNewline(afterSemi);
    return success(result.result, wsResult.success ? wsResult.rest : afterSemi);
  }),
);
```

Note: with `effectIdentifier`, the structured form requires a space after
`raise` (so `raiseHand()` — no space — can't match the structured form,
and `raiseHand` is not followed by `(` for the bare form either, so the
whole parser fails, as the Step 1 test asserts).

- [ ] **Step 7: Wire `raiseStatementParser` into the statement dispatch**

Find where `interruptStatementParser` is listed in statement `or(...)` lists:

Run: `grep -n "interruptStatementParser" lib/parsers/parsers.ts`

For each occurrence inside an `or(...)` alternatives list (the dispatch around lines 3328 and 3372 — NOT the definition at 2562), add `raiseStatementParser,` on the line directly above `interruptStatementParser,`. Placing it before the general value/function-call parsers ensures `raise std::write(...)` is recognized as a raise rather than an identifier.

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm test:run lib/parsers/raiseStatement.test.ts 2>&1 | tee /tmp/t7.txt`
Expected: PASS (all 4 cases).

- [ ] **Step 9: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/raiseStatement.test.ts lib/parsers/interruptStatement.test.ts
git commit -m "feat(parser): raise statement + bare (non-namespaced) effects"
```

---

## Task 8: Effect-set resolver helper

**Files:**
- Create: `lib/typeChecker/effectSets.ts`
- Test: `lib/typeChecker/effectSets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/typeChecker/effectSets.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveEffectSet } from "./effectSets.js";
import type { VariableType } from "../types.js";

const union = (types: VariableType[]): VariableType => ({ type: "unionType", types, isEffectSet: true });
const lit = (value: string): VariableType => ({ type: "stringLiteralType", value });
const ref = (aliasName: string): VariableType => ({ type: "typeAliasVariable", aliasName });
const any: VariableType = { type: "primitiveType", value: "any" };

describe("resolveEffectSet", () => {
  it("resolves a flat literal union to labels", () => {
    expect(resolveEffectSet(union([lit("std::read"), lit("std::write")]), {})).toEqual({
      any: false,
      labels: ["std::read", "std::write"],
    });
  });

  it("resolves the empty set to no labels", () => {
    expect(resolveEffectSet(union([]), {})).toEqual({ any: false, labels: [] });
  });

  it("resolves <*> (any primitive) to any:true", () => {
    expect(resolveEffectSet(any, {})).toEqual({ any: true, labels: [] });
  });

  it("flattens a referenced effect set (spread)", () => {
    const aliases = { FsKinds: { body: union([lit("std::read"), lit("std::write")]) } };
    expect(resolveEffectSet(union([ref("FsKinds"), lit("std::shell")]), aliases as any)).toEqual({
      any: false,
      labels: ["std::read", "std::write", "std::shell"],
    });
  });

  it("dedupes labels", () => {
    const aliases = { A: { body: union([lit("std::read")]) } };
    expect(resolveEffectSet(union([ref("A"), lit("std::read")]), aliases as any)).toEqual({
      any: false,
      labels: ["std::read"],
    });
  });

  it("treats an unknown bare name as a literal effect (bare effects allowed)", () => {
    const result = resolveEffectSet(union([ref("deploy")]), {});
    expect(result).toEqual({ any: false, labels: ["deploy"], nonEffectSetRefs: [] });
  });

  it("reports a reference to a KNOWN alias that is not an effect set", () => {
    // `Color` is a real type alias whose body is a plain string union, not
    // a flagged effect set.
    const aliases = {
      Color: { body: { type: "unionType", types: [lit("red"), lit("blue")] } },
    };
    const result = resolveEffectSet(union([ref("Color")]), aliases as any);
    expect(result.nonEffectSetRefs).toEqual(["Color"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/typeChecker/effectSets.test.ts 2>&1 | tee /tmp/t8.txt`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

First confirm the type-alias registry shape passed around the typechecker:

Run: `grep -n "getTypeAliases\|TypeAliasEntry\|typeAliases:" lib/typeChecker/types.ts lib/typeChecker/index.ts`

The registry is `Record<string, TypeAliasEntry>` where `TypeAliasEntry` has a `body: VariableType` (see `lib/types/typeHints.ts`). Create `lib/typeChecker/effectSets.ts`:

```typescript
import type { VariableType } from "../types.js";
import type { TypeAliasEntry } from "../types/typeHints.js";

export type ResolvedEffectSet = {
  /** True if this set is `<*>` / the `any` primitive — no upper bound. */
  any: boolean;
  /** Deduped effect labels, in first-seen order. */
  labels: string[];
  /** Names of references that resolved to a KNOWN type alias that is NOT an
   *  effect set (e.g. `raises Color` where `Color` is a string union). These
   *  are errors. An unknown bare name is NOT here — it is a literal effect. */
  nonEffectSetRefs: string[];
};

/**
 * Resolve an effect-set type (a flagged UnionType, the `any` primitive, or
 * a TypeAliasVariable) to its concrete set of effect labels. Disambiguation
 * for a TypeAliasVariable (effects need not be namespaced):
 *   - resolves to a KNOWN effect set (isEffectSet)  → spread its members;
 *   - resolves to a KNOWN non-effect-set alias       → record in
 *     `nonEffectSetRefs` (an error);
 *   - does NOT resolve to any alias                   → treat the bare name
 *     as a literal effect label.
 *
 * Cycles are guarded with a `seen` set so a self-referential alias can't
 * loop forever.
 */
export function resolveEffectSet(
  type: VariableType | undefined,
  aliases: Record<string, TypeAliasEntry>,
): ResolvedEffectSet {
  const labels: string[] = [];
  const nonEffectSetRefs: string[] = [];
  const seen: string[] = [];
  let any = false;

  const addLabel = (label: string) => {
    if (!labels.includes(label)) labels.push(label);
  };

  const isEffectSetEntry = (entry: TypeAliasEntry): boolean =>
    (entry as any).isEffectSet === true ||
    (entry.body?.type === "unionType" && (entry.body as any).isEffectSet === true);

  const walk = (t: VariableType | undefined): void => {
    if (!t) return;
    if (t.type === "primitiveType" && t.value === "any") {
      any = true;
      return;
    }
    if (t.type === "stringLiteralType") {
      addLabel(t.value);
      return;
    }
    if (t.type === "unionType") {
      for (const member of t.types) walk(member);
      return;
    }
    if (t.type === "typeAliasVariable") {
      const name = t.aliasName;
      if (seen.includes(name)) return; // cycle guard
      const entry = aliases[name];
      if (!entry) {
        // Bare name that isn't a declared alias → a literal effect label.
        addLabel(name);
        return;
      }
      if (!isEffectSetEntry(entry)) {
        if (!nonEffectSetRefs.includes(name)) nonEffectSetRefs.push(name);
        return;
      }
      seen.push(name);
      walk(entry.body);
      return;
    }
    // Any other shape is not a valid effect-set member; ignore.
  };

  walk(type);
  return { any, labels, nonEffectSetRefs };
}
```

(If `TypeAliasEntry`'s field is named differently than `body`, or if
`isEffectSet` is not propagated onto the registry entry, adapt — Task 10
Step 3 covers adding `isEffectSet` to `TypeAliasEntry` if needed; this
resolver depends on it, so do Task 10's registry change first if the flag
is missing.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/typeChecker/effectSets.test.ts 2>&1 | tee /tmp/t8.txt`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Commit**

```bash
git add lib/typeChecker/effectSets.ts lib/typeChecker/effectSets.test.ts
git commit -m "feat(typecheck): effect-set resolver (labels + spread + any)"
```

---

## Task 9: The `raises` subset diagnostic

**Files:**
- Create: `lib/typeChecker/raisesDiagnostic.ts`
- Modify: `lib/typeChecker/index.ts` (wire in ~after line 313)
- Test: `lib/typeChecker/raisesDiagnostic.test.ts`

- [ ] **Step 1: Confirm the ctx shape the diagnostic needs**

Run: `grep -n "functionDefs\|nodeDefs\|getTypeAliases\|errors\b\|withScope" lib/typeChecker/types.ts | head`

You need: `ctx.functionDefs: Record<string, FunctionDefinition>`, `ctx.nodeDefs: Record<string, GraphNodeDefinition>`, `ctx.getTypeAliases(): Record<string, TypeAliasEntry>`, and `ctx.errors` (push `{ message, severity, loc }`). These all exist (used in `interruptAnalysis.ts`).

- [ ] **Step 2: Write the failing test**

Create `lib/typeChecker/raisesDiagnostic.test.ts`, using the shared
`typecheckSource` / `raisesErrors` helpers from the "How to test" section
(NOT a bare `typeCheck(parseAgency(src))` — that omits `info` and the
diagnostic silently never fires). Bodies use `raise std::*(...)` /
`raise foo(...)` so the inferred set is populated *without* depending on
stdlib signatures being loaded in the test harness.

```typescript
import { describe, it, expect } from "vitest";
import { typecheckSource, raisesErrors } from "./testUtils.js";

describe("raises subset diagnostic", () => {
  it("passes when inferred ⊆ declared", () => {
    const errs = raisesErrors(
      'def f(): number raises <std::read> { raise std::read("m", {})\n return 1 }',
    );
    expect(errs).toHaveLength(0);
  });

  it("produces NO raises error for a fully valid program (false-positive guard)", () => {
    const errs = raisesErrors(
      'effectSet Fs = <std::read, std::write>\n' +
      'def f(): number raises Fs { raise std::read("m",{})\n raise std::write("m",{})\n return 1 }',
    );
    expect(errs).toHaveLength(0);
  });

  it("errors when a raised effect exceeds the declared set", () => {
    const errs = typecheckSource(
      'def f(): number raises <std::read> { raise std::write("m", {})\n return 1 }',
    );
    const raisesErr = errs.find((e: any) => /raises effect/.test(e.message));
    expect(raisesErr).toBeDefined();
    expect(raisesErr!.message).toContain("std::write");
    expect(raisesErr!.message).toContain("raises <std::read>");
    expect(raisesErr!.message).not.toMatch(/handle it/i); // must not advise local handling
  });

  it("flags a locally-handled effect (decision A: every handler in the chain still sees it)", () => {
    const errs = typecheckSource(
      'def f(): number raises <std::read> {\n' +
      '  handle { raise std::write("m", {}) } with approve\n' +
      '  return 1\n}',
    );
    expect(errs.find((e: any) => /raises effect 'std::write'/.test(e.message))).toBeDefined();
  });

  it("reports EACH offending effect", () => {
    const errs = typecheckSource(
      'def f(): number raises <std::read> { raise std::write("m",{})\n raise std::shell("m",{})\n return 1 }',
    );
    const msgs = errs.filter((e: any) => /raises effect/.test(e.message)).map((e: any) => e.message);
    expect(msgs.some((m: string) => m.includes("std::write"))).toBe(true);
    expect(msgs.some((m: string) => m.includes("std::shell"))).toBe(true);
  });

  it("counts an effect raised transitively through a callee", () => {
    const errs = typecheckSource(
      'def inner() { raise std::write("m", {}) }\n' +
      'def f(): number raises <std::read> { inner()\n return 1 }',
    );
    expect(errs.find((e: any) => /raises effect 'std::write'/.test(e.message))).toBeDefined();
  });

  it("checks NODE definitions too", () => {
    const errs = typecheckSource(
      'node main() raises <std::read> { raise std::write("m", {}) }',
    );
    expect(errs.find((e: any) => /raises effect 'std::write'/.test(e.message))).toBeDefined();
  });

  it("raises <> rejects any inferred effect", () => {
    const errs = typecheckSource('def f(): number raises <> { raise std::read("m",{})\n return 1 }');
    expect(errs.find((e: any) => /raises effect/.test(e.message))).toBeDefined();
  });

  it("raises <*> imposes no upper bound", () => {
    expect(raisesErrors('def f(): number raises <*> { raise std::write("m",{})\n return 1 }')).toHaveLength(0);
  });

  it("omitted clause imposes no upper bound", () => {
    expect(raisesErrors('def f(): number { raise std::write("m",{})\n return 1 }')).toHaveLength(0);
  });

  it("does not double-report with the handler-recursion diagnostic", () => {
    // A handler body that raises is the domain of checkHandlerBodyInterrupts;
    // the subset diagnostic must not ALSO fire on the same construct.
    const errs = typecheckSource(
      'def f(): number raises <std::read> {\n' +
      '  handle { raise std::read("m", {}) } with (data) { raise std::read("x", {}) }\n' +
      '  return 1\n}',
    );
    // exactly the handler-recursion error, no spurious subset error for std::read
    expect(errs.filter((e: any) => /raises effect 'std::read'/.test(e.message))).toHaveLength(0);
  });
});
```

NOTE: confirm the effect names used by `with approve` shorthand and the
handler-recursion diagnostic against the real messages when you run the
test; adjust matchers if wording differs. The last case's exact behavior
depends on how the two diagnostics interact — verify and adjust the
assertion to match the *intended* behavior (the subset check should not
fire for an effect that is declared, here `std::read`).

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test:run lib/typeChecker/raisesDiagnostic.test.ts 2>&1 | tee /tmp/t9.txt`
Expected: FAIL — no `raises effect` diagnostic is produced yet (the valid
cases may already pass; the violation cases must fail).

- [ ] **Step 4: Implement the diagnostic**

Create `lib/typeChecker/raisesDiagnostic.ts`:

```typescript
import type { InterruptEffect } from "../symbolTable.js";
import type { TypeCheckerContext } from "./types.js";
import { resolveEffectSet } from "./effectSets.js";
import type { VariableType } from "../types.js";
import type { FunctionDefinition } from "../types/function.js";
import type { GraphNodeDefinition } from "../types/graphNode.js";

/**
 * For every function/node that declares a `raises` clause, verify that its
 * transitively-inferred effect set does not exceed the declared set
 * (inferred ⊆ declared). Emits a bespoke, effect-aware error per offending
 * effect.
 *
 * Independent of `checkHandlerBodyInterrupts`: that one flags handler
 * *bodies* that raise; this one compares a declaration to an inferred set.
 *
 * IMPORTANT: do not suggest "handle it inside the function" as a fix.
 * Under Agency's handler-chain semantics every handler in the stack runs,
 * so a locally-handled interrupt is still observed by ancestor handlers
 * and remains part of the function's effect set (spec decision A).
 */
export function checkRaisesDeclarations(
  interruptEffectsByFunction: Record<string, InterruptEffect[]>,
  ctx: TypeCheckerContext,
): void {
  const aliases = ctx.getTypeAliases();

  const check = (
    name: string,
    raises: VariableType | undefined,
    loc: FunctionDefinition["loc"] | GraphNodeDefinition["loc"],
  ): void => {
    if (!raises) return; // no clause = unconstrained

    const declared = resolveEffectSet(raises, aliases);
    if (declared.any) return; // `<*>` — no upper bound

    const inferred = (interruptEffectsByFunction[name] ?? []).map((e) => e.effect);
    const declaredStr = formatEffectSet(declared.labels);

    for (const effect of inferred) {
      if (!declared.labels.includes(effect)) {
        ctx.errors.push({
          message:
            `Function '${name}' raises effect '${effect}', which exceeds ` +
            `its declared 'raises ${declaredStr}'. Add '${effect}' to the clause.`,
          severity: "error",
          loc,
        });
      }
    }
  };

  for (const [name, def] of Object.entries(ctx.functionDefs)) {
    check(name, def.raises, def.loc);
  }
  for (const [name, def] of Object.entries(ctx.nodeDefs)) {
    check(name, def.raises, def.loc);
  }
}

function formatEffectSet(labels: string[]): string {
  return `<${labels.join(", ")}>`;
}
```

(Confirm the exact `TypeCheckError` shape — run `grep -n "type TypeCheckError" lib/typeChecker/types.ts` — and match `severity`/`loc` field names. The existing diagnostics in `interruptAnalysis.ts` push `{ message, severity: "error"|"warning", loc }`, so this matches.)

- [ ] **Step 5: Wire it into `TypeChecker.check()`**

In `lib/typeChecker/index.ts`, after the `checkHandlerBodyInterrupts(...)` call (~line 313), add:

```typescript
    // 6c. Verify each function/node's declared `raises` clause is not
    // exceeded by its transitively-inferred effect set.
    checkRaisesDeclarations(interruptEffectsByFunction, ctx);
```

And add `checkRaisesDeclarations` to the imports at the top (it's a new module — import from `./raisesDiagnostic.js`).

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test:run lib/typeChecker/raisesDiagnostic.test.ts 2>&1 | tee /tmp/t9.txt`
Expected: PASS (all cases). If the "does not double-report" case fails,
that's a real interaction to resolve — see Task 10 and the diagnostic-
interaction note in the spec; adjust the diagnostic or the test to reflect
the intended single-error behavior, don't just loosen the matcher.

- [ ] **Step 7: Commit**

```bash
git add lib/typeChecker/raisesDiagnostic.ts lib/typeChecker/index.ts lib/typeChecker/raisesDiagnostic.test.ts
git commit -m "feat(typecheck): raises subset diagnostic (inferred ⊆ declared)"
```

---

## Task 10: Validate that `raises` references an effect set

**Files:**
- Modify: `lib/typeChecker/raisesDiagnostic.ts` (extend)
- Test: `lib/typeChecker/raisesDiagnostic.test.ts` (append)

Because bare effects are allowed everywhere, an **unknown** bare name in a
`raises` clause is NOT an error — it's a single literal effect (`raises
deploy` means "raises effect `deploy`"). The only validation error is
referencing a **known type alias that is not an effect set** (e.g. `raises
Color` where `Color` is a plain string-union `type`). That case is exactly
`resolveEffectSet`'s `nonEffectSetRefs`.

- [ ] **Step 0: Ensure `isEffectSet` reaches the registry (prerequisite for Task 8/9 too)**

`resolveEffectSet` (Task 8) and this validation both rely on the
`isEffectSet` flag being present on the `TypeAliasEntry` in
`ctx.getTypeAliases()`. Confirm and, if missing, plumb it:

Run: `grep -n "isEffectSet\|TypeAliasEntry\|aliasedType\|add(" lib/compilationUnit.ts lib/types/typeHints.ts`

If `TypeAliasEntry` lacks `isEffectSet`, add it to the type in
`lib/types/typeHints.ts`:

```typescript
export type TypeAliasEntry = {
  body: VariableType;
  typeParams?: TypeParam[];
  valueParams?: ValueParam[];
  tags?: Tag[];
  isEffectSet?: boolean;
};
```

and at the site in `lib/compilationUnit.ts` where a `typeAlias` node is
turned into a registry entry (`unit.typeAliases.add(...)`, ~227/280/362),
copy `node.isEffectSet` onto the entry. (If this was already done as part
of Task 8, skip.)

- [ ] **Step 1: Write the failing test**

Append to `lib/typeChecker/raisesDiagnostic.test.ts`:

```typescript
describe("raises must reference an effect set (not a plain type)", () => {
  it("errors when raises references a non-effectSet type alias", () => {
    const errs = typecheckSource(
      'type Color = "red" | "blue"\n' +
      'def f(): number raises Color { return 1 }',
    );
    expect(errs.find((e: any) => /not an effect set/.test(e.message))).toBeDefined();
  });

  it("treats an unknown bare name as a single literal effect (NOT an error)", () => {
    // `raises deploy` = "raises effect deploy"; the body raises it, so OK.
    const errs = typecheckSource('def f(): number raises deploy { raise deploy("m",{})\n return 1 }');
    expect(errs.filter((e: any) => /not an effect set|raises effect/.test(e.message))).toHaveLength(0);
  });

  it("a bare-effect raises clause still enforces its bound", () => {
    const errs = typecheckSource('def f(): number raises deploy { raise ship("m",{})\n return 1 }');
    expect(errs.find((e: any) => /raises effect 'ship'/.test(e.message))).toBeDefined();
  });

  it("accepts a real effectSet reference", () => {
    const errs = typecheckSource(
      'effectSet FsKinds = <std::read>\n' +
      'def f(): number raises FsKinds { raise std::read("m", {})\n return 1 }',
    );
    expect(errs.filter((e: any) => /not an effect set|raises effect/.test(e.message))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/typeChecker/raisesDiagnostic.test.ts 2>&1 | tee /tmp/t10.txt`
Expected: FAIL on the "non-effectSet type alias" case (no error emitted yet).

- [ ] **Step 3: Extend the diagnostic**

In `checkRaisesDeclarations` (`lib/typeChecker/raisesDiagnostic.ts`),
inside the `check` function, after `const declared = resolveEffectSet(...)`
and before the subset loop, surface non-effect-set references:

```typescript
    // A `raises` clause may only reference effect sets, not arbitrary
    // type aliases. Unknown bare names are fine (they are literal effects);
    // only a KNOWN alias of the wrong kind is an error.
    if (declared.nonEffectSetRefs.length > 0) {
      for (const ref of declared.nonEffectSetRefs) {
        ctx.errors.push({
          message:
            `'raises ${ref}' is not an effect set. Declare '${ref}' with ` +
            `'effectSet' (not 'type'), or use an inline set like '<...>'.`,
          severity: "error",
          loc,
        });
      }
      return; // don't run the subset check against a malformed clause
    }
```

No new helper is needed — `resolveEffectSet` already classifies references
(it owns the `isEffectSet` check via `isEffectSetEntry` internally).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/typeChecker/raisesDiagnostic.test.ts 2>&1 | tee /tmp/t10.txt`
Expected: PASS (all cases, including the Task 9 ones).

- [ ] **Step 5: Commit**

```bash
git add lib/typeChecker/raisesDiagnostic.ts lib/typeChecker/index.ts lib/types/typeHints.ts lib/typeChecker/raisesDiagnostic.test.ts
git commit -m "feat(typecheck): validate raises references a real effect set"
```

---

## Task 11: `raise` statement execution (codegen reuse)

**Files:**
- Test: `tests/agency/raiseStatement.agency` + `tests/agency/raiseStatement.test.json` (create) — Agency execution test, no LLM
- Possibly modify: `lib/backends/typescriptBuilder.ts` (only if the test reveals a gap)

> SCOPE NOTE: This is the only place a `tests/agency` test fits. The
> Agency execution-test framework asserts a node's runtime `expectedOutput`
> only — it CANNOT assert a typecheck error. All `raises`/effect-set
> typecheck behavior is covered by the vitest tests in Tasks 9–10, not
> here. This task verifies `raise`'s *runtime* control flow.

- [ ] **Step 1: Confirm the existing dispatch already handles the node**

`raise` parses to `type: "interruptStatement"`, which `typescriptBuilder.ts` already dispatches at line 577 → `processInterruptStatement` → `buildInterruptReturnStructured` (the same path as `return interrupt(...)`). No codegen change is expected. This step is to verify, not to write code.

- [ ] **Step 2: Study the exact format of an existing interrupt+handler agency test**

Agency tests are a triple: `NAME.agency` (source), `NAME.js` (compiled —
generated, do not hand-write), and `NAME.test.json` (expectations:
`{ tests: [{ nodeName, input, expectedOutput, evaluationCriteria }] }`).
Copy the structure from a known interrupt/handler example:

Run: `ls tests/agency/structured-interrupts && cat tests/agency/structured-interrupts/bare-interrupt-backward-compat.test.json`

Note how a handled interrupt yields a concrete `expectedOutput` string and
how `with approve` / `with reject` resolve interrupts with no LLM.

- [ ] **Step 3: Write the `.agency` source**

Create `tests/agency/raiseStatement.agency`. Design `main` so its single
return value encodes BOTH outcomes (reject → failure, approve → continue),
making one `expectedOutput` deterministic:

```
def doWrite(): string {
  raise std::write("confirm?", {})
  return "wrote"
}

node main(): string {
  let approved = handle { doWrite() } with approve   // continues → "wrote"
  let rejected = handle { doWrite() } with reject     // bails → failure Result
  return "approved=" + approved + " rejectedFailed=" + isFailure(rejected)
}
```

Adapt to the real surface: confirm whether the handler-shorthand result of
a rejected interrupt is a `failure` Result (use `isFailure(...)` from the
Result API — see `docs/site/guide/error-handling.md`) and how string
concatenation / `isFailure` render. The point each assertion must pin
down: **approved path returns "wrote" (raise continued); rejected path is
a failure (raise bailed).**

- [ ] **Step 4: Write the `.test.json`**

Create `tests/agency/raiseStatement.test.json` mirroring the example from
Step 2, with the `expectedOutput` that matches `main`'s return for the
`approved`/`rejected` design above, e.g.:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"approved=wrote rejectedFailed=true\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

(The exact `expectedOutput` string must match whatever `main` actually
returns — derive it from a first run, then lock it in.)

- [ ] **Step 5: Run the test to verify behavior**

Run: `pnpm run agency test tests/agency/raiseStatement.agency 2>&1 | tee /tmp/t11.txt`
Expected: If codegen reuse is correct, PASS. If it FAILS (e.g. `raise` isn't recognized as interrupt-bearing in some context), inspect the generated TS with `pnpm run compile tests/agency/raiseStatement.agency` and compare against the output for an equivalent `return interrupt(...)`; reconcile in `processInterruptStatement`. Do not special-case `viaRaise` in codegen unless a concrete difference is found — the marker is for formatting only.

- [ ] **Step 6: Commit**

```bash
git add tests/agency/raiseStatement.agency tests/agency/raiseStatement.test.json tests/agency/raiseStatement.js
git commit -m "test(agency): raise statement bails on reject, continues on approve"
```

---

## Task 12: Formatter support

**Files:**
- Modify: `lib/backends/agencyGenerator.ts` (function emit ~887, node emit ~1342, typeAlias emit ~417/673, interrupt emit ~498, `variableTypeToString`)
- Test: `lib/backends/agencyGenerator.test.ts` or co-located formatter test (find existing: `grep -rl "agencyGenerator\|formatAgency\|AgencyGenerator" lib/backends/*.test.ts tests`)

- [ ] **Step 1: Write the failing test (exact input→output, matching the existing harness)**

The existing formatter tests in `lib/backends/agencyGenerator.test.ts` use
exact `input → expectedOutput` string comparison (e.g. `"def add(x:
number) { x }"` → `"def add(x: number) {\nx\n}"`), NOT round-trip equality.
Follow that style. First read that file to copy the exact invocation
(`new AgencyGenerator(...)` and which method/format call produces the
string).

Add cases (the `expectedOutput` strings below are the *intended* shape;
confirm exact whitespace/newlines against how the generator emits other
constructs and adjust — derive each from a first run, then lock it in):

```typescript
{
  description: "effectSet declaration",
  input: "effectSet FsKinds = <std::read, std::write>",
  expectedOutput: "effectSet FsKinds = <std::read, std::write>",
},
{
  description: "raises clause with inline set on a def",
  input: 'def f(): string raises <std::read> { raise std::read("m", {}) }',
  expectedOutput: 'def f(): string raises <std::read> {\nraise std::read("m", {})\n}',
},
{
  description: "raises clause referencing a named set on a node",
  input: 'node main() raises FsKinds { print("hi") }',
  expectedOutput: 'node main() raises FsKinds {\nprint("hi")\n}',
},
{
  description: "raises <*> and raises <> round-trip verbatim",
  input: "def a(): number raises <*> { return 1 }",
  expectedOutput: "def a(): number raises <*> {\nreturn 1\n}",
},
```

Cover the four sites: `effectSet` decl, `raises` inline set, `raises`
named-set reference, and the `raise` statement; plus `<*>`/`<>` verbatim.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/backends/agencyGenerator.test.ts 2>&1 | tee /tmp/t12.txt`
Expected: FAIL — formatter drops `raises`/`effectSet`/`raise`, or renders `<...>` as a `|` union.

- [ ] **Step 3: Add ONE canonical effect-set renderer (the single "how")**

To avoid scattering effect-set formatting across the union branch, the
function emit, and the node emit (which would be the "imperative
everywhere" / nested-ternary anti-patterns from `docs/dev/anti-patterns.md`),
introduce a single declarative helper next to `variableTypeToString` in
`lib/backends/agencyGenerator.ts`. Every site that needs to render an
effect set calls this one function; guard clauses, no nested ternaries:

```typescript
/**
 * Render an effect-set TYPE to its `<...>` surface form. Single source of
 * truth for effect-set formatting, used by:
 *   - the `effectSet X = <...>` declaration RHS,
 *   - the flagged-union branch of `variableTypeToString`,
 *   - `raises` clauses on functions and nodes.
 * Splitting this out keeps the "what" (print this effect set) in one place
 * so future syntax changes touch exactly one function.
 */
function effectSetToSource(
  type: VariableType,
  typeAliases: Record<string, VariableType>,
): string {
  // `<*>` is represented as the `any` primitive; only effect-set position
  // renders it as `<*>` (a plain return-type `any` still prints `any`).
  if (type.type === "primitiveType" && type.value === "any") return "<*>";
  // A bare effect-set reference: `raises FsKinds` — no angle brackets.
  if (type.type === "typeAliasVariable") return type.aliasName;
  if (type.type === "unionType") {
    return `<${type.types.map((m) => effectSetMemberToSource(m, typeAliases)).join(", ")}>`;
  }
  return variableTypeToString(type, typeAliases, true);
}

function effectSetMemberToSource(
  m: VariableType,
  typeAliases: Record<string, VariableType>,
): string {
  if (m.type === "stringLiteralType") return m.value; // label, unquoted
  if (m.type === "typeAliasVariable") return m.aliasName; // nested set ref
  return variableTypeToString(m, typeAliases, true);
}
```

- [ ] **Step 4: Route the `variableTypeToString` union branch through the helper**

In the `unionType` case of `variableTypeToString`, add a guard at the top
that delegates flagged unions to the single renderer (so the effectSet
declaration RHS and any nested flagged union print as `<...>`):

```typescript
// inside variableTypeToString, unionType case, before the `a | b` logic:
if (node.isEffectSet) return effectSetToSource(node, typeAliases);
```

- [ ] **Step 5: Emit `effectSet` for flagged type aliases**

In the `typeAlias` emit path (~417/673), when `node.isEffectSet` is true,
emit `effectSet NAME = <...>` (keyword `effectSet`, RHS via
`variableTypeToString`, which now delegates to `effectSetToSource`)
instead of `type NAME = ...`. Preserve the `export` prefix.

- [ ] **Step 6: Emit `raises` clauses on functions and nodes via the same helper**

At the function emit (~887) and node emit (~1342), after the return-type
string is built, append the raises clause when `node.raises` is present —
calling the **same** `effectSetToSource` helper (no inline ternary, no
duplicated logic between the two emit sites):

```typescript
const raisesStr = node.raises
  ? ` raises ${effectSetToSource(node.raises, this.typeAliases)}`
  : "";
```

Insert `raisesStr` into the signature line, after `returnTypeStr` and
before ` {`. (For the no-return-type case, `returnTypeStr` is empty, so the
signature becomes `def f()` + ` raises <...>` + ` {` — verify spacing.)
Per the spec, preserve `<*>`/`<>` verbatim (no normalization) — which falls
out of `effectSetToSource` automatically.

- [ ] **Step 7: Emit `raise` for `viaRaise` interrupt statements**

At the interrupt emit (~498), when `node.viaRaise` is true, render `raise std::write(args)` (or `raise(args)` for effect `"unknown"`) instead of `interrupt ...`. Otherwise keep the existing `interrupt`/`return interrupt` rendering.

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm test:run lib/backends/agencyGenerator.test.ts 2>&1 | tee /tmp/t12.txt`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.test.ts
git commit -m "feat(formatter): emit effectSet, raises clauses, raise, <...> sets"
```

---

## Task 13: Import/export of `effectSet` end-to-end

**Files:**
- Test: `lib/typeChecker/effectSetImport.test.ts` (create) — cross-module vitest test

- [ ] **Step 1: Confirm the import syntax + a cross-module example**

Run: `cat tests/agency/imports.agency 2>/dev/null; grep -rln "export effectSet\|export type" tests stdlib | head`

Confirm how Agency spells `import { X } from "..."` and the path form
(relative vs `pkg::`). Adapt the test below to the real import syntax.

- [ ] **Step 2: Write the failing cross-module test**

Write both modules into one temp dir and run the pipeline on the importer
(this exercises `SymbolTable.build`'s real import resolution — the thing
that must surface the imported `effectSet` into the importer's
`getTypeAliases()`):

```typescript
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function typecheckImporter(files: Record<string, string>, entry: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agency-imp-"));
  for (const [name, src] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), src);
  }
  const entryPath = path.join(dir, entry);
  const src = files[entry];
  const parsed = parseAgency(src);
  if (!parsed.success) throw new Error(`parse failed: ${(parsed as any).message}`);
  const symbols = SymbolTable.build(entryPath);
  const info = buildCompilationUnit(parsed.result, symbols, entryPath, src);
  return typeCheck(parsed.result, {}, info).errors;
}

describe("cross-module effectSet import", () => {
  it("resolves and enforces an imported effect set", () => {
    const errors = typecheckImporter(
      {
        "lib.agency": "export effectSet FsKinds = <std::read>\n",
        "main.agency":
          'import { FsKinds } from "./lib"\n' +     // adapt to real import syntax
          'def f(): number raises FsKinds { raise std::write("m", {})\n return 1 }\n',
      },
      "main.agency",
    );
    // std::write is not in the imported FsKinds (<std::read>) → error
    expect(errors.find((e: any) => /raises effect 'std::write'/.test(e.message))).toBeDefined();
  });

  it("accepts an inferred effect that IS in the imported set", () => {
    const errors = typecheckImporter(
      {
        "lib.agency": "export effectSet FsKinds = <std::read>\n",
        "main.agency":
          'import { FsKinds } from "./lib"\n' +
          'def f(): number raises FsKinds { raise std::read("m", {})\n return 1 }\n',
      },
      "main.agency",
    );
    expect(errors.filter((e: any) => /raises effect/.test(e.message))).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify**

Run: `pnpm test:run lib/typeChecker/effectSetImport.test.ts 2>&1 | tee /tmp/t13.txt`
Expected: Because `effectSet` is a `typeAlias` node and `compilationUnit.ts`
adds imported aliases via `unit.typeAliases.add(...)`, resolution should
work. If the first case does NOT produce the error (imported alias absent
from `getTypeAliases()`), the gap is in how imported type aliases reach the
importer's registry — fix in `compilationUnit.ts` so imported effect-set
aliases land in the importer's `typeAliases`, then re-run. If imports of a
relative path don't resolve in a temp dir, write the two files under a
package-internal `tests/tmp/` dir instead of `os.tmpdir()`.

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/effectSetImport.test.ts
git commit -m "test: cross-module effectSet import resolves and is enforced"
```

---

## Task 14: Documentation

**Files:**
- Modify: `docs/site/guide/interrupts.md` and/or `docs/site/guide/handlers.md`
- Optionally create: `docs/site/guide/effects.md` (a focused page for `raises`/`effectSet`/`raise`)
- Modify: changelog (use the `util:changelog` skill, or follow the repo's changelog convention — `grep -rl "Unreleased\|CHANGELOG" docs .. | head`)

- [ ] **Step 1: Document the feature**

Write user-facing docs covering: `effectSet` declarations and `<...>` syntax (including `<>` and `<*>`); the `raises` clause on functions and nodes (optional; upper bound; omitted = anything; `<>` = nothing); the `raise` statement (and how it differs from `interrupt(...)` and from the JS-error `throw(...)`); and that local handling does not exempt declaration (link to the handler-chain semantics). Keep examples syntactically correct per `docs/site/guide/basic-syntax.md`.

- [ ] **Step 2: Verify docs examples parse**

For each non-trivial Agency snippet, confirm it parses by pasting into a scratch `.agency` file in the package directory (NOT `/tmp`) and running `pnpm run ast <file>`. Expected: no parse errors.

- [ ] **Step 3: Update the changelog**

Add an entry summarizing: effect sets, `raises` declarations with compile-time subset checking, and the `raise` statement.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: effect sets, raises declarations, and the raise statement"
```

---

## Final verification

- [ ] **Run all new unit tests together:**

```bash
pnpm test:run \
  lib/parsers/effectSet.test.ts \
  lib/parsers/raisesClause.test.ts \
  lib/parsers/raiseStatement.test.ts \
  lib/parsers/interruptStatement.test.ts \
  lib/typeChecker/effectSets.test.ts \
  lib/typeChecker/raisesDiagnostic.test.ts \
  lib/typeChecker/effectSetImport.test.ts \
  lib/backends/agencyGenerator.test.ts \
  2>&1 | tee /tmp/final.txt
```
Expected: all PASS.

- [ ] **Run the interrupt-analysis regression tests** (ensure inference still works, and bare-effect interrupt parsing didn't break existing cases):

```bash
pnpm test:run lib/typeChecker/interruptAnalysis.test.ts lib/typeChecker/interruptCallGraph.test.ts 2>&1 | tee /tmp/final2.txt
```
Expected: all PASS.

- [ ] **Run the function-parser regression** (raises clause is optional; existing defs unaffected):

```bash
pnpm test:run lib/parsers/function.test.ts 2>&1 | tee /tmp/final3.txt
```
Expected: all PASS.

- [ ] **Do NOT run the full agency execution suite locally** (slow/expensive — CI runs it). Only the one targeted `tests/agency/raiseStatement.agency` test from Task 11.

---

## Self-review notes (spec coverage)

- Effect-set declarations + `<...>`/`<>`/`<*>` → Tasks 2, 3.
- Bare (non-namespaced) effects everywhere → Task 2 (sets), Task 7 (raise + relaxed interrupt parser), Task 8 (resolver disambiguation).
- `raises` on defs / nodes / function types → Tasks 4, 5, 6 (function-type compatibility check is explicitly descoped — Task 6 scope note).
- `raise` statement (parse + codegen reuse) → Tasks 7, 11.
- Lowering to unions + `isEffectSet` flag (incl. on `TypeAliasEntry`) → Tasks 1, 2, 3, 10.
- Subset check (inferred ⊆ declared), `<>`/`<*>`/omitted semantics, bespoke message, no "handle it locally" advice, node-level, transitive, multiple-effects → Task 9.
- `raises` must reference an effect set (known wrong-kind alias errors; unknown bare = literal effect) → Task 10.
- Import/export reuse → Task 3 (pickup) + Task 13 (cross-module end-to-end).
- Formatter (exact input→output, single `effectSetToSource` helper) → Task 12.
- Decision A (local handling still counts): Task 9 "flags a locally-handled effect" case.
- Diagnostic interaction (no double-report with `checkHandlerBodyInterrupts`): Task 9 last case.
- False-positive guard (valid program → no errors): Task 9.
- Tests use the full pipeline via `typecheckSource` (see "How to test"); typecheck errors are vitest-only, runtime behavior is the one `tests/agency` test.

## Known Phase-1 limitations (documented, not bugs)

- Function-type `raises` is parsed/formatted but callback-raises
  compatibility is not checked (deferred with row polymorphism).
- A typo'd bare effect-set reference silently degrades to a literal effect
  label (cost of allowing non-namespaced effects).
- Effects routed through fully dynamic/opaque function values may be
  under-counted (inherits existing `analyzeInterruptsFromScopes` behavior;
  no synthetic `<*>` injection).
