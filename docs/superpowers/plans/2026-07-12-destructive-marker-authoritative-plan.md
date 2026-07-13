# Destructive Marker Authoritative — Implementation Plan (v2: marked-seqBlock)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `destructive` declaration authoritative for tool removal-on-failure by committing at region entry (function entry for `destructive def`, or a `destructive { }` region), deleting the import-name heuristic, and migrating stdlib so interrupt gates stay retryable-on-rejection.

**Architecture:** Runtime removal already keys on the `destructiveRan` flag via `failureTier`. `destructive def` sets it in `init()` at function entry. The `destructive { }` region is a **`seqBlock` carrying a `destructive: true` flag** — NOT a new node. `seqBlock` is already runtime-frame-transparent (`parallelDesugar.ts:424` inlines a standalone `seqBlock` to its body, on the function's `__self`) and already threaded through every dispatch site (bodySlots, flow, scopes, preprocessors, formatter, lowering). We only teach four places about the flag: the parser, the formatter, the desugar step (prepend the entry-flip when inlining a destructive seqBlock), and the derived is-destructive metadata. The entry-flip is a tiny synthetic leaf node `markDestructiveRan` introduced during desugar and emitted by codegen as `__self.__destructiveRan = true`.

**Tech Stack:** TypeScript; tarsec parser combinators (`lib/parsers/`); TsIR/`ts.*` builders and `TypeScriptBuilder`/`AgencyGenerator` (`lib/backends/`); preprocessors (`lib/preprocessors/`); Agency execution tests (`tests/agency/*.test.json` + `.agency`) and typescriptGenerator fixtures.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-12-destructive-marker-authoritative-design.md`. Every task implicitly includes it.
- **Fail-open is the cardinal danger.** The entry-flip MUST land on the enclosing **function's** `__self` (activation `.locals`), never a block frame. This is guaranteed here because a destructive `seqBlock` is INLINED into the function body by `desugarParallelInBody` before codegen, so the emitted `__self.__destructiveRan = true` resolves to the function activation. Do NOT compile a destructive region as a frame-bearing block; do NOT exempt destructive seqBlocks from `parallelDesugar` inlining. Task 4's frame-escape test guards this.
- Do NOT mutate `node.markers.destructive`. It feeds `inDestructiveFunction`/the function-entry flip (raw `destructive def` marker only). "Contains a destructive region" is a *derived* value used only for metadata (descriptor/hint/registry).
- `destructive { }` is a `seqBlock` → **no new lexical scope** (declarations inside are visible after it, exactly as `seq { }`).
- After editing any `stdlib/*.agency`, rebuild with `make` (not `pnpm run build`).
- Save suite output to a file when running (repo convention). Do NOT run the full agency suite locally — run the specific tests named per task.
- Run `pnpm run lint:structure` before finishing. Objects not maps, arrays not sets, types not interfaces, no dynamic imports.

## Why this is small (context for the worker)

A brand-new transparent AST node would have to be added to ~8 hand-enumerated dispatch sites (`lib/utils/bodySlots.ts`, `lib/typeChecker/flowBuilder.ts`, `lib/typeChecker/scopes.ts`, `lib/preprocessors/typescriptPreprocessor.ts`, `injectSchemaArgs.ts`, `liftCallbacks.ts`, the formatter, lowering) or silently break narrowing/preprocessing. By reusing `seqBlock` (which is already in all of them), we avoid that entirely. The only genuinely new node is `markDestructiveRan`, a **leaf** (no body) introduced *after* typecheck by the desugar step, so only codegen (and a defensive `bodySlots` case) must know it exists.

---

### Task 1: `SeqBlock.destructive` flag + `markDestructiveRan` leaf node

**Files:**
- Modify: `lib/types/parallelBlock.ts` (add `destructive?: boolean` to `SeqBlock`)
- Create: `lib/types/markDestructiveRan.ts`
- Modify: `lib/types.ts` (export + `AgencyNode` union)

**Interfaces:**
- Produces: `SeqBlock & { destructive?: boolean }`; `type MarkDestructiveRan = BaseNode & { type: "markDestructiveRan" }`.

- [ ] **Step 1: Add the flag to `SeqBlock`**

In `lib/types/parallelBlock.ts`:
```typescript
export type SeqBlock = BaseNode & {
  type: "seqBlock";
  body: AgencyNode[];
  /** True when written as `destructive { ... }` rather than `seq { ... }`.
   *  Marks the region destructive: the desugar step prepends a
   *  `markDestructiveRan` when inlining it. Formatter prints `destructive {`. */
  destructive?: boolean;
};
```

- [ ] **Step 2: Create the leaf node**

`lib/types/markDestructiveRan.ts`:
```typescript
import { BaseNode } from "./base.js";

/** Synthetic, bodyless statement emitted by parallelDesugar when it inlines a
 *  `destructive` seqBlock. Codegen turns it into `__self.__destructiveRan = true`
 *  on the ENCLOSING function activation (the seqBlock is inlined, so `__self` is
 *  the function). Never parsed, never formatted (introduced after typecheck). */
export type MarkDestructiveRan = BaseNode & {
  type: "markDestructiveRan";
};
```

- [ ] **Step 3: Wire into `lib/types.ts`**

Add `export * from "./types/markDestructiveRan.js";` and add `MarkDestructiveRan` to the `AgencyNode` union (import it at top, add `| MarkDestructiveRan` alongside `| SeqBlock`).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add lib/types/parallelBlock.ts lib/types/markDestructiveRan.ts lib/types.ts
git commit -m "types: SeqBlock.destructive flag + markDestructiveRan leaf node"
```

---

### Task 2: Parse `destructive { }` into a flagged `seqBlock`

**Files:**
- Modify: `lib/parsers/parsers.ts` (add `destructiveBlockParser`; wire into the statement `or(...)` near `:3988` where `seqBlockParser` is listed)
- Test: `lib/parsers/destructiveBlock.test.ts` (create)

**Interfaces:**
- Consumes: `SeqBlock`, combinators `withLoc`, `memo`, `label`, `seqC`, `set`, `str`, `not`, `varNameChar`, `optionalSpaces`, `optionalSpacesOrNewline`, `char`, `capture`, `captureCaptures`, `parseError`, `bodyParser`.
- Produces: `export const destructiveBlockParser: Parser<SeqBlock>` yielding `{ type: "seqBlock", destructive: true, body }`.

**Blocking-1 correctness:** `parseError(...)` is a **committing (cut)** combinator. `not(varNameChar)` succeeds for BOTH `destructive {` and `destructive def` (both have a space after the keyword), so it cannot disambiguate. The `char("{")` gate MUST sit OUTSIDE `parseError`, so `destructive def` fails softly at `{` and the statement `or(...)` backtracks. (The sibling `seqBlockParser` gets away with `{` inside `parseError` only because `seq` is never a function modifier.)

- [ ] **Step 1: Write failing tests**

`lib/parsers/destructiveBlock.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { destructiveBlockParser } from "./parsers.js";

describe("destructiveBlockParser", () => {
  it("parses to a seqBlock flagged destructive", () => {
    const r = destructiveBlockParser("destructive { return f(x) }");
    expect(r.success).toBe(true);
    expect(r.result).toMatchObject({ type: "seqBlock", destructive: true });
    expect(r.result.body.length).toBe(1);
  });

  it("empty block", () => {
    const r = destructiveBlockParser("destructive { }");
    expect(r.success).toBe(true);
    expect(r.result).toMatchObject({ type: "seqBlock", destructive: true, body: [] });
  });

  it("does NOT match `destructive def` (soft-fails at `{` → backtracks)", () => {
    const r = destructiveBlockParser("destructive def f() { }");
    expect(r.success).toBe(false); // must be a soft failure, not a thrown cut
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/parsers/destructiveBlock.test.ts 2>&1 | tail -20`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement (soft `{` gate)**

Add near `seqBlockParser` in `lib/parsers/parsers.ts`:
```typescript
export const destructiveBlockParser: Parser<SeqBlock> = label("a destructive block", withLoc(memo(
  "destructiveBlockParser",
  seqC(
    set("type", "seqBlock"),
    set("destructive", true),
    str("destructive"),
    not(varNameChar),   // reject `destructiveThing`; NOT sufficient alone for `def`
    optionalSpaces,
    char("{"),          // SOFT gate OUTSIDE parseError: `destructive def` fails here → backtracks
    captureCaptures(
      parseError(
        "unterminated destructive block",
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
      ),
    ),
  ),
)));
```
(Confirm `set(...)` two-value usage matches the codebase; if `set` takes one pair, use two `set(...)` entries as shown.)

- [ ] **Step 4: Wire into the statement parser**

At `lib/parsers/parsers.ts:3988`, next to `lazy(() => seqBlockParser)`, add `lazy(() => destructiveBlockParser)`. Order: place it so `destructive {` is tried; the soft `{` gate makes `destructive def`/identifiers fall through.

- [ ] **Step 5: Run tests + `destructive def` regression**

Run: `pnpm vitest run lib/parsers/destructiveBlock.test.ts lib/parsers/function.test.ts 2>&1 | tail -20`
Expected: PASS (block tests + `destructive def` still parses).

- [ ] **Step 6: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/destructiveBlock.test.ts
git commit -m "parser: destructive { } parses to a destructive-flagged seqBlock"
```

---

### Task 3: Format a destructive seqBlock as `destructive { }`

**Files:**
- Modify: `lib/backends/agencyGenerator.ts` (`processSeqBlock`, `:1635`)
- Test: `lib/backends/agencyGenerator.test.ts` (or the formatter roundtrip test file)

**Blocking-3 correctness:** the real pretty-printer is `AgencyGenerator.processNode` (`agencyGenerator.ts`), whose `switch` ends in `default: throw`. `lib/formatter.ts` (15 lines) only delegates here. `seqBlock` is already dispatched at `:532` → `processSeqBlock`. We only change the keyword.

- [ ] **Step 1: Write failing roundtrip test**

Add:
```typescript
it("formats a destructive block", () => {
  const src = 'def f() {\n  destructive {\n    return _w(x)\n  }\n}\n';
  expect(format(src)).toBe(src); // use the file's existing roundtrip helper
});
it("still formats a seq block as seq", () => {
  const src = 'def f() {\n  seq {\n    return 1\n  }\n}\n';
  expect(format(src)).toBe(src);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/backends/agencyGenerator.test.ts -t "destructive block" 2>&1 | tail -20`
Expected: FAIL (prints `seq {`).

- [ ] **Step 3: Implement**

In `processSeqBlock` (`:1635`):
```typescript
protected processSeqBlock(node: SeqBlock): string {
  this.increaseIndent();
  const bodyCodeStr = this.renderBody(node.body);
  this.decreaseIndent();
  const kw = node.destructive ? "destructive" : "seq";
  return this.indentStr(`${kw} {\n${bodyCodeStr}${this.indentStr("}")}`);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run lib/backends/agencyGenerator.test.ts -t "block" 2>&1 | tail -20`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add lib/backends/agencyGenerator.ts lib/backends/agencyGenerator.test.ts
git commit -m "formatter: print destructive { } for a destructive seqBlock"
```

---

### Task 4: Desugar prepends the entry-flip; codegen emits it (the fail-open guard)

**Files:**
- Modify: `lib/preprocessors/parallelDesugar.ts` (`desugarParallelInBody`, `:424` seqBlock branch)
- Modify: `lib/backends/typescriptBuilder.ts` (`processNode` case for `markDestructiveRan`)
- Modify: `lib/backends/typescriptBuilder/destructiveTracking.ts` (add public `blockEntryFlip()`)
- Modify: `lib/utils/bodySlots.ts` (defensive `markDestructiveRan` → `[]`)
- Test: `tests/typescriptGenerator/destructive-block.agency` + `.mts`

**Interfaces:**
- Produces: `DestructiveTracking.blockEntryFlip(): TsNode` → `__self.__destructiveRan = true`.

- [ ] **Step 1: Prepend the flip when inlining a destructive seqBlock**

In `parallelDesugar.ts`, the `else if (node.type === "seqBlock")` branch (`:424`) currently does `result.push(...desugarParallelInBody(node.body));`. Change to:
```typescript
} else if (node.type === "seqBlock") {
  // Outside a parallel context a seq block inlines to its body. A destructive
  // seqBlock additionally commits: prepend the flip so it runs on the enclosing
  // function's __self (this inlining is exactly why __self is the function).
  if (node.destructive) {
    result.push({ type: "markDestructiveRan" } as AgencyNode);
  }
  result.push(...desugarParallelInBody(node.body));
}
```
(Import `AgencyNode` if not already; the loc field is optional on the synthetic node.)

- [ ] **Step 2: Add `blockEntryFlip()` to DestructiveTracking**

```typescript
/** `__self.__destructiveRan = true`, for the markDestructiveRan codegen. */
blockEntryFlip(): TsNode {
  return ts.assign(ts.self("__destructiveRan"), ts.bool(true));
}
```

- [ ] **Step 3: Codegen case for `markDestructiveRan`**

In `TypeScriptBuilder.processNode` (find the `switch (node.type)` / dispatch), add:
```typescript
case "markDestructiveRan":
  return this.tracking.blockEntryFlip();
```
This is emitted inline in the function body (the seqBlock was inlined), so `ts.self` resolves to the function `__self`.

- [ ] **Step 4: Defensive bodySlots case**

In `lib/utils/bodySlots.ts`, add `case "markDestructiveRan": return [];` (leaf, no body) so any `walkNodes`/`mapBodies` pass running after desugar treats it as inert. Confirm the file's default behavior; if it already returns `[]` for unknown, this is belt-and-suspenders but harmless.

- [ ] **Step 5: Create the fixture and CONFIRM frame placement**

`tests/typescriptGenerator/destructive-block.agency`:
```
def writeThing(x: number): Result {
  const p = prep(x)
  return interrupt std::doit("ok?", { x: x })
  destructive {
    return try _doWrite(p)
  }
}
```
Generate the `.mts` (`make fixtures` or the single-fixture command). CONFIRM in the generated code: `__self.__destructiveRan = true;` appears inside `writeThing`'s body referencing the function `__self` (NOT a `__bstack` frame), immediately before the inlined `_doWrite` step; and NO `seqBlock`/block frame remains.

- [ ] **Step 6: Run generator fixtures**

Run: `pnpm vitest run tests/typescriptGenerator 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/preprocessors/parallelDesugar.ts lib/backends/typescriptBuilder.ts lib/backends/typescriptBuilder/destructiveTracking.ts lib/utils/bodySlots.ts tests/typescriptGenerator/destructive-block.*
git commit -m "codegen: destructive seqBlock inlines a markDestructiveRan flip on the function __self"
```

---

### Task 5: `destructive def` commits at function entry; drop per-statement Rule 1

**Files:**
- Modify: `lib/backends/typescriptBuilder/destructiveTracking.ts` (`init()`, `statementFlips()`)
- Modify: `lib/backends/typescriptBuilder.ts:2132` (pass `inDestructiveFunction`)
- Test: `lib/backends/typescriptBuilder/destructiveTracking.test.ts`

- [ ] **Step 1: Confirm `init()` caller set**

Run: `grep -rn "tracking.init(\|\.init()" lib/backends/typescriptBuilder.ts lib/backends/typescriptBuilder/destructiveTracking.test.ts`
Expected: the codegen call at `:2132` and the unit test — the full set the signature change touches.

- [ ] **Step 2: Update unit tests (TDD)**

- `init(false)` → `__self.__destructiveRan = __self.__destructiveRan ?? false;`
- `init(true)` → `__self.__destructiveRan = true;`
- inside a destructive function, `statementFlips(anyStmt, true)` → `{}` (commit is at entry).
- `blockEntryFlip()` → `__self.__destructiveRan = true;`
- keep Rule-2 (non-destructive caller) outcome-flip/pre-flip tests.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run lib/backends/typescriptBuilder/destructiveTracking.test.ts 2>&1 | tail -20`
Expected: FAIL.

- [ ] **Step 4: Implement**

```typescript
init(inDestructiveFunction: boolean): TsNode {
  return ts.assign(
    ts.self("__destructiveRan"),
    inDestructiveFunction
      ? ts.bool(true)
      : ts.binOp(ts.self("__destructiveRan"), "??", ts.bool(false)),
  );
}

statementFlips(stmt, inDestructiveFunction) {
  if (inDestructiveFunction) return {}; // destructive def commits at entry
  const outcomeVar = this.destructiveOutcomeVar(stmt);
  if (outcomeVar) return { post: this.outcomeFlip(outcomeVar) };
  return this.names.containsDestructiveCall(stmt) ? { pre: this.markTrue() } : {};
}
```
At `typescriptBuilder.ts:2132`: `setupStmts.push(this.tracking.init(this.scopes.inDestructiveFunction));`

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run lib/backends/typescriptBuilder/destructiveTracking.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/backends/typescriptBuilder/destructiveTracking.ts lib/backends/typescriptBuilder.ts lib/backends/typescriptBuilder/destructiveTracking.test.ts
git commit -m "codegen: destructive def commits at function entry; drop per-statement Rule 1"
```

---

### Task 6: Derived is-destructive metadata (marked OR contains a destructive region)

**Files:**
- Create: `lib/backends/functionContainsDestructiveBlock.ts`
- Modify: `lib/backends/typescriptBuilder.ts:2340` (descriptor marker)
- Modify: `lib/compilationUnit.ts` (`registerMarkers` at `:211`, `:225`, `:307`)
- Test: `lib/backends/functionContainsDestructiveBlock.test.ts`; serving tests

**Interfaces:**
- Produces: `functionContainsDestructiveBlock(body: AgencyNode[]): boolean` (walks for a `seqBlock` with `destructive === true`).
- MUST NOT mutate `node.markers`. The entry flip / `inDestructiveFunction` (`:2266`) still read the raw marker only.

- [ ] **Step 1: Failing helper test**

```typescript
import { functionContainsDestructiveBlock } from "./functionContainsDestructiveBlock.js";
it("true for a destructive seqBlock (even nested)", () => {
  const body = [{ type: "ifElse", condition: {}, thenBody: [
    { type: "seqBlock", destructive: true, body: [] },
  ], elseBody: [] }] as any;
  expect(functionContainsDestructiveBlock(body)).toBe(true);
});
it("false for a plain seqBlock / no block", () => {
  expect(functionContainsDestructiveBlock([{ type: "seqBlock", body: [] }] as any)).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run lib/backends/functionContainsDestructiveBlock.test.ts 2>&1 | tail -15` → FAIL.

- [ ] **Step 3: Implement helper**

```typescript
import { AgencyNode, SeqBlock } from "../types.js";
import { walkNodesArray } from "../utils/node.js";

/** True if any `destructive { }` region (a seqBlock flagged destructive) appears
 *  in `body`. Metadata ONLY (descriptor marker, MCP/HTTP hint, registry) — never
 *  the entry flip, which keys on the raw `destructive def` marker. */
export function functionContainsDestructiveBlock(body: AgencyNode[]): boolean {
  for (const { node } of walkNodesArray(body)) {
    if (node.type === "seqBlock" && (node as SeqBlock).destructive) return true;
  }
  return false;
}
```
(Match `walkNodesArray`'s exact name in `lib/utils/node.ts`.)

- [ ] **Step 4: Descriptor marker (`:2340`)**

```typescript
const isDestructive =
  !!node.markers?.destructive || functionContainsDestructiveBlock(node.body);
if (isDestructive || node.markers?.idempotent) {
  const markerProps: Record<string, TsNode> = {};
  if (isDestructive) markerProps.destructive = ts.bool(true);
  if (node.markers.idempotent) markerProps.idempotent = ts.bool(true);
  createProps.markers = ts.obj(markerProps);
}
```
Leave `:2266` untouched.

- [ ] **Step 5: Registry (`compilationUnit.ts`)**

`registerMarkers` gains a `containsBlock = false` param and ORs it into `destructiveFunctions`. Call sites:
- `:211` `registerMarkers(unit, node.functionName, node.markers, functionContainsDestructiveBlock(node.body))`.
- `:225` passes an explicit `{ destructive: true }` (already destructive) — leave as-is (no block info needed).
- `:307` (re-export) — pass `false`; the name's own def already registered it locally.

- [ ] **Step 6: Run helper + serving tests; commit**

Run: `pnpm vitest run lib/backends/functionContainsDestructiveBlock.test.ts lib/serve/mcp/adapter.test.ts lib/serve/http/adapter.test.ts 2>&1 | tail -20`
```bash
git add lib/backends/functionContainsDestructiveBlock.ts lib/backends/functionContainsDestructiveBlock.test.ts lib/backends/typescriptBuilder.ts lib/compilationUnit.ts
git commit -m "codegen: derive is-destructive as marked-OR-contains-destructive-region"
```

---

### Task 7: Remove the dead `containsImpureCall` heuristic

**Files:** `lib/backends/typescriptBuilder/nameClassifier.ts` (+ its test)

- [ ] **Step 1: Confirm no consumer** — `grep -rn "containsImpureCall" lib/ | grep -v ".test.ts"` → only the definition.
- [ ] **Step 2: Delete** `containsImpureCall` (and `isImpureImportedFunction` if now unused — re-grep) + their tests.
- [ ] **Step 3: Typecheck + nameClassifier tests** — `npx tsc --noEmit -p tsconfig.json 2>&1 | head; pnpm vitest run lib/backends/typescriptBuilder/nameClassifier.test.ts 2>&1 | tail -10` → clean.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "cleanup: remove dead containsImpureCall import heuristic"`

---

### Task 8: Rewrite the `destructive-tracking` execution tests to the region model

**Files:** `tests/agency/destructive-tracking.agency`, `tests/agency/destructive-tracking.test.json`

- [ ] **Step 1: Rewrite `burn` to use a destructive region**

```
def burn(x: number): Result {
  if (x < 0) {
    return failure("refused before doing anything")   // before the region → clean
  }
  destructive {
    return failure("failed after starting")            // inside the region → committed
  }
}

destructive def burnWhole(): Result {
  return failure("committed at entry")                 // destructive def → entry commit
}
node wholeEntry() {
  const r = burnWhole()
  if (isFailure(r)) { return [r.neverStarted, r.destructiveRan] }
  return "unexpected"
}
```
(`r.neverStarted` / `r.destructiveRan` are existing failure-Result fields, read exactly as the current tests already do.)

- [ ] **Step 2: Update `.test.json` expectations**

- `cleanRefusal` (burn(-1), before region) → `[false,false]`.
- `startedThenFailed` (burn(1), in region) → `[false,true]`.
- `wholeEntry` (`destructive def` fails at entry) → `[false,true]`.
- `plainFailure` (unmarked, no region) → `[false,false]`.
- Re-derive `succeededThenFailed`/`trySwallowed`/`blockHalt`/`blockJoin`/`ifBlock`/`forBlock` against the new source: any that depended on the old import-heuristic per-statement flip must now put their destructive work inside a `destructive { }` region to yield `destructiveRan = true`.

- [ ] **Step 3: Run** — `pnpm run a test tests/agency/destructive-tracking.test.json 2>&1 | tee /tmp/dtrack.log | tail -30` → all pass.
- [ ] **Step 4: Commit** — `git add tests/agency/destructive-tracking.* && git commit -m "test: rewrite destructive-tracking to the region model"`

---

### Task 9: Behavior tests — the review's mandated coverage

**Files:** `tests/agency/destructive-block.agency` + `.test.json`

- [ ] **Step 1: Frame-escape (Finding A — anti-fail-open).**
```
def wf(): Result { destructive { return failure("boom") } }
node frameEscape() {
  const r = wf()
  if (isFailure(r)) { return [r.destructiveRan] }   // MUST be [true]
  return "unexpected"
}
```
Expected `[true]`. (Frame-local mis-impl gives `[false]`.)

- [ ] **Step 2: Declaration visibility + referenced-var (Finding B / Blocking 2 symptom).**
```
def dv(): number {
  destructive { let y = 10 }
  return y + 1                 // y visible after the region (transparent)
}
node declVisible() { return dv() }   // exact 11
```
(If the region weren't inlined-transparent, `y` would be unresolved → compile error or a bare-identifier codegen. This guards the seqBlock wiring.)

- [ ] **Step 3: Return-in-block (Finding D).**
```
def wr(): number { destructive { return 42 } }
node returnInBlock() { return wr() }   // exact 42
```

- [ ] **Step 4: Interrupt in a destructive block, with a following statement (continuous steps).**
```
def ib(): string {
  destructive {
    const a = interrupt("go?")
    return "did ${a}"
  }
}
node interruptInBlock() { return ib() }
```
`.test.json`: one entry with an `approve` interruptHandler (assert the resumed result); one with `reject` (assert the failure surfaces). No `llm()` here, so a direct interrupt handler suffices (no `useTestLLMProvider` needed).

- [ ] **Step 5: Run** — `pnpm run a test tests/agency/destructive-block.test.json 2>&1 | tee /tmp/dblock.log | tail -40` → all pass.
- [ ] **Step 6: Commit** — `git add tests/agency/destructive-block.* && git commit -m "test: destructive region frame-escape, decl-visibility, return, interrupt-resume"`

---

### Task 10: Parser disambiguation + nested-region tests (Finding E)

**Files:** extend `lib/parsers/destructiveBlock.test.ts`; add `tests/typescriptGenerator/destructive-nested.agency` + `.mts`

- [ ] **Step 1: Parser cases** — `destructive` as an ordinary identifier still parses (e.g. `let destructive = 1` if permitted, else a call `destructive(x)` must not be captured as a block); `destructive def` unchanged; `destructive { }` as a statement inside a body.
- [ ] **Step 2: Nested fixture** — `destructive def f() { destructive { return 1 } }`. Generate the `.mts`; ASSERT the compiled output contains the redundant `__self.__destructiveRan = true` harmlessly (the spec's "harmless no-op"): the function-entry `= true` from `init(true)`, plus the region's `markDestructiveRan` `= true`. Confirms nesting compiles and both flips land on the function `__self`.
- [ ] **Step 3: Run + commit** — `pnpm vitest run lib/parsers/destructiveBlock.test.ts tests/typescriptGenerator 2>&1 | tail -20`; `git add -A && git commit -m "test: destructive region parser disambiguation + nested-in-destructive-def"`

---

### Task 11: Migrate `stdlib/git.agency` (9 functions)

`export destructive def` → `export def`; wrap every statement AFTER the `return interrupt <effect>(...)` gate in `destructive { }`. Prep/validation/message-building BEFORE the gate stays outside. `raises <...>` and docstrings unchanged.

Work regions (after the gate line):
- `gitAdd`: `destructive { _gitRun(dir, addArgs({...})); return "Staged changes" }`
- `gitCommit`: `destructive { return _gitRun(dir, commitArgs({message})) }`
- `gitCheckout`: `destructive { return _gitRun(dir, checkoutArgs({target, force})) }`
- `gitSwitch`: `destructive { return _gitRun(dir, switchArgs({branch, create})) }`
- `gitBranchCreate`: `destructive { _gitRun(dir, branchCreateArgs({branch})); return "Created branch ${branch}" }`
- `gitBranchDelete`: `destructive { _gitRun(dir, branchDeleteArgs({...})); return "Deleted branch ${branch}" }`
- `gitStashPush`: `destructive { return _gitRun(dir, stashPushArgs({message})) }`
- `gitStashPop`: `destructive { return _gitRun(dir, stashPopArgs()) }`
- `gitRestore`: `destructive { _gitRun(dir, restoreArgs({paths, staged})); return "Restored ${paths.length} file(s)" }`

- [ ] **Step 1: Apply** to all 9.
- [ ] **Step 2: Rebuild** — `make 2>&1 | tail -15` → success.
- [ ] **Step 3: Client-hint preserved** — assert `gitAdd` still reports `destructive`/`destructiveHint` (extend `lib/serve/*/adapter.test.ts` or compile a tiny importing module and check the descriptor marker). Run: `pnpm vitest run lib/serve 2>&1 | tail -15`.
- [ ] **Step 4: Commit** — `git add stdlib/git.agency && git commit -m "stdlib: migrate git to destructive { } regions"`

---

### Task 12: Migrate `stdlib/fs.agency` (6 functions)

Work regions (prep like `useAgentCwd` and `edit`'s `_previewEdit` stays outside):
- `edit`: `destructive { return try _multiedit(dir, filename, edits) }`
- `applyPatch`: `destructive { return try _applyPatch(patch, allowedPaths) }`
- `mkdir`: `destructive { return try _mkdir(dir, allowedPaths) }`
- `copy`: `destructive { return try _copy(src, dest, allowedPaths) }`
- `move`: `destructive { return try _move(src, dest, allowedPaths) }`
- `remove`: `destructive { return try _remove(target, allowedPaths) }`

- [ ] **Step 1: Apply.** **Step 2:** `make 2>&1 | tail -15`. **Step 3:** compile a scratch importing `edit`; run any `fs`/`write-binary` agency test. **Step 4:** `git add stdlib/fs.agency && git commit -m "stdlib: migrate fs to destructive { } regions"`

---

### Task 13: Migrate `stdlib/index.agency` (`write`, `writeBinary`) + `stdlib/clipboard.agency` (`copy`)

Work regions:
- `write`: `destructive { return try _write(dir, filename, content, mode) }`
- `writeBinary`: `destructive { return try _writeBinary(dir, filename, base64, mode) }`
- `clipboard.copy`: `destructive { _copy(text) }`

(Leave `paste`, `readBinary`, and non-destructive functions untouched.)

- [ ] **Step 1: Apply.** **Step 2:** `make 2>&1 | tail -15`. **Step 3:** `pnpm run a test tests/agency/write-binary.test.json 2>&1 | tail -20` → pass. **Step 4: Migrated-tool behavior test** — extend `write-binary.test.json`'s `writeBinaryRejectedDoesNotWrite` to assert the rejected-gate failure is retryable (`destructiveRan` false, region never entered). **Step 5:** `git add stdlib/index.agency stdlib/clipboard.agency tests/agency/write-binary.* && git commit -m "stdlib: migrate write/writeBinary/clipboard.copy to destructive { } regions"`

- [ ] **Step 6: Sweep** — `grep -rn "destructive def" stdlib/` → migrate any stragglers (see Task 14) then `make`.

---

### Task 14: Migrate `stdlib/shell.agency` (`exec`, `bash`)

These may not follow the exact `return interrupt` shape — **read and enumerate each split explicitly** (Finding D: a mis-drawn boundary leaves committed work outside the region = fail-open, or pulls the gate inside = removes on rejection).

- [ ] **Step 1:** `sed -n '41,140p' stdlib/shell.agency`; record each function's prep/gate/work; wrap only post-gate effectful work in `destructive { }`; `destructive def`→`def`.
- [ ] **Step 2:** `make 2>&1 | tail -15`. **Step 3:** run any shell/exec agency test; compile a scratch importing `bash`. **Step 4:** `git add stdlib/shell.agency && git commit -m "stdlib: migrate shell exec/bash to destructive { } regions"`

---

### Task 15: Docs

**Files:** `docs/site/guide/llm-part-2.md` ("when a tool call fails": `destructive def` commits at entry; introduce `destructive { }` regions with the gate-outside pattern, using migrated `write` before/after); `lib/runtime/result.ts` JSDoc on `destructiveRan` ("execution entered a destructive region — a `destructive def` body or a `destructive { }` region"); doc comments in `destructiveTracking.ts` referencing the old import-heuristic.

- [ ] **Step 1: Update.** **Step 2:** `make` (regenerates `agency doc`); confirm `docs/site/stdlib/*.md` builds. **Step 3:** `git add -A && git commit -m "docs: document destructive { } regions and the region-commit model"`

---

### Task 16: Full-suite verification + PR

- [ ] **Step 1:** `pnpm run lint:structure 2>&1 | tail -20` — fix violations.
- [ ] **Step 2:** `pnpm test:run 2>&1 | tee /tmp/libtests.log | tail -30` — green (8000+).
- [ ] **Step 3:** `make 2>&1 | tail -15` — success.
- [ ] **Step 4:** Do NOT run the full agency suite locally; confirm the targeted tests (Tasks 8, 9, 13) pass from saved logs.
- [ ] **Step 5:** Push; open the PR summarizing region-commit model, `destructive { }` as a marked seqBlock, derived metadata, stdlib migration, and the fail-open guard. Note the deferred non-goal (unify the success path onto the runtime flag).

---

## Self-Review (completed by plan author)

**Spec coverage:** function-entry commit → Task 5; `destructive { }` region (marked seqBlock) → Tasks 1–4; inline-transparency / fail-open guard → Task 4 + Global Constraints + Task 9 frame-escape; derived is-destructive without mutating `node.markers` → Task 6; remove `containsImpureCall` → Task 7; region-model tests + the four review mandates → Tasks 8–10; stdlib migration enumerated → Tasks 11–14; docs → Task 15. All spec sections map.

**Review findings addressed:** Blocking 1 (parser cut) → Task 2 soft-`{` gate. Blocking 2 (8 dispatch sites) → dissolved by reusing `seqBlock`; only `bodySlots` gets a defensive leaf case (Task 4). Blocking 3 (formatter file) → Task 3 targets `agencyGenerator.ts:processSeqBlock`. Moderate (flip alignment) → the flip is its own inlined statement, not merged into a pre-region step. Minors: `:225` registry site noted (Task 6); `init()` caller grep (Task 5 Step 1); referenced-var/decl-visibility (Task 9 Step 2); nested compiled-output assertion (Task 10 Step 2).

**Placeholder scan:** every code step shows real code; stdlib splits enumerated per function; `shell.agency` gets an explicit read-and-enumerate step.

**Type consistency:** `SeqBlock.destructive`, `MarkDestructiveRan`, `blockEntryFlip()`, `init(inDestructiveFunction)`, `functionContainsDestructiveBlock(body)` are used consistently across Tasks 1, 4, 5, 6.
