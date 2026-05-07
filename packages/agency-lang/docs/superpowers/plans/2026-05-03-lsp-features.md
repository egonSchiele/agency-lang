# LSP Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add seven LSP features to the Agency language server: signature help, find references, rename symbol, dot-completion for object fields, inlay hints, code actions, and go-to-type-definition.

**Architecture:** All features follow the existing LSP pattern: a feature module in `lib/lsp/` exports a handler function, wired into `server.ts` with a capability flag and `connection.onX()` handler. Features that need type information reuse the typechecker's `Scope` infrastructure. Three shared modules provide infrastructure:

- **`lib/lsp/util.ts`** — common helpers (`escapeRegExp`, `findAllOccurrences`) used by references, rename, and document highlights
- **`lib/lsp/scopeResolution.ts`** — scope-lookup utilities (`findContainingScope`, `findDefForScope`) used by type resolution, inlay hints, and dot-completion
- **`lib/lsp/documentState.ts`** — a single `DocumentState` type replacing the current 4 parallel `Map`s in `server.ts`

**Tech Stack:** TypeScript, vscode-languageserver-protocol, existing Agency parser/typechecker/SymbolTable

**Key docs to review:**
- `docs/dev/typechecker.md` — how the typechecker works
- `lib/typeChecker/scopes.ts` — how variable types are tracked per-scope
- `lib/typeChecker/scope.ts` — the `Scope` class (declare/lookup)
- `lib/lsp/semantics.ts` — existing `SemanticIndex` and `lookupSemanticSymbol`
- `lib/cli/definition.ts` — existing `getWordAtPosition` utility

---

## File Structure

New files:
- `lib/lsp/util.ts` — shared text-matching helpers
- `lib/lsp/scopeResolution.ts` — scope containment logic
- `lib/lsp/documentState.ts` — per-document cached state type
- `lib/lsp/typeResolution.ts` — type-at-cursor resolution
- `lib/lsp/signatureHelp.ts` — signature help handler
- `lib/lsp/references.ts` — find references handler
- `lib/lsp/rename.ts` — rename symbol handler
- `lib/lsp/inlayHint.ts` — inlay hints handler
- `lib/lsp/typeDefinition.ts` — go-to-type-definition handler
- `lib/lsp/codeAction.ts` — code actions handler

Modified files:
- `lib/typeChecker/types.ts` — add `scopes` to `TypeCheckResult`
- `lib/typeChecker/index.ts` — return scopes from `check()`
- `lib/lsp/diagnostics.ts` — pass scopes through `DiagnosticsResult`
- `lib/lsp/server.ts` — use `DocumentState`, wire all new handlers
- `lib/lsp/completion.ts` — add dot-completion via optional context
- `lib/lsp/documentHighlight.ts` — use shared `findAllOccurrences`

---

## Shared Infrastructure

Several features need common utilities. Task 0 builds the shared layer so later tasks stay focused.

---

## Task 0: Shared infrastructure (util, scopeResolution, DocumentState)

**Files:**
- Create: `lib/lsp/util.ts`
- Create: `lib/lsp/util.test.ts`
- Create: `lib/lsp/scopeResolution.ts`
- Create: `lib/lsp/scopeResolution.test.ts`
- Create: `lib/lsp/documentState.ts`
- Modify: `lib/lsp/server.ts` (refactor to use DocumentState)
- Modify: `lib/lsp/documentHighlight.ts` (use shared `findAllOccurrences`)
- Modify: `lib/typeChecker/types.ts` (add `scopes` to `TypeCheckResult`)
- Modify: `lib/typeChecker/index.ts` (return scopes from `check()`)
- Modify: `lib/lsp/diagnostics.ts` (pass scopes through `DiagnosticsResult`)

- [ ] **Step 1: Create `lib/lsp/util.ts` with shared text helpers**

```typescript
// lib/lsp/util.ts
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type Occurrence = {
  line: number;
  character: number;
  length: number;
};

/**
 * Find all whole-word occurrences of `word` in `source`.
 * Known limitation: matches inside string literals and comments.
 */
export function findAllOccurrences(source: string, word: string): Occurrence[] {
  const occurrences: Occurrence[] = [];
  const lines = source.split("\n");
  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, "g");

  for (let line = 0; line < lines.length; line++) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(lines[line])) !== null) {
      occurrences.push({ line, character: match.index, length: word.length });
    }
  }

  return occurrences;
}
```

- [ ] **Step 2: Write tests for util.ts**

```typescript
// lib/lsp/util.test.ts
import { describe, it, expect } from "vitest";
import { findAllOccurrences, escapeRegExp } from "./util.js";

describe("findAllOccurrences", () => {
  it("finds all whole-word matches", () => {
    const source = "let foo = 1\nprint(foo)\nlet foobar = foo";
    const result = findAllOccurrences(source, "foo");
    expect(result).toHaveLength(3); // foo (line 0), foo (line 1), foo (line 2, after =)
    expect(result[0]).toEqual({ line: 0, character: 4, length: 3 });
  });

  it("does not match partial words", () => {
    const source = "let foobar = 1";
    const result = findAllOccurrences(source, "foo");
    expect(result).toHaveLength(0);
  });
});

describe("escapeRegExp", () => {
  it("escapes special characters", () => {
    expect(escapeRegExp("foo.bar")).toBe("foo\\.bar");
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm test:run lib/lsp/util.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Create `lib/lsp/scopeResolution.ts`**

```typescript
// lib/lsp/scopeResolution.ts
import type { AgencyProgram } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";

/**
 * Find the AST definition node (function or graphNode) for a named scope.
 */
export function findDefForScope(name: string, program: AgencyProgram) {
  for (const node of program.nodes) {
    if (node.type === "function" && node.functionName === name) return node;
    if (node.type === "graphNode" && node.nodeName === name) return node;
  }
  return null;
}

/**
 * Find the innermost scope that contains the given character offset.
 * Falls back to the top-level scope if no function/node scope matches.
 */
export function findContainingScope(
  offset: number,
  scopes: ScopeInfo[],
  program: AgencyProgram,
): ScopeInfo | undefined {
  let best: ScopeInfo | undefined;
  for (const scopeInfo of scopes) {
    if (scopeInfo.name === "top-level") {
      if (!best) best = scopeInfo;
      continue;
    }
    const def = findDefForScope(scopeInfo.name, program);
    if (!def?.loc) continue;
    if (offset >= def.loc.start && offset <= def.loc.end) {
      if (!best || best.name === "top-level") {
        best = scopeInfo;
      } else {
        const bestDef = findDefForScope(best.name, program);
        if (bestDef?.loc && def.loc.start > bestDef.loc.start) {
          best = scopeInfo;
        }
      }
    }
  }
  return best;
}
```

- [ ] **Step 5: Write tests for scopeResolution.ts**

Test `findContainingScope` with two adjacent functions, verifying the correct scope is selected for offsets in each.

- [ ] **Step 6: Update TypeCheckResult to expose scopes**

In `lib/typeChecker/types.ts`, add `scopes` to `TypeCheckResult`:

```typescript
export type TypeCheckResult = {
  errors: TypeCheckError[];
  scopes: ScopeInfo[];
};
```

In `lib/typeChecker/index.ts`, update `check()` to return scopes (the `scopes` variable from `buildScopes(ctx)` is already computed — just include it in the return).

- [ ] **Step 7: Create `lib/lsp/documentState.ts` and refactor server.ts**

```typescript
// lib/lsp/documentState.ts
import type { AgencyProgram } from "../types.js";
import type { CompilationUnit } from "../compilationUnit.js";
import type { SemanticIndex } from "./semantics.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import type { SymbolTable } from "../symbolTable.js";

export type DocumentState = {
  program: AgencyProgram;
  info: CompilationUnit;
  semanticIndex: SemanticIndex;
  scopes: ScopeInfo[];
  symbolTable: SymbolTable;
};
```

In `server.ts`, replace the four separate maps (`docPrograms`, `docInfos`, `docSemanticIndexes`, and the upcoming `docScopes` / `docSymbolTables`) with a single `docStates = new Map<string, DocumentState>()`. Update all handlers to read from `docStates.get(uri)`. Update `updateDocument` to capture scopes from the typeCheck result and the symbolTable, storing them in the DocumentState.

- [ ] **Step 8: Update `lib/lsp/diagnostics.ts` to return scopes**

Add `scopes: ScopeInfo[]` to `DiagnosticsResult`. Capture scopes from the `typeCheck` result and pass them through.

- [ ] **Step 9: Refactor `documentHighlight.ts` to use shared `findAllOccurrences`**

Replace the inline regex matching in `handleDocumentHighlight` with a call to `findAllOccurrences` from `util.ts`.

- [ ] **Step 10: Run all existing LSP tests**

Run: `pnpm test:run lib/lsp/ lib/typeChecker.test.ts`
Expected: ALL PASS — this is a pure refactor, no behavior change.

- [ ] **Step 11: Commit**

```
refactor(lsp): add shared util, scopeResolution, DocumentState
```

---

## Task 1: Add type-at-position resolution utility

**Files:**
- Create: `lib/lsp/typeResolution.ts`
- Test: `lib/lsp/typeResolution.test.ts`

**Depends on:** Task 0 (scopeResolution, DocumentState, TypeCheckResult with scopes)

This module exports a function that, given cursor position and the typechecker's scope info, returns the resolved type of the variable under the cursor (or null). Uses `findContainingScope` from the shared `scopeResolution.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/lsp/typeResolution.test.ts
import { describe, it, expect } from "vitest";
import { resolveTypeAtPosition } from "./typeResolution.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { SymbolTable } from "../symbolTable.js";
import { typeCheck } from "../typeChecker/index.js";

function getTypeAtPos(source: string, line: number, character: number) {
  const r = parseAgency(source, {}, false);
  if (!r.success) throw new Error("parse failed");
  const program = r.result;
  const info = buildCompilationUnit(program, new SymbolTable());
  const { scopes } = typeCheck(program, {}, info);
  return resolveTypeAtPosition(source, line, character, program, scopes);
}

describe("resolveTypeAtPosition", () => {
  it("resolves type of a typed variable", () => {
    const source = "node main() {\n  let x: string = \"hi\"\n  print(x)\n}";
    const result = getTypeAtPos(source, 2, 8); // cursor on 'x' in print(x)
    expect(result).not.toBeNull();
    expect(result!.type).toBe("primitiveType");
  });

  it("returns null when not on a variable", () => {
    const source = "node main() {\n  let x: number = 1\n}";
    const result = getTypeAtPos(source, 1, 8); // cursor on '='
    expect(result).toBeNull();
  });

  it("resolves object type for typed variable", () => {
    const source = 'type Foo = { name: string }\nnode main() {\n  let x: Foo = llm("hi")\n  print(x)\n}';
    const result = getTypeAtPos(source, 3, 8); // cursor on 'x'
    expect(result).not.toBeNull();
  });

  it("resolves correct scope when multiple functions exist", () => {
    const source = "def foo() {\n  let x: number = 1\n}\ndef bar() {\n  let x: string = \"hi\"\n}";
    // cursor on 'x' in bar — should be string, not number
    const result = getTypeAtPos(source, 4, 6);
    expect(result).not.toBeNull();
    if (result && result.type === "primitiveType") {
      expect(result.value).toBe("string");
    }
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test:run lib/lsp/typeResolution.test.ts`
Expected: FAIL — module not found

- [ ] **Step 5: Implement the module**

The implementation needs to:
1. Use `getWordAtPosition` to get the word at cursor
2. Determine which scope the cursor falls in by checking which function/node `loc` range contains the cursor position (checking BOTH start and end bounds)
3. Call `scope.lookup(word)` in the matching scope

```typescript
// lib/lsp/typeResolution.ts
import { getWordAtPosition } from "../cli/definition.js";
import type { AgencyProgram, VariableType } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { findContainingScope } from "./scopeResolution.js";

export function resolveTypeAtPosition(
  source: string,
  line: number,
  character: number,
  program: AgencyProgram,
  scopes: ScopeInfo[],
): VariableType | null {
  const word = getWordAtPosition(source, line, character);
  if (!word) return null;

  // Convert cursor to a character offset for scope containment check
  const cursorOffset = offsetOfLine(source, line) + character;

  const scope = findContainingScope(cursorOffset, scopes, program);
  if (!scope) return null;

  const resolved = scope.scope.lookup(word);
  if (!resolved || resolved === "any") return null;
  return resolved;
}

function offsetOfLine(source: string, line: number): number {
  let offset = 0;
  const lines = source.split("\n");
  for (let i = 0; i < line && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }
  return offset;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:run lib/lsp/typeResolution.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```
feat(lsp): add type-at-position resolution utility
```

---

## Task 2: Add signature help

**Files:**
- Create: `lib/lsp/signatureHelp.ts`
- Test: `lib/lsp/signatureHelp.test.ts`
- Modify: `lib/lsp/server.ts` (add handler + capability)

Signature help shows parameter names/types as the user types inside function call parentheses. Triggered on `(` and `,`.

The implementation needs to:
1. Find the function call surrounding the cursor by scanning backwards for `(`
2. Extract the function name before the `(`
3. Look up the function in the semantic index or compilation unit
4. Determine which parameter the cursor is on (count commas before cursor)
5. Return a `SignatureHelp` with parameter labels and documentation

- [ ] **Step 1: Write the failing test**

```typescript
// lib/lsp/signatureHelp.test.ts
import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { handleSignatureHelp } from "./signatureHelp.js";
import { runDiagnostics } from "./diagnostics.js";
import { SymbolTable } from "../symbolTable.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///test.agency", "agency", 1, content);
}

describe("handleSignatureHelp", () => {
  it("returns signature for a function call", () => {
    const source = 'def greet(name: string, age: number) {\n  return name\n}\nnode main() {\n  greet(';
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
    const result = handleSignatureHelp(
      { textDocument: { uri: doc.uri }, position: { line: 4, character: 8 } },
      doc,
      semanticIndex,
    );
    expect(result).not.toBeNull();
    expect(result!.signatures).toHaveLength(1);
    expect(result!.signatures[0].parameters).toHaveLength(2);
    expect(result!.activeParameter).toBe(0);
  });

  it("returns correct active parameter after comma", () => {
    const source = 'def greet(name: string, age: number) {\n  return name\n}\nnode main() {\n  greet("hi", ';
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
    const result = handleSignatureHelp(
      { textDocument: { uri: doc.uri }, position: { line: 4, character: 14 } },
      doc,
      semanticIndex,
    );
    expect(result).not.toBeNull();
    expect(result!.activeParameter).toBe(1);
  });

  it("returns null when not in a function call", () => {
    const source = "let x: number = 1";
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
    const result = handleSignatureHelp(
      { textDocument: { uri: doc.uri }, position: { line: 0, character: 5 } },
      doc,
      semanticIndex,
    );
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/lsp/signatureHelp.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement signature help**

```typescript
// lib/lsp/signatureHelp.ts
import {
  SignatureHelp,
  SignatureHelpParams,
  SignatureInformation,
  ParameterInformation,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { SemanticIndex } from "./semantics.js";
import { formatTypeHint } from "../cli/util.js";

export function handleSignatureHelp(
  params: SignatureHelpParams,
  doc: TextDocument,
  semanticIndex: SemanticIndex,
): SignatureHelp | null {
  const offset = doc.offsetAt(params.position);
  const text = doc.getText().slice(0, offset);

  // Find the innermost unclosed '(' before cursor
  const ctx = findCallContext(text);
  if (!ctx) return null;

  const symbol = semanticIndex[ctx.functionName];
  if (!symbol || !symbol.parameters) return null;

  const params_ = symbol.parameters;
  const paramInfos: ParameterInformation[] = params_.map((p) => ({
    label: p.name + (p.typeHint ? `: ${formatTypeHint(p.typeHint)}` : ""),
  }));

  const paramStr = paramInfos.map((p) => p.label).join(", ");
  const ret = symbol.returnType ? `: ${formatTypeHint(symbol.returnType)}` : "";
  const label = `${ctx.functionName}(${paramStr})${ret}`;

  const sig: SignatureInformation = {
    label,
    parameters: paramInfos,
  };

  return {
    signatures: [sig],
    activeSignature: 0,
    activeParameter: ctx.argIndex,
  };
}

type CallContext = {
  functionName: string;
  argIndex: number;
};

function findCallContext(textBeforeCursor: string): CallContext | null {
  // Walk backwards to find the matching unclosed '('
  let depth = 0;
  let commaCount = 0;

  for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
    const ch = textBeforeCursor[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth > 0) {
        depth--;
      } else {
        // Found our opening paren — extract function name before it
        const before = textBeforeCursor.slice(0, i).trimEnd();
        const match = before.match(/([a-zA-Z_][a-zA-Z0-9_]*)$/);
        if (!match) return null;
        return { functionName: match[1], argIndex: commaCount };
      }
    } else if (ch === "," && depth === 0) {
      commaCount++;
    }
  }

  return null;
}
```

- [ ] **Step 4: Wire into server.ts**

Add import for `handleSignatureHelp`. Add capability:

```typescript
signatureHelpProvider: { triggerCharacters: ["(", ","] },
```

Add handler:

```typescript
connection.onSignatureHelp((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const semanticIndex = docSemanticIndexes.get(params.textDocument.uri) ?? {};
  return handleSignatureHelp(params, doc, semanticIndex);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test:run lib/lsp/signatureHelp.test.ts lib/lsp/server.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```
feat(lsp): add signature help for function calls
```

---

## Task 3: Add find references

**Files:**
- Create: `lib/lsp/references.ts`
- Test: `lib/lsp/references.test.ts`
- Modify: `lib/lsp/server.ts` (add handler + capability)

Find all occurrences of a symbol across the current file and imported files. Uses the semantic index for cross-file awareness and text search for local occurrences.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/lsp/references.test.ts
import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { handleReferences } from "./references.js";
import { runDiagnostics } from "./diagnostics.js";
import { SymbolTable } from "../symbolTable.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///test.agency", "agency", 1, content);
}

describe("handleReferences", () => {
  it("finds all references to a function in the current file", () => {
    const source = "def greet(name: string) {\n  return name\n}\ngreet(\"a\")\ngreet(\"b\")";
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
    const result = handleReferences(
      {
        textDocument: { uri: doc.uri },
        position: { line: 0, character: 4 },
        context: { includeDeclaration: true },
      },
      doc,
      semanticIndex,
    );
    // "greet" appears 3 times: definition + 2 calls
    expect(result).toHaveLength(3);
  });

  it("returns references excluding declaration when requested", () => {
    const source = "def greet(name: string) {\n  return name\n}\ngreet(\"a\")";
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
    const result = handleReferences(
      {
        textDocument: { uri: doc.uri },
        position: { line: 0, character: 4 },
        context: { includeDeclaration: false },
      },
      doc,
      semanticIndex,
    );
    // "greet" appears 2 times: definition line has it but we exclude declarations
    // Note: for simplicity, declaration exclusion uses the semantic index loc
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/lsp/references.test.ts`

- [ ] **Step 3: Implement find references**

The approach: find all whole-word occurrences of the symbol in the current file (same logic as document highlights), filtering by the semantic index to confirm it's a known symbol. For cross-file references, this initial implementation only searches the current file. Cross-file search can be added later by walking the symbol table's file set.

**Known limitation:** Regex word-boundary matching will produce false positives for identifiers that appear in string literals or comments. This is acceptable for the initial implementation.

**Note:** Both this module and `rename.ts` (Task 6) use an `escapeRegExp` helper. Extract it to a shared utility (e.g., `lib/lsp/util.ts`) or reuse the one from `documentHighlight.ts`.

```typescript
// lib/lsp/references.ts
import { Location, ReferenceParams } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { lookupSemanticSymbol, type SemanticIndex } from "./semantics.js";
import { findAllOccurrences } from "./util.js";

export function handleReferences(
  params: ReferenceParams,
  doc: TextDocument,
  semanticIndex: SemanticIndex,
): Location[] {
  const symbol = lookupSemanticSymbol(
    doc.getText(),
    params.position.line,
    params.position.character,
    semanticIndex,
  );
  if (!symbol) return [];

  const occurrences = findAllOccurrences(doc.getText(), symbol.name);

  return occurrences
    .filter((occ) => {
      if (!params.context.includeDeclaration && symbol.loc) {
        return !(occ.line === symbol.loc.line && occ.character === symbol.loc.col);
      }
      return true;
    })
    .map((occ) => ({
      uri: doc.uri,
      range: {
        start: { line: occ.line, character: occ.character },
        end: { line: occ.line, character: occ.character + occ.length },
      },
    }));
}
```

- [ ] **Step 4: Wire into server.ts**

Add import and capability `referencesProvider: true`. Add handler:

```typescript
connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const semanticIndex = docSemanticIndexes.get(params.textDocument.uri) ?? {};
  return handleReferences(params, doc, semanticIndex);
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm test:run lib/lsp/references.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```
feat(lsp): add find references (single-file)
```

---

## Task 4: Add dot-completion for object fields

**Files:**
- Modify: `lib/lsp/completion.ts`
- Modify: `lib/lsp/completion.test.ts`
- Modify: `lib/lsp/server.ts` (pass extra state to completions)

When the user types `obj.`, complete with the object's field names instead of top-level symbols. Depends on Task 1 (type-at-position resolution).

- [ ] **Step 1: Write the failing test**

Add to `lib/lsp/completion.test.ts`:

```typescript
it("returns object fields after dot", () => {
  const source = 'type Foo = { name: string, age: number }\nnode main() {\n  let x: Foo = llm("hi")\n  x.';
  const program = parse(source);
  const info = buildCompilationUnit(program, new SymbolTable());
  const { scopes } = typeCheck(program, {}, info);
  const items = getCompletions(info, { source, line: 3, character: 4, scopes, program });
  const names = items.map(i => i.label);
  expect(names).toContain("name");
  expect(names).toContain("age");
  expect(names).not.toContain("main"); // should NOT include top-level symbols
});
```

This requires adding imports for `typeCheck` and `AgencyProgram` to the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/lsp/completion.test.ts`

- [ ] **Step 3: Update `getCompletions` signature**

Add an optional `context` parameter to `getCompletions` that carries cursor position and scopes. When present and the cursor is after a `.`:

1. Extract the text before the dot to find the variable name
2. Use `resolveTypeAtPosition` from Task 1 to get the variable's type
3. If it's an object type (or a type alias resolving to an object), return its field names
4. If it's a union type, return intersection of fields across members

```typescript
export type CompletionContext = {
  source: string;
  line: number;
  character: number;
  scopes: ScopeInfo[];
  program: AgencyProgram;
};

export function getCompletions(
  info: CompilationUnit,
  context?: CompletionContext,
): CompletionItem[] {
  // Check if cursor is after a dot
  if (context) {
    const dotCompletion = getDotCompletions(context, info);
    if (dotCompletion) return dotCompletion;
  }

  // ... existing top-level completion logic
}
```

The `getDotCompletions` function:
1. Checks if the character before cursor is `.`
2. Extracts the variable name before the dot
3. Resolves the type via the scope
4. Resolves type aliases to their underlying type
5. If objectType, returns field names as CompletionItems with their types as detail

- [ ] **Step 4: Update server.ts to pass context**

In the `onCompletion` handler, pass document text, cursor position, and cached scopes to `getCompletions`.

- [ ] **Step 5: Run tests**

Run: `pnpm test:run lib/lsp/completion.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```
feat(lsp): add dot-completion for object fields
```

---

## Task 5: Add inlay hints

**Files:**
- Create: `lib/lsp/inlayHint.ts`
- Test: `lib/lsp/inlayHint.test.ts`
- Modify: `lib/lsp/server.ts` (add handler + capability)

Show inferred types inline for variables declared without explicit type annotations. Depends on Task 1 (type resolution / scopes).

- [ ] **Step 1: Write the failing test**

```typescript
// lib/lsp/inlayHint.test.ts
import { describe, it, expect } from "vitest";
import { InlayHintKind } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getInlayHints } from "./inlayHint.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { SymbolTable } from "../symbolTable.js";
import { typeCheck } from "../typeChecker/index.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///test.agency", "agency", 1, content);
}

function setup(source: string) {
  const r = parseAgency(source, {}, false);
  if (!r.success) throw new Error("parse failed");
  const program = r.result;
  const doc = makeDoc(source);
  const info = buildCompilationUnit(program, new SymbolTable());
  const { scopes } = typeCheck(program, {}, info);
  return { program, doc, scopes };
}

describe("getInlayHints", () => {
  it("shows inferred type for untyped variable", () => {
    const { program, doc, scopes } = setup("node main() {\n  let x = 5\n}");
    const hints = getInlayHints(program, doc, scopes);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    const hint = hints.find(h => h.label === ": number");
    expect(hint).toBeDefined();
    expect(hint!.kind).toBe(InlayHintKind.Type);
  });

  it("does not show hint for explicitly typed variable", () => {
    const { program, doc, scopes } = setup("node main() {\n  let x: number = 5\n}");
    const hints = getInlayHints(program, doc, scopes);
    const hint = hints.find(h => h.position.line === 1);
    expect(hint).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/lsp/inlayHint.test.ts`

- [ ] **Step 3: Implement inlay hints**

Walk all assignment nodes in the program. For each `let x = value` (no `typeHint`), find the containing scope using offset bounds, then look up the inferred type. If found and not `"any"`, emit an inlay hint positioned after the variable name.

```typescript
// lib/lsp/inlayHint.ts
import { InlayHint, InlayHintKind } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { AgencyProgram } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { walkNodes } from "../utils/node.js";
import { formatTypeHint } from "../cli/util.js";
import { TEMPLATE_OFFSET } from "./locations.js";
import { findContainingScope } from "./scopeResolution.js";

export function getInlayHints(
  program: AgencyProgram,
  doc: TextDocument,
  scopes: ScopeInfo[],
): InlayHint[] {
  const hints: InlayHint[] = [];

  for (const { node } of walkNodes(program.nodes)) {
    if (node.type !== "assignment") continue;
    if (node.typeHint) continue; // already explicitly typed
    if (!node.loc) continue;

    const containingScope = findContainingScope(node.loc.start, scopes, program);
    if (!containingScope) continue;

    const resolved = containingScope.scope.lookup(node.variableName);
    if (resolved && resolved !== "any") {
      hints.push({
        position: {
          line: node.loc.line + TEMPLATE_OFFSET,
          character: node.loc.col + node.variableName.length,
        },
        label: `: ${formatTypeHint(resolved)}`,
        kind: InlayHintKind.Type,
        paddingLeft: false,
        paddingRight: true,
      });
    }
  }

  return hints;
}
```

Note: the position should be after the variable name but before the `=`. We use `node.loc.col + variableName.length` as an approximation. This may need adjustment based on whether `loc.col` points to `let` or the variable name — verify with a real parse and adjust.

- [ ] **Step 4: Wire into server.ts**

Add capability `inlayHintProvider: true`. Add handler:

```typescript
connection.languages.inlayHint.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  const program = docPrograms.get(params.textDocument.uri);
  if (!doc || !program) return [];
  const scopes = docScopes.get(params.textDocument.uri) ?? [];
  return getInlayHints(program, doc, scopes);
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm test:run lib/lsp/inlayHint.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```
feat(lsp): add inlay hints for inferred types
```

---

## Task 6: Add rename symbol

**Files:**
- Create: `lib/lsp/rename.ts`
- Test: `lib/lsp/rename.test.ts`
- Modify: `lib/lsp/server.ts` (add handler + capability)

Rename a symbol across the current file. Uses the same word-matching approach as find references.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/lsp/rename.test.ts
import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { handleRename, handlePrepareRename } from "./rename.js";
import { runDiagnostics } from "./diagnostics.js";
import { SymbolTable } from "../symbolTable.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///test.agency", "agency", 1, content);
}

describe("handleRename", () => {
  it("renames a function across all usages in the file", () => {
    const source = "def greet(name: string) {\n  return name\n}\ngreet(\"hi\")";
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
    const result = handleRename(
      {
        textDocument: { uri: doc.uri },
        position: { line: 0, character: 4 },
        newName: "hello",
      },
      doc,
      semanticIndex,
    );
    expect(result).not.toBeNull();
    const edits = result!.changes![doc.uri];
    expect(edits).toHaveLength(2); // definition + call
    for (const edit of edits) {
      expect(edit.newText).toBe("hello");
    }
  });
});

describe("handlePrepareRename", () => {
  it("returns range for a valid symbol", () => {
    const source = "def greet() { }";
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
    const result = handlePrepareRename(
      { textDocument: { uri: doc.uri }, position: { line: 0, character: 4 } },
      doc,
      semanticIndex,
    );
    expect(result).not.toBeNull();
  });

  it("returns null when not on a renamable symbol", () => {
    const source = "let x: number = 1";
    const doc = makeDoc(source);
    const { semanticIndex } = runDiagnostics(doc, "/test.agency", {}, new SymbolTable());
    const result = handlePrepareRename(
      { textDocument: { uri: doc.uri }, position: { line: 0, character: 8 } },
      doc,
      semanticIndex,
    );
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run lib/lsp/rename.test.ts`

- [ ] **Step 3: Implement rename**

```typescript
// lib/lsp/rename.ts
import {
  WorkspaceEdit,
  TextEdit,
  RenameParams,
  PrepareRenameParams,
  Range,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { lookupSemanticSymbol, type SemanticIndex } from "./semantics.js";
import { getWordAtPosition } from "../cli/definition.js";
import { findAllOccurrences } from "./util.js";

export function handlePrepareRename(
  params: PrepareRenameParams,
  doc: TextDocument,
  semanticIndex: SemanticIndex,
): Range | null {
  const source = doc.getText();
  const symbol = lookupSemanticSymbol(source, params.position.line, params.position.character, semanticIndex);
  if (!symbol) return null;

  const word = getWordAtPosition(source, params.position.line, params.position.character);
  if (!word) return null;

  const line = source.split("\n")[params.position.line];
  const start = line.lastIndexOf(word, params.position.character);
  if (start === -1) return null;

  return {
    start: { line: params.position.line, character: start },
    end: { line: params.position.line, character: start + word.length },
  };
}

export function handleRename(
  params: RenameParams,
  doc: TextDocument,
  semanticIndex: SemanticIndex,
): WorkspaceEdit | null {
  const source = doc.getText();
  const symbol = lookupSemanticSymbol(source, params.position.line, params.position.character, semanticIndex);
  if (!symbol) return null;

  const occurrences = findAllOccurrences(source, symbol.name);
  if (occurrences.length === 0) return null;

  const edits: TextEdit[] = occurrences.map((occ) => ({
    range: {
      start: { line: occ.line, character: occ.character },
      end: { line: occ.line, character: occ.character + occ.length },
    },
    newText: params.newName,
  }));

  return { changes: { [doc.uri]: edits } };
}
```

- [ ] **Step 4: Wire into server.ts**

Add capability `renameProvider: { prepareProvider: true }`. Add handlers:

```typescript
connection.onPrepareRename((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const semanticIndex = docSemanticIndexes.get(params.textDocument.uri) ?? {};
  return handlePrepareRename(params, doc, semanticIndex);
});

connection.onRenameRequest((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const semanticIndex = docSemanticIndexes.get(params.textDocument.uri) ?? {};
  return handleRename(params, doc, semanticIndex);
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm test:run lib/lsp/rename.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```
feat(lsp): add rename symbol (single-file)
```

---

## Task 7: Add go-to-type-definition

**Files:**
- Create: `lib/lsp/typeDefinition.ts`
- Test: `lib/lsp/typeDefinition.test.ts`
- Modify: `lib/lsp/server.ts` (add handler + capability)

Jump from a variable to its type definition. Depends on Task 1 (type-at-position).

- [ ] **Step 1: Write the failing test**

```typescript
// lib/lsp/typeDefinition.test.ts
import { describe, it, expect } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { handleTypeDefinition } from "./typeDefinition.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { SymbolTable } from "../symbolTable.js";
import { typeCheck } from "../typeChecker/index.js";
import { buildSemanticIndex } from "./semantics.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///test.agency", "agency", 1, content);
}

function setup(source: string) {
  const r = parseAgency(source, {}, false);
  if (!r.success) throw new Error("parse failed");
  const program = r.result;
  const doc = makeDoc(source);
  const st = new SymbolTable();
  const info = buildCompilationUnit(program, st);
  const { scopes } = typeCheck(program, {}, info);
  const semanticIndex = buildSemanticIndex(program, "/test.agency", st);
  return { program, doc, scopes, semanticIndex };
}

describe("handleTypeDefinition", () => {
  it("jumps to type alias definition from variable", () => {
    const source = "type Foo = { name: string }\nnode main() {\n  let x: Foo = llm(\"hi\")\n  print(x)\n}";
    const { program, doc, scopes, semanticIndex } = setup(source);
    const result = handleTypeDefinition(
      { textDocument: { uri: doc.uri }, position: { line: 3, character: 8 } },
      doc, program, scopes, semanticIndex,
    );
    expect(result).not.toBeNull();
    expect(result!.range.start.line).toBe(0);
  });

  it("returns null for primitive types", () => {
    const source = 'node main() {\n  let x: string = "hi"\n  print(x)\n}';
    const { program, doc, scopes, semanticIndex } = setup(source);
    const result = handleTypeDefinition(
      { textDocument: { uri: doc.uri }, position: { line: 2, character: 8 } },
      doc, program, scopes, semanticIndex,
    );
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement go-to-type-definition**

1. Resolve the type at cursor using `resolveTypeAtPosition`
2. If the type is a `typeAliasVariable`, look up the alias name in the semantic index
3. Return the location of the type alias definition

```typescript
// lib/lsp/typeDefinition.ts
import { Location, TypeDefinitionParams } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { resolveTypeAtPosition } from "./typeResolution.js";
import { lookupSemanticSymbol, type SemanticIndex } from "./semantics.js";
import { pathToUri } from "./uri.js";
import type { AgencyProgram } from "../types.js";
import type { ScopeInfo } from "../typeChecker/types.js";
import { TEMPLATE_OFFSET } from "./locations.js";

export function handleTypeDefinition(
  params: TypeDefinitionParams,
  doc: TextDocument,
  program: AgencyProgram,
  scopes: ScopeInfo[],
  semanticIndex: SemanticIndex,
): Location | null {
  const varType = resolveTypeAtPosition(
    doc.getText(),
    params.position.line,
    params.position.character,
    program,
    scopes,
  );
  if (!varType) return null;

  // If it's a type alias reference, find the alias definition
  let typeName: string | null = null;
  if (varType.type === "typeAliasVariable") {
    typeName = varType.aliasName;
  }

  if (!typeName) return null;

  const symbol = semanticIndex[typeName];
  if (!symbol?.loc) return null;

  return {
    uri: pathToUri(symbol.filePath),
    range: {
      start: { line: symbol.loc.line, character: symbol.loc.col },
      end: { line: symbol.loc.line, character: symbol.loc.col },
    },
  };
}
```

- [ ] **Step 4: Wire into server.ts**

Add capability `typeDefinitionProvider: true`. Add handler:

```typescript
connection.onTypeDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const program = docPrograms.get(params.textDocument.uri);
  const scopes = docScopes.get(params.textDocument.uri) ?? [];
  const semanticIndex = docSemanticIndexes.get(params.textDocument.uri) ?? {};
  if (!program) return null;
  return handleTypeDefinition(params, doc, program, scopes, semanticIndex);
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm test:run lib/lsp/typeDefinition.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```
feat(lsp): add go-to-type-definition
```

---

## Task 8: Add code actions

**Files:**
- Create: `lib/lsp/codeAction.ts`
- Test: `lib/lsp/codeAction.test.ts`
- Modify: `lib/lsp/server.ts` (add handler + capability)

Initial code actions:
1. **"Add missing import"** — when a diagnostic says a symbol is not defined and it exists in a known file (via SymbolTable), offer to add the import
2. **"Remove unused import"** — when an imported name is never referenced in the file body

These are independent of the type resolution infrastructure.

- [ ] **Step 1: Write the failing test for "add missing import"**

```typescript
// lib/lsp/codeAction.test.ts
import { describe, it, expect } from "vitest";
import { CodeActionKind, DiagnosticSeverity } from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import { getCodeActions } from "./codeAction.js";
import { SymbolTable } from "../symbolTable.js";

function makeDoc(content: string) {
  return TextDocument.create("file:///project/test.agency", "agency", 1, content);
}

describe("getCodeActions", () => {
  it("suggests adding an import for a known symbol", () => {
    const doc = makeDoc('node main() {\n  greet("hi")\n}');
    // Build a symbol table that knows about "greet" in another file
    // (In practice you'd construct this from a real file; here we use a minimal mock)
    const symbolTable = new SymbolTable();
    // TODO: populate symbolTable with greet in /project/helpers.agency
    // For now, test the shape of the response
    const params = {
      textDocument: { uri: doc.uri },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: {
        diagnostics: [
          {
            severity: DiagnosticSeverity.Error,
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
            message: "Symbol 'greet' is not defined in './helpers.agency'",
            source: "agency",
          },
        ],
      },
    };
    const actions = getCodeActions(params, doc, symbolTable);
    // With empty symbol table, no actions should be returned
    expect(actions).toHaveLength(0);
  });
});
```

Note: A full integration test for code actions requires writing a real helper file to disk and building a SymbolTable from it. The test above validates the basic wiring; expand it when implementing.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement code actions**

The implementation searches all files in the SymbolTable for a symbol matching the name in the diagnostic message. If found, it generates a `TextEdit` that inserts an import statement at the top of the file.

```typescript
// lib/lsp/codeAction.ts
import path from "path";
import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  Diagnostic,
  TextEdit,
} from "vscode-languageserver-protocol";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { SymbolTable } from "../symbolTable.js";
import { uriToPath } from "./uri.js";

export function getCodeActions(
  params: CodeActionParams,
  doc: TextDocument,
  symbolTable: SymbolTable,
): CodeAction[] {
  const actions: CodeAction[] = [];

  for (const diagnostic of params.context.diagnostics) {
    const importAction = suggestMissingImport(diagnostic, doc, symbolTable);
    if (importAction) actions.push(importAction);
  }

  return actions;
}

function suggestMissingImport(
  diagnostic: Diagnostic,
  doc: TextDocument,
  symbolTable: SymbolTable,
): CodeAction | null {
  // Match error messages like "Symbol 'X' is not defined" or undefined variable errors
  const match = diagnostic.message.match(/Symbol '(\w+)' is not defined/);
  if (!match) return null;

  const symbolName = match[1];

  // Search symbol table for this name in other files
  for (const filePath of symbolTable.filePaths()) {
    const fileSymbols = symbolTable.getFile(filePath);
    if (!fileSymbols) continue;
    const sym = fileSymbols[symbolName];
    if (!sym) continue;
    // Only function and type symbols have an `exported` field; skip unexported ones
    if ("exported" in sym && sym.exported === false) continue;

    // Compute relative import path from document to the file containing the symbol
    const docPath = uriToPath(doc.uri);
    let importPath = path.relative(path.dirname(docPath), filePath);
    if (!importPath.startsWith(".")) importPath = "./" + importPath;

    const importLine = `import { ${symbolName} } from "${importPath}"\n`;
    return {
      title: `Add import from '${importPath}'`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [doc.uri]: [
            TextEdit.insert({ line: 0, character: 0 }, importLine),
          ],
        },
      },
    };
  }

  return null;
}
```

Note: Computing the relative import path between the document and the target file requires care. Use `path.relative()` and ensure the result starts with `./`.

- [ ] **Step 4: Wire into server.ts**

Add capability `codeActionProvider: true`. Cache the symbol table per-document. Add handler:

```typescript
connection.onCodeAction((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const symbolTable = docSymbolTables.get(params.textDocument.uri) ?? new SymbolTable();
  return getCodeActions(params, doc, symbolTable);
});
```

This requires caching the SymbolTable in `updateDocument` alongside the other per-document state.

- [ ] **Step 5: Run tests**

Run: `pnpm test:run lib/lsp/codeAction.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```
feat(lsp): add code actions (add missing import)
```

---

## Dependency Graph

```
Task 0 (shared infra) ──┬──> Task 1 (type resolution) ──┬──> Task 4 (dot-completion)
                         │                                ├──> Task 5 (inlay hints)
                         │                                └──> Task 7 (go-to-type-definition)
                         ├──> Task 2 (signature help)
                         ├──> Task 3 (find references)
                         ├──> Task 6 (rename symbol)
                         └──> Task 8 (code actions)
```

Task 0 must come first. After that, Tasks 2, 3, 6, 8 are independent of each other. Task 1 must come before Tasks 4, 5, 7.

Suggested serial order: **0 → 2 → 3 → 6 → 1 → 4 → 5 → 7 → 8**

All server.ts handler wiring references `docStates.get(uri)` (from Task 0's `DocumentState` refactor) instead of individual maps. For example:

```typescript
connection.onSignatureHelp((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const state = docStates.get(params.textDocument.uri);
  if (!state) return null;
  return handleSignatureHelp(params, doc, state.semanticIndex);
});
```
