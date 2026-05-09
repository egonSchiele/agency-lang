# Function Identity Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `functionRefType` to the type system so the type checker tracks which variables/expressions refer to specific functions, then use this to replace the ad-hoc interrupt analyzer with type-system-based analysis.

**Architecture:** A new `functionRefType` variant in `VariableType` carries function name + signature. The synthesizer produces it for bare function names. A new `function` primitive type is added for user annotations. The interrupt analyzer moves from the symbol table phase into the type checker, using `functionRefType` to resolve tool references instead of special-case AST walking.

**Tech Stack:** TypeScript, vitest, tarsec parser combinators

---

## File Structure

**Create:**
- `lib/typeChecker/interruptAnalysis.ts` — interrupt call graph building + transitive propagation (replaces `interruptAnalyzer.ts`)
- `lib/typeChecker/interruptAnalysis.test.ts` — tests for the new analysis

**Delete:**
- `lib/interruptAnalyzer.ts` — replaced by type-checker-based analysis
- `lib/interruptAnalyzer.test.ts` — replaced by new tests

**Modify:**
- `lib/types/typeHints.ts` — add `FunctionRefType` to `VariableType` union
- `lib/parsers/parsers.ts` — add `"function"` to `primitiveTypeParser`
- `lib/parsers/typeHints.test.ts` — test `function` as a primitive type
- `lib/typeChecker/synthesizer.ts` — produce `functionRefType` for bare function names, simplify `synthPipeRhs`
- `lib/typeChecker/assignability.ts` — assignability rules for `functionRefType` and `function` primitive
- `lib/typeChecker/index.ts` — wire in interrupt analysis, add `interruptKindsByFunction` to `TypeCheckResult`
- `lib/typeChecker/types.ts` — add `interruptKindsByFunction` to `TypeCheckResult`
- `lib/cli/util.ts` — `formatTypeHint` case for `functionRefType`
- `lib/symbolTable.ts` — collect direct interrupt kinds in `classifySymbols`
- `lib/compilationUnit.ts` — remove dependency on `analyzeInterrupts`
- `lib/cli/serve.ts` — run type checker in `compileForServe`, source interrupt kinds from type check result
- `lib/lsp/semantics.ts` — source interrupt kinds from type check result instead of symbol table
- `lib/lsp/diagnostics.ts` — pass `interruptKindsByFunction` from type check result to semantic index
- `lib/typeChecker/typeWalker.ts` — add `functionRefType` case to `visitTypes`

---

### Task 1: Add `functionRefType` to the type system

**Files:**
- Modify: `lib/types/typeHints.ts`
- Modify: `lib/cli/util.ts:312-347`
- Modify: `lib/typeChecker/assignability.ts:49-52`

- [ ] **Step 1: Add `FunctionRefType` to the `VariableType` union**

In `lib/types/typeHints.ts`, add the new type variant and include it in the union:

```typescript
// Add to the VariableType union (after ResultType):
  | FunctionRefType;

// Add the type definition (after ResultType):
export type FunctionRefType = {
  type: "functionRefType";
  name: string;
  params: FunctionParameter[];
  returnType: VariableType | null;
  returnTypeValidated?: boolean;
};
```

Also add the import for `FunctionParameter`:

```typescript
import type { FunctionParameter } from "./function.js";
```

- [ ] **Step 2: Add `formatTypeHint` case for `functionRefType`**

In `lib/cli/util.ts`, add a case in the `formatTypeHint` switch before the `default`:

```typescript
    case "functionRefType": {
      const params = vt.params
        .map((p) => `${p.name}${p.typeHint ? `: ${recurse(p.typeHint)}` : ""}`)
        .join(", ");
      const ret = vt.returnType ? `: ${recurse(vt.returnType)}` : "";
      return `function ${vt.name}(${params})${ret}`;
    }
```

- [ ] **Step 3: Add `functionRefType` case to `visitTypes` in `typeWalker.ts`**

In `lib/typeChecker/typeWalker.ts`, add a case in the switch for `functionRefType` so nested types in params and return type are visited:

```typescript
    case "functionRefType":
      for (const p of t.params) {
        if (p.typeHint && visitTypes(p.typeHint, visit)) return true;
      }
      return t.returnType ? visitTypes(t.returnType, visit) : false;
```

- [ ] **Step 4: Verify `widenType` handles `functionRefType`**

In `lib/typeChecker/assignability.ts`, the `widenType` function has a `default` case that returns `vt` as-is. `functionRefType` should pass through unchanged (it doesn't contain literal types that need widening), so the existing `default` case handles it. No change needed — just verify this.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:run 2>&1 | tee /tmp/task1.txt | tail -5`
Expected: All tests pass. The new type exists but nothing produces it yet.

- [ ] **Step 6: Commit**

```
git add lib/types/typeHints.ts lib/cli/util.ts lib/typeChecker/typeWalker.ts
git commit -m "Add functionRefType variant to VariableType union"
```

---

### Task 2: Add `function` primitive type to the parser

**Files:**
- Modify: `lib/parsers/parsers.ts:590-610`
- Modify: `lib/parsers/typeHints.test.ts`

- [ ] **Step 1: Write the failing test**

In `lib/parsers/typeHints.test.ts`, add a test case to the `primitiveTypeParser` `testCases` array (after the `regex` entry):

```typescript
    {
      input: "function",
      expected: {
        success: true,
        result: { type: "primitiveType", value: "function" },
      },
    },
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:run lib/parsers/typeHints.test.ts 2>&1 | tee /tmp/task2a.txt | tail -10`
Expected: FAIL — `primitiveTypeParser` does not recognize `"function"`.

- [ ] **Step 3: Add `"function"` to the parser**

In `lib/parsers/parsers.ts`, add `str("function")` to the `primitiveTypeParser`'s `or(...)` list, after `str("object")`:

```typescript
        str("object"),
        str("function"),
        str("regex"),
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:run lib/parsers/typeHints.test.ts 2>&1 | tee /tmp/task2b.txt | tail -5`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add lib/parsers/parsers.ts lib/parsers/typeHints.test.ts
git commit -m "Add function as a primitive type in the parser"
```

---

### Task 3: Assignability rules for `functionRefType`

**Files:**
- Modify: `lib/typeChecker/assignability.ts:71-239`
- Test: `lib/typeChecker/assignability.test.ts` (or wherever existing assignability tests are)

- [ ] **Step 1: Find existing assignability tests**

Run: `find lib/typeChecker -name '*.test.ts' | head -20`

Look for assignability tests. If there's a dedicated test file, add tests there. If tests are in `typeChecker.test.ts` or similar, add there.

- [ ] **Step 2: Write failing tests for `functionRefType` assignability**

Add these test cases (adjust file path based on step 1):

```typescript
describe("functionRefType assignability", () => {
  const fnRef: VariableType = {
    type: "functionRefType",
    name: "deploy",
    params: [{ type: "functionParameter", name: "env", typeHint: { type: "primitiveType", value: "string" } }],
    returnType: { type: "primitiveType", value: "void" },
  };

  it("is assignable to any", () => {
    expect(isAssignable(fnRef, { type: "primitiveType", value: "any" }, {})).toBe(true);
  });

  it("is assignable to function primitive", () => {
    expect(isAssignable(fnRef, { type: "primitiveType", value: "function" }, {})).toBe(true);
  });

  it("function primitive is assignable to any", () => {
    expect(isAssignable({ type: "primitiveType", value: "function" }, { type: "primitiveType", value: "any" }, {})).toBe(true);
  });

  it("two functionRefTypes with compatible signatures are mutually assignable", () => {
    const other: VariableType = {
      type: "functionRefType",
      name: "redeploy",
      params: [{ type: "functionParameter", name: "environment", typeHint: { type: "primitiveType", value: "string" } }],
      returnType: { type: "primitiveType", value: "void" },
    };
    expect(isAssignable(fnRef, other, {})).toBe(true);
    expect(isAssignable(other, fnRef, {})).toBe(true);
  });

  it("two functionRefTypes with incompatible params are not assignable", () => {
    const other: VariableType = {
      type: "functionRefType",
      name: "add",
      params: [
        { type: "functionParameter", name: "a", typeHint: { type: "primitiveType", value: "number" } },
        { type: "functionParameter", name: "b", typeHint: { type: "primitiveType", value: "number" } },
      ],
      returnType: { type: "primitiveType", value: "number" },
    };
    expect(isAssignable(fnRef, other, {})).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify tests fail**

Run: `pnpm test:run <test-file> 2>&1 | tee /tmp/task3a.txt | tail -10`
Expected: FAIL — `functionRefType` has no assignability rules yet.

- [ ] **Step 4: Implement assignability rules**

In `lib/typeChecker/assignability.ts`, add these rules in `isAssignable` after the `objectType` assignability check (before `return false`):

```typescript
  // functionRefType is assignable to the "function" primitive
  if (
    resolvedSource.type === "functionRefType" &&
    resolvedTarget.type === "primitiveType" &&
    resolvedTarget.value === "function"
  ) {
    return true;
  }

  // Two functionRefTypes: compatible if same arity and compatible param/return types
  // (contravariant params, covariant return — same as blockType)
  if (
    resolvedSource.type === "functionRefType" &&
    resolvedTarget.type === "functionRefType"
  ) {
    const sourceParams = resolvedSource.params.filter((p) => !p.variadic);
    const targetParams = resolvedTarget.params.filter((p) => !p.variadic);
    if (sourceParams.length !== targetParams.length) return false;
    for (let i = 0; i < sourceParams.length; i++) {
      const sourceHint = sourceParams[i].typeHint;
      const targetHint = targetParams[i].typeHint;
      if (!sourceHint || !targetHint) continue;
      if (!isAssignable(targetHint, sourceHint, typeAliases)) return false;
    }
    if (resolvedSource.returnType && resolvedTarget.returnType) {
      return isAssignable(resolvedSource.returnType, resolvedTarget.returnType, typeAliases);
    }
    return true;
  }
```

- [ ] **Step 5: Run to verify tests pass**

Run: `pnpm test:run <test-file> 2>&1 | tee /tmp/task3b.txt | tail -5`
Expected: PASS

- [ ] **Step 6: Commit**

```
git add lib/typeChecker/assignability.ts <test-file>
git commit -m "Add assignability rules for functionRefType and function primitive"
```

---

### Task 4: Synthesizer produces `functionRefType`

**Files:**
- Modify: `lib/typeChecker/synthesizer.ts:51-90` and `208-228`

- [ ] **Step 1: Write failing tests**

Create tests in an appropriate test file (or add to existing synthesizer tests). These need the full type checker pipeline. Use the pattern from `interruptWarnings.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function getInferredType(source: string, varName: string) {
  const file = path.join(os.tmpdir(), `synth-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`);
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const info = buildCompilationUnit(parseResult.result, symbolTable, absPath, source);
    const { scopes } = typeCheck(parseResult.result, {}, info);
    for (const scopeInfo of scopes) {
      const t = scopeInfo.scope.lookup(varName);
      if (t && t !== "any") return t;
    }
    return "any";
  } finally {
    unlinkSync(file);
  }
}

describe("functionRefType synthesis", () => {
  it("synthesizes functionRefType for a bare function name in an array", () => {
    const t = getInferredType(`
      def deploy(env: string): void {}
      node main() {
        let tools = [deploy]
      }
    `, "tools");
    expect(t).not.toBe("any");
    if (t !== "any" && t.type === "arrayType") {
      expect(t.elementType.type).toBe("functionRefType");
      if (t.elementType.type === "functionRefType") {
        expect(t.elementType.name).toBe("deploy");
      }
    }
  });

  it("synthesizes functionRefType for imported functions", () => {
    // This test needs cross-file setup — use two temp files
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const libFile = path.join(os.tmpdir(), `synth-lib-${suffix}.agency`);
    const mainFile = path.join(os.tmpdir(), `synth-main-${suffix}.agency`);
    writeFileSync(libFile, `export def greet(name: string): string { return name }`);
    const mainSource = `
      import { greet } from "${libFile}"
      node main() {
        let tools = [greet]
      }
    `;
    writeFileSync(mainFile, mainSource);
    try {
      const absPath = path.resolve(mainFile);
      const symbolTable = SymbolTable.build(absPath);
      const parseResult = parseAgency(mainSource, {});
      if (!parseResult.success) throw new Error("Parse failed");
      const info = buildCompilationUnit(parseResult.result, symbolTable, absPath, mainSource);
      const { scopes } = typeCheck(parseResult.result, {}, info);
      for (const scopeInfo of scopes) {
        const t = scopeInfo.scope.lookup("tools");
        if (t && t !== "any" && t.type === "arrayType") {
          expect(t.elementType.type).toBe("functionRefType");
          return;
        }
      }
      throw new Error("Expected tools to be arrayType<functionRefType>");
    } finally {
      unlinkSync(mainFile);
      unlinkSync(libFile);
    }
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `pnpm test:run <test-file> 2>&1 | tee /tmp/task4a.txt | tail -10`
Expected: FAIL — `synthType` returns `"any"` for bare function names.

- [ ] **Step 3: Implement `functionRefType` synthesis in `synthType`**

In `lib/typeChecker/synthesizer.ts`, modify the `variableName` case in `synthType`:

```typescript
    case "variableName": {
      const scopeType = scope.lookup(expr.value);
      if (scopeType) return scopeType;
      // Bare function/node name used as a value — produce functionRefType
      const fnDef = ctx.functionDefs[expr.value];
      if (fnDef) {
        return {
          type: "functionRefType",
          name: expr.value,
          params: fnDef.parameters,
          returnType: fnDef.returnType ?? null,
          returnTypeValidated: fnDef.returnTypeValidated,
        };
      }
      const nodeDef = ctx.nodeDefs[expr.value];
      if (nodeDef) {
        return {
          type: "functionRefType",
          name: expr.value,
          params: nodeDef.parameters,
          returnType: nodeDef.returnType ?? null,
          returnTypeValidated: nodeDef.returnTypeValidated,
        };
      }
      const imported = ctx.importedFunctions[expr.value];
      if (imported) {
        return {
          type: "functionRefType",
          name: expr.value,
          params: imported.parameters,
          returnType: imported.returnType ?? null,
        };
      }
      return "any";
    }
```

Add the import for `FunctionRefType` at the top of `synthesizer.ts` if needed (it's part of `VariableType` which is already imported via `"../types.js"`).

- [ ] **Step 4: Simplify `synthPipeRhs`**

The manual fallback lookup in `synthPipeRhs` is now redundant. Replace the function body:

```typescript
function synthPipeRhs(
  rhs: AgencyNode,
  scope: Scope,
  ctx: TypeCheckerContext,
): VariableType | "any" {
  const rhsType = synthType(rhs, scope, ctx);
  if (rhsType !== "any" && rhsType.type === "functionRefType") {
    const returnType = rhsType.returnType;
    if (returnType) return resultTypeForValidation(returnType, rhsType.returnTypeValidated);
  }
  return rhsType;
}
```

- [ ] **Step 5: Run to verify tests pass**

Run: `pnpm test:run 2>&1 | tee /tmp/task4b.txt | tail -5`
Expected: All tests pass (including the new ones and all existing pipe tests).

- [ ] **Step 6: Commit**

```
git add lib/typeChecker/synthesizer.ts <test-file>
git commit -m "Synthesizer produces functionRefType for bare function names"
```

---

### Task 5: Collect direct interrupt kinds in `classifySymbols`

**Files:**
- Modify: `lib/symbolTable.ts:217-275`
- Test: `lib/symbolTable.test.ts`

- [ ] **Step 1: Add direct interrupt collection to `classifySymbols`**

In `lib/symbolTable.ts`, modify `classifySymbols`. After the existing `case "graphNode"` and `case "function"` blocks, walk the body to find `interrupt` statements. Replace the two cases:

```typescript
      case "graphNode":
        symbols[node.nodeName] = {
          kind: "node",
          name: node.nodeName,
          loc: node.loc,
          parameters: node.parameters,
          returnType: node.returnType ?? null,
          returnTypeValidated: node.returnTypeValidated,
          exported: !!node.exported,
          interruptKinds: collectDirectInterruptKinds(node.body),
        };
        break;
      case "function":
        symbols[node.functionName] = {
          kind: "function",
          name: node.functionName,
          loc: node.loc,
          safe: !!node.safe,
          exported: !!node.exported,
          parameters: node.parameters,
          returnType: node.returnType ?? null,
          returnTypeValidated: node.returnTypeValidated,
          interruptKinds: collectDirectInterruptKinds(node.body),
        };
        break;
```

Add the helper function:

```typescript
function collectDirectInterruptKinds(body: AgencyNode[]): InterruptKind[] {
  const kinds: string[] = [];
  for (const { node } of walkNodes(body)) {
    if (node.type === "interruptStatement" && !kinds.includes(node.kind)) {
      kinds.push(node.kind);
    }
  }
  return kinds.map((k) => ({ kind: k }));
}
```

- [ ] **Step 2: Remove `analyzeInterrupts` from `SymbolTable.build`**

In `lib/symbolTable.ts`, in `SymbolTable.build`:
- Remove the import of `analyzeInterrupts` from `"./interruptAnalyzer.js"`
- Replace `const analyzedFiles = analyzeInterrupts(parsed);` with building file symbols directly from `parsed`
- Change `return new SymbolTable(analyzedFiles);` to:

```typescript
    const files: Record<string, FileSymbols> = {};
    for (const [filePath, { symbols }] of Object.entries(parsed)) {
      files[filePath] = symbols;
    }
    return new SymbolTable(files);
```

- [ ] **Step 3: Update symbol table tests**

The existing tests in `lib/symbolTable.test.ts` that test transitive interrupt propagation will fail — they relied on the analyzer. Update them to only test direct interrupt kinds (no transitive propagation). Transitive tests will move to the type checker in Task 7.

- [ ] **Step 4: Run tests**

Run: `pnpm test:run lib/symbolTable.test.ts 2>&1 | tee /tmp/task5.txt | tail -10`
Expected: Symbol table tests pass with direct-only interrupt kinds.

- [ ] **Step 5: Commit**

```
git add lib/symbolTable.ts lib/symbolTable.test.ts
git commit -m "Collect direct interrupt kinds in classifySymbols, remove analyzeInterrupts"
```

---

### Task 6: Delete the interrupt analyzer

**Files:**
- Delete: `lib/interruptAnalyzer.ts`
- Delete: `lib/interruptAnalyzer.test.ts`
- Modify: `lib/compilationUnit.ts` (remove import if present)

- [ ] **Step 1: Delete the files**

```bash
rm lib/interruptAnalyzer.ts lib/interruptAnalyzer.test.ts
```

- [ ] **Step 2: Remove any remaining imports**

Check `lib/compilationUnit.ts` and any other files for imports of `interruptAnalyzer`. Remove them. The compilation unit should still populate `interruptKindsByFunction` from the symbol table's direct interrupt kinds (this already works since `classifySymbols` now sets them).

- [ ] **Step 3: Run tests**

Run: `pnpm test:run 2>&1 | tee /tmp/task6.txt | tail -10`
Expected: All tests pass. Some `interruptWarnings.test.ts` tests that relied on transitive propagation may fail — that's expected and will be fixed in Task 7.

- [ ] **Step 4: Commit**

```
git add -A
git commit -m "Delete interruptAnalyzer module (replaced by type-checker-based analysis)"
```

---

### Task 7: Interrupt analysis in the type checker

**Files:**
- Create: `lib/typeChecker/interruptAnalysis.ts`
- Create: `lib/typeChecker/interruptAnalysis.test.ts`
- Modify: `lib/typeChecker/index.ts`
- Modify: `lib/typeChecker/types.ts`

- [ ] **Step 1: Add `interruptKindsByFunction` to `TypeCheckResult`**

In `lib/typeChecker/types.ts`, add to `TypeCheckResult`:

```typescript
export type TypeCheckResult = {
  errors: TypeCheckError[];
  scopes: ScopeInfo[];
  interruptKindsByFunction: Record<string, InterruptKind[]>;
};
```

Add the import:

```typescript
import type { InterruptKind } from "../symbolTable.js";
```

- [ ] **Step 2: Create `lib/typeChecker/interruptAnalysis.ts`**

This module builds a call graph from the type checker's perspective and does transitive propagation using `functionRefType`:

```typescript
import type { InterruptKind } from "../symbolTable.js";
import type { TypeCheckerContext, ScopeInfo } from "./types.js";
import { synthType } from "./synthesizer.js";
import { walkNodes } from "../utils/node.js";
import type { Expression, VariableType } from "../types.js";
import type { SplatExpression, NamedArgument } from "../types/dataStructures.js";
import type { Scope } from "./scope.js";

/** Per-function analysis: what it directly interrupts and what it calls. */
type FunctionProfile = {
  kinds: string[];
  callees: string[];
};

/**
 * Declarative pipeline: collect per-scope profiles → propagate transitively → format.
 */
export function analyzeInterruptsFromScopes(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): Record<string, InterruptKind[]> {
  const profiles = collectProfiles(scopes, ctx);
  propagateTransitively(profiles);
  return formatResult(profiles);
}

// -- Phase 1: Collect --

function collectProfiles(
  scopes: ScopeInfo[],
  ctx: TypeCheckerContext,
): Record<string, FunctionProfile> {
  const profiles: Record<string, FunctionProfile> = {};

  // Seed imported functions' direct kinds
  for (const [name, importedKinds] of Object.entries(ctx.interruptKindsByFunction)) {
    profiles[name] = { kinds: importedKinds.map((ik) => ik.kind), callees: [] };
  }

  // Analyze each scope
  for (const info of scopes) {
    profiles[info.name] = collectFromScope(info, ctx);
  }

  return profiles;
}

function collectFromScope(info: ScopeInfo, ctx: TypeCheckerContext): FunctionProfile {
  const kinds: string[] = [];
  const callees: string[] = [];

  for (const { node } of walkNodes(info.body)) {
    if (node.type === "interruptStatement") {
      addUnique(kinds, node.kind);
    } else if (node.type === "functionCall") {
      addUnique(callees, node.functionName);
      for (const name of functionRefsInArgs(node.arguments, info.scope, ctx)) {
        addUnique(callees, name);
      }
    } else if (node.type === "gotoStatement") {
      addUnique(callees, node.nodeCall.functionName);
    }
  }

  return { kinds, callees };
}

// -- Phase 2: Propagate --

function propagateTransitively(profiles: Record<string, FunctionProfile>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const profile of Object.values(profiles)) {
      for (const callee of profile.callees) {
        const calleeKinds = profiles[callee]?.kinds ?? [];
        for (const kind of calleeKinds) {
          if (!profile.kinds.includes(kind)) {
            profile.kinds.push(kind);
            changed = true;
          }
        }
      }
    }
  }
}

// -- Phase 3: Format --

function formatResult(
  profiles: Record<string, FunctionProfile>,
): Record<string, InterruptKind[]> {
  const result: Record<string, InterruptKind[]> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.kinds.length > 0) {
      result[name] = profile.kinds.map((k) => ({ kind: k }));
    }
  }
  return result;
}

// -- Helpers --

/** Extract function names referenced in arguments via functionRefType synthesis. */
function functionRefsInArgs(
  args: (Expression | SplatExpression | NamedArgument)[],
  scope: Scope,
  ctx: TypeCheckerContext,
): string[] {
  const names: string[] = [];
  for (const arg of args) {
    if (arg.type === "splat" || arg.type === "namedArgument") continue;
    functionNamesFromType(synthType(arg, scope, ctx), names);
  }
  return names;
}

/** Recursively extract function names from a synthesized type. */
function functionNamesFromType(t: VariableType | "any", out: string[]): void {
  if (t === "any") return;
  switch (t.type) {
    case "functionRefType":
      addUnique(out, t.name);
      break;
    case "arrayType":
      functionNamesFromType(t.elementType, out);
      break;
    case "objectType":
      for (const prop of t.properties) functionNamesFromType(prop.value, out);
      break;
    case "unionType":
      for (const member of t.types) functionNamesFromType(member, out);
      break;
  }
}

function addUnique(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}
```

- [ ] **Step 3: Wire into the type checker**

In `lib/typeChecker/index.ts`, import and call the new analysis after `checkScopes`:

```typescript
import { analyzeInterruptsFromScopes } from "./interruptAnalysis.js";
```

In the `check()` method, after `checkScopes(scopes, ctx)`:

```typescript
    // 5. Analyze interrupts using functionRefType
    const interruptKindsByFunction = analyzeInterruptsFromScopes(scopes, ctx);
```

Update the return statement:

```typescript
    return { errors: this.applySuppressions(this.deduplicateErrors()), scopes, interruptKindsByFunction };
```

- [ ] **Step 4: Update all callers of `typeCheck` that destructure `TypeCheckResult`**

Search for `const { errors` or `const { scopes` patterns that destructure `typeCheck` results. Add `interruptKindsByFunction` where needed, or just ensure destructuring doesn't break (TypeScript will catch missing fields).

- [ ] **Step 5: Write tests for transitive interrupt analysis**

Create `lib/typeChecker/interruptAnalysis.test.ts`. Migrate key scenarios from the deleted `interruptAnalyzer.test.ts`, testing through the full type checker pipeline:

```typescript
import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function interruptKindsFor(source: string, funcName: string): string[] {
  const file = path.join(os.tmpdir(), `int-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`);
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath);
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const info = buildCompilationUnit(parseResult.result, symbolTable, absPath, source);
    const { interruptKindsByFunction } = typeCheck(parseResult.result, {}, info);
    return (interruptKindsByFunction[funcName] ?? []).map((ik) => ik.kind).sort();
  } finally {
    unlinkSync(file);
  }
}

describe("interrupt analysis via type checker", () => {
  it("collects direct interrupt kinds", () => {
    expect(interruptKindsFor(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
    `, "deploy")).toEqual(["myapp::deploy"]);
  });

  it("propagates transitively through calls", () => {
    expect(interruptKindsFor(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      def orchestrate() {
        deploy()
      }
    `, "orchestrate")).toEqual(["myapp::deploy"]);
  });

  it("handles cycles without infinite loop", () => {
    const kinds = interruptKindsFor(`
      def ping() {
        interrupt myapp::ping("Ping")
        pong()
      }
      def pong() {
        interrupt myapp::pong("Pong")
        ping()
      }
    `, "ping");
    expect(kinds).toEqual(["myapp::ping", "myapp::pong"]);
  });

  it("resolves function refs in llm tools arrays", () => {
    expect(interruptKindsFor(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      def main() {
        llm("do it", { tools: [deploy] })
      }
    `, "main")).toEqual(["myapp::deploy"]);
  });

  it("resolves function refs via variable assignment", () => {
    expect(interruptKindsFor(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      def main() {
        let tools = [deploy]
        llm("do it", { tools: tools })
      }
    `, "main")).toEqual(["myapp::deploy"]);
  });

  it("resolves function refs via spread", () => {
    expect(interruptKindsFor(`
      def deploy() {
        interrupt myapp::deploy("Deploy?")
      }
      def validate() {
        interrupt myapp::validate("Validate?")
      }
      def main() {
        let base = [deploy]
        llm("do it", { tools: [...base, validate] })
      }
    `, "main")).toEqual(["myapp::deploy", "myapp::validate"]);
  });
});
```

- [ ] **Step 6: Run all tests**

Run: `pnpm test:run 2>&1 | tee /tmp/task7.txt | tail -10`
Expected: All tests pass, including the migrated interrupt analysis tests and existing `interruptWarnings.test.ts`.

- [ ] **Step 7: Commit**

```
git add lib/typeChecker/interruptAnalysis.ts lib/typeChecker/interruptAnalysis.test.ts lib/typeChecker/index.ts lib/typeChecker/types.ts
git commit -m "Move interrupt analysis to the type checker using functionRefType"
```

---

### Task 8: Run type checker in serve pipeline

**Files:**
- Modify: `lib/cli/serve.ts`

- [ ] **Step 1: Update `compileForServe` to run the type checker**

In `lib/cli/serve.ts`, add imports:

```typescript
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck, formatErrors } from "../typeChecker/index.js";
import { parseAgency } from "../parser.js";
```

Update `compileForServe` to run the type checker and return interrupt kinds from the type check result instead of from the symbol table:

```typescript
function compileForServe(file: string): CompileResult {
  const config = loadConfig();
  const absoluteFile = path.resolve(file);
  const symbolTable = SymbolTable.build(absoluteFile, config);

  const outputPath = compile(config, file, undefined, { symbolTable });
  if (!outputPath) {
    throw new Error(`Compilation failed for ${file}`);
  }

  const fileSymbols = symbolTable.getFile(absoluteFile);
  const exportedNodeNames = Object.values(fileSymbols ?? {})
    .filter((sym) => sym.kind === "node" && sym.exported)
    .map((sym) => sym.name);

  // Run type checker to get transitive interrupt kinds
  const source = fs.readFileSync(absoluteFile, "utf-8");
  const parseResult = parseAgency(source, config);
  const interruptKindsByName: Record<string, InterruptKind[]> = {};
  if (parseResult.success) {
    const info = buildCompilationUnit(parseResult.result, symbolTable, absoluteFile, source);
    const result = typeCheck(parseResult.result, config, info);
    const warnings = result.errors.filter((e) => e.severity === "warning");
    const errors = result.errors.filter((e) => e.severity !== "warning");
    if (errors.length > 0) {
      console.error(formatErrors(errors));
    }
    if (warnings.length > 0) {
      console.error(formatErrors(warnings, "warning"));
    }
    Object.assign(interruptKindsByName, result.interruptKindsByFunction);
  }

  const moduleId = path.relative(process.cwd(), absoluteFile);
  return { outputPath, moduleId, exportedNodeNames, interruptKindsByName };
}
```

Add the `fs` import if not already present:

```typescript
import fs from "fs";
```

- [ ] **Step 2: Run tests**

Run: `pnpm test:run 2>&1 | tee /tmp/task8.txt | tail -10`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```
git add lib/cli/serve.ts
git commit -m "Run type checker in serve pipeline for interrupt analysis and error reporting"
```

---

### Task 9: Update LSP to source interrupt kinds from type checker

**Files:**
- Modify: `lib/lsp/diagnostics.ts:72-96`
- Modify: `lib/lsp/semantics.ts`

- [ ] **Step 1: Capture `interruptKindsByFunction` in `runDiagnostics`**

In `lib/lsp/diagnostics.ts`, line 73 currently reads:

```typescript
  const { errors, scopes } = typeCheck(program, config, info);
```

Change to:

```typescript
  const { errors, scopes, interruptKindsByFunction } = typeCheck(program, config, info);
```

Then pass it to `buildSemanticIndex` on line 94:

```typescript
    semanticIndex: buildSemanticIndex(program, fsPath, symbolTable, interruptKindsByFunction),
```

- [ ] **Step 2: Update `buildSemanticIndex` to accept `interruptKindsByFunction`**

In `lib/lsp/semantics.ts`, update the signature:

```typescript
export function buildSemanticIndex(
  program: AgencyProgram,
  fsPath: string,
  symbolTable: SymbolTable,
  interruptKindsByFunction?: Record<string, InterruptKind[]>,
): SemanticIndex {
```

Update `addLocalDefinition` to use `interruptKindsByFunction` when available instead of looking up from `fileSymbols`:

Change the `interruptKindsFor` helper to check `interruptKindsByFunction` first:

```typescript
function interruptKindsFor(
  fileSymbols: FileSymbols | undefined,
  name: string,
  interruptKindsByFunction?: Record<string, InterruptKind[]>,
): InterruptKind[] | undefined {
  if (interruptKindsByFunction?.[name]) return interruptKindsByFunction[name];
  const sym = fileSymbols?.[name];
  if (sym?.kind === "function" || sym?.kind === "node") return sym.interruptKinds;
  return undefined;
}
```

Thread the parameter through `addLocalDefinition` and the loop in `buildSemanticIndex`.

Also update `addImportedSymbol` to check `interruptKindsByFunction` for imported symbols:

```typescript
    interruptKinds: interruptKindsByFunction?.[opts.localName] ?? (isCallable ? sym.interruptKinds : undefined),
```

- [ ] **Step 3: Run tests**

Run: `pnpm test:run lib/lsp/ 2>&1 | tee /tmp/task9.txt | tail -10`
Expected: All LSP tests pass, including the hover test for interrupt kinds.

- [ ] **Step 4: Commit**

```
git add lib/lsp/semantics.ts lib/lsp/diagnostics.ts
git commit -m "LSP sources interrupt kinds from type checker result"
```

---

### Task 10: Final verification and cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run: `pnpm test:run 2>&1 | tee /tmp/task10.txt | tail -10`
Expected: All tests pass.

- [ ] **Step 2: Run the structural linter**

Run: `pnpm run lint:structure 2>&1 | tee /tmp/task10-lint.txt | tail -10`
Expected: No new violations.

- [ ] **Step 3: Verify interruptWarnings.test.ts still passes**

Run: `pnpm test:run lib/typeChecker/interruptWarnings.test.ts 2>&1 | tee /tmp/task10-iw.txt | tail -10`
Expected: All 11 tests pass unchanged.

- [ ] **Step 4: Verify no remaining references to `interruptAnalyzer`**

Run: `grep -r "interruptAnalyzer" lib/`
Expected: No results.

- [ ] **Step 5: Commit any final cleanup**

```
git add -A
git commit -m "Final cleanup: remove interruptAnalyzer references"
```
