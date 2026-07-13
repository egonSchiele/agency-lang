# Destructive Marker Authoritative — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `destructive` declaration authoritative for tool removal-on-failure by committing at region entry (function entry for `destructive def`, or a new inline `destructive { }` block), deleting the import-name heuristic, and migrating stdlib so interrupt gates stay retryable-on-rejection.

**Architecture:** Runtime removal already keys on the `destructiveRan` flag via `failureTier`. We change only *where the flag is set*: `destructive def` sets it in `init()` at function entry; a new transparent, inline-spliced `destructive { }` block sets it at block entry on the enclosing function's `__self`. "Is-destructive" metadata (descriptor marker, MCP/HTTP hint, registry) is derived as marked-OR-contains-block, without mutating `node.markers`.

**Tech Stack:** TypeScript; tarsec parser combinators (`lib/parsers/`); the TsIR/`ts.*` builders and `TypeScriptBuilder` (`lib/backends/`); Agency execution tests (`tests/agency/*.test.json` + `.agency`) and typescriptGenerator fixtures.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-12-destructive-marker-authoritative-design.md`. Every task's requirements implicitly include it.
- **Fail-open is the cardinal danger.** The `destructive { }` entry flip MUST land on the enclosing **function's** `__self` (activation `.locals`), never a block frame. A conventional (frame-bearing) block writes `__bstack.locals.__destructiveRan` which evaporates at block exit → escaping failure carries `destructiveRan = false` → tool NOT removed. Inline-splice is mandatory.
- Do NOT mutate `node.markers.destructive`. It feeds `inDestructiveFunction`/the entry flip (raw marker only). "Contains a block" is a *derived* value used only for metadata (descriptor/hint/registry).
- `destructive { }` introduces **no new lexical scope** — declarations inside are visible after it.
- After editing any `stdlib/*.agency`, rebuild with `make` (not `pnpm run build`) so `dist/` and the `.js` siblings update.
- Save test output to a file when running suites (repo convention; tests are slow/expensive). Do NOT run the full agency suite locally — run the specific tests named in each task.
- Run `pnpm run lint:structure` before finishing; keep to existing patterns (objects not maps, arrays not sets, types not interfaces, no dynamic imports).

---

### Task 1: `DestructiveBlock` AST node type

**Files:**
- Create: `lib/types/destructiveBlock.ts`
- Modify: `lib/types.ts` (export + `AgencyNode` union)

**Interfaces:**
- Produces: `type DestructiveBlock = BaseNode & { type: "destructiveBlock"; body: AgencyNode[] }`.

- [ ] **Step 1: Create the type file**

`lib/types/destructiveBlock.ts`:
```typescript
import { AgencyNode } from "../types.js";
import { BaseNode } from "./base.js";

/** A `destructive { ... }` region. Marks its body as destructive: entering it
 *  flips the enclosing function's `__destructiveRan`. It is transparent — no new
 *  lexical scope, and its body is compiled INLINE into the enclosing function's
 *  stepped statement stream (see DestructiveTracking / processBodyAsParts), so
 *  interrupts inside resume correctly and the flip lands on the function's
 *  `__self`, not a block frame. */
export type DestructiveBlock = BaseNode & {
  type: "destructiveBlock";
  body: AgencyNode[];
};
```

- [ ] **Step 2: Export it and add to the `AgencyNode` union in `lib/types.ts`**

Mirror how `parallelBlock` is wired. Add near the other block re-exports:
```typescript
export * from "./types/destructiveBlock.js";
```
Add `"destructiveBlock"` to the `AgencyNode` union / node-type list (the same list that includes `"handleBlock"`, `"parallelBlock"`, `"matchBlock"` — search for `"handleBlock"` in `lib/types.ts` and add `"destructiveBlock"` alongside, importing the type at the top like the others).

- [ ] **Step 3: Typecheck compiles**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no new errors referencing `destructiveBlock`.

- [ ] **Step 4: Commit**

```bash
git add lib/types/destructiveBlock.ts lib/types.ts
git commit -m "types: add DestructiveBlock AST node"
```

---

### Task 2: Parser for `destructive { }`

**Files:**
- Modify: `lib/parsers/parsers.ts` (add `destructiveBlockParser`; wire into the statement `or(...)` list near line 3992 where `handleBlockParser` is registered)
- Test: `lib/parsers/destructiveBlock.test.ts` (create)

**Interfaces:**
- Consumes: `DestructiveBlock` (Task 1), existing combinators `withLoc`, `memo`, `seqC`, `set`, `str`, `not`, `varNameChar`, `optionalSpaces`, `optionalSpacesOrNewline`, `char`, `capture`, `parseError`, `bodyParser`.
- Produces: `export const destructiveBlockParser: Parser<DestructiveBlock>`.

Model exactly on `handleBlockParser` (`lib/parsers/parsers.ts:4201`), minus the `with` handler tail. The `not(varNameChar)` word boundary is what lets `destructive` used as an identifier, and `destructive def`, backtrack cleanly instead of committing to the block path.

- [ ] **Step 1: Write failing parser tests**

`lib/parsers/destructiveBlock.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { destructiveBlockParser } from "./parsers.js";

describe("destructiveBlockParser", () => {
  it("parses an empty block", () => {
    const r = destructiveBlockParser("destructive { }");
    expect(r.success).toBe(true);
    expect(r.result).toMatchObject({ type: "destructiveBlock", body: [] });
  });

  it("parses a block with statements", () => {
    const r = destructiveBlockParser('destructive {\n  return _write(x)\n}');
    expect(r.success).toBe(true);
    expect(r.result.type).toBe("destructiveBlock");
    expect(r.result.body.length).toBe(1);
  });

  it("does NOT match `destructive def` (backtracks: no `{`)", () => {
    const r = destructiveBlockParser("destructive def f() { }");
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/parsers/destructiveBlock.test.ts 2>&1 | tail -20`
Expected: FAIL — `destructiveBlockParser` is not exported.

- [ ] **Step 3: Implement the parser**

Add near `handleBlockParser` in `lib/parsers/parsers.ts`:
```typescript
export const destructiveBlockParser: Parser<DestructiveBlock> = withLoc(memo(
  "destructiveBlockParser",
  seqC(
    set("type", "destructiveBlock"),
    str("destructive"),
    // Word boundary: `destructive def`, `destructiveThing`, and a bare
    // `destructive` identifier must NOT commit to this parser — they backtrack.
    not(varNameChar),
    optionalSpaces,
    captureCaptures(
      parseError(
        "expected `{` to open destructive block body",
        char("{"),
        optionalSpacesOrNewline,
        capture(bodyParser, "body"),
        optionalSpacesOrNewline,
        char("}"),
      ),
    ),
  ),
));
```
Import `DestructiveBlock` at the top of `parsers.ts` alongside `HandleBlock`.

- [ ] **Step 4: Wire into the statement parser**

At `lib/parsers/parsers.ts:3992`, the statement `or(...)` includes `lazy(() => handleBlockParser)`. Add `lazy(() => destructiveBlockParser)` in the same list. Place it BEFORE any function-call/expression statement parser so `destructive {` is tried as a block first, but the `not(varNameChar)` + `char("{")` ensure `destructive def`/identifiers fall through.

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm vitest run lib/parsers/destructiveBlock.test.ts 2>&1 | tail -20`
Expected: PASS (3/3).

- [ ] **Step 6: Verify `destructive def` still parses (regression)**

Run: `pnpm vitest run lib/parsers/function.test.ts 2>&1 | tail -10`
Expected: PASS (unchanged).

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/parsers.ts lib/parsers/destructiveBlock.test.ts
git commit -m "parser: parse destructive { } block statements"
```

---

### Task 3: Formatter for `destructive { }`

**Files:**
- Modify: `lib/formatter.ts` (add a `destructiveBlock` case in the node dispatch)
- Test: `lib/formatter.test.ts` (add a case)

**Interfaces:**
- Consumes: `DestructiveBlock`; the formatter's body-indenting helper (find how `handleBlock` / `matchBlock` / `parallelBlock` format their `body` and mirror it).

- [ ] **Step 1: Write a failing roundtrip test**

Add to `lib/formatter.test.ts` (follow the file's existing roundtrip helper):
```typescript
it("formats a destructive block", () => {
  const src = 'def f() {\n  destructive {\n    return _write(x)\n  }\n}\n';
  expect(format(src)).toBe(src);
});
```
(Use whatever `format`/roundtrip helper the file already defines.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/formatter.test.ts -t "destructive block" 2>&1 | tail -20`
Expected: FAIL (unknown node type / wrong output).

- [ ] **Step 3: Implement the formatter case**

In `lib/formatter.ts`, find the node-type dispatch (search for `"handleBlock"` or `"parallelBlock"`). Add a `destructiveBlock` case that emits `destructive {`, the indented formatted body, then `}` — mirroring the sibling block formatter exactly (same indent utility and body-join the file already uses).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run lib/formatter.test.ts -t "destructive block" 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/formatter.ts lib/formatter.test.ts
git commit -m "formatter: format destructive { } blocks"
```

---

### Task 4: Typecheck / symbol-table pass-through for the block body

**Files:**
- Modify: whichever passes dispatch on node type and would otherwise skip a `destructiveBlock` (typechecker statement handler; symbol-table body walk). Confirm `lib/utils/node.ts` `walkNodes` descends into `.body` generically.
- Test: `tests/typescriptGenerator/destructive-block.agency` + `.mts` (Task 6 adds these; here add a typecheck test)

**Interfaces:**
- Consumes: `DestructiveBlock.body`.

- [ ] **Step 1: Confirm the generic walker descends into `.body`**

Run: `grep -n "body\|children\|Object.values\|for (const" lib/utils/node.ts | head`
If `walkNodes` iterates node fields generically (descending into arrays of nodes like `.body`), symbol resolution, `raises`/effect checking, and narrowing see the block body for free. If it enumerates specific node types, add `destructiveBlock` to the list that recurses into `.body`.

- [ ] **Step 2: Write a failing typecheck test**

Add an Agency source that would produce a type error INSIDE a block and assert the checker reports it (proving the body is checked). Use the project's typecheck test harness (search `tests/` / `lib/typeChecker` for an existing "expect diagnostic" pattern). Example source:
```
def f(): number {
  destructive {
    let x: string = 5   // type error must be reported
    return 1
  }
}
```
Assert a diagnostic is produced at the `let x` line.

- [ ] **Step 3: Run to verify failure**

Expected: no diagnostic (body skipped) OR a crash on unknown node type — either proves the pass needs a case.

- [ ] **Step 4: Add the pass-through**

Wherever a pass switches on node type and hits `destructiveBlock`, treat it as "recurse into `.body` in the current scope" (no new scope, no new bindings). Match the lightest sibling (e.g. how a plain grouping / `seqBlock` body is walked).

- [ ] **Step 5: Run to verify pass; then full typechecker suite**

Run: `pnpm vitest run lib/typeChecker 2>&1 | tail -15`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "typecheck: walk destructive { } block bodies in the enclosing scope"
```

---

### Task 5: Function-level commit-at-entry (`destructive def`)

**Files:**
- Modify: `lib/backends/typescriptBuilder/destructiveTracking.ts` (`init()`, `statementFlips()`, add `blockEntryFlip()`)
- Modify: `lib/backends/typescriptBuilder.ts:2132` (pass `inDestructiveFunction` to `init()`)
- Test: `lib/backends/typescriptBuilder/destructiveTracking.test.ts`

**Interfaces:**
- Produces: `init(inDestructiveFunction: boolean): TsNode`; `blockEntryFlip(): TsNode` (used by Task 6); `statementFlips` no longer references `containsImpureCall`.

- [ ] **Step 1: Update the unit tests (TDD)**

In `destructiveTracking.test.ts`:
- Keep/adjust the `init()` test: `init(false)` prints `__self.__destructiveRan = __self.__destructiveRan ?? false;`; ADD `init(true)` prints `__self.__destructiveRan = true;`.
- Replace the "impure call flips inside a destructive function" cases with: inside a destructive function, `statementFlips(anyStmt, true)` returns `{}` (no per-statement flip — commit is at entry).
- Add: `blockEntryFlip()` prints `__self.__destructiveRan = true;`.
- Keep the Rule-2 (non-destructive caller) outcome-flip / pre-flip tests unchanged.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/backends/typescriptBuilder/destructiveTracking.test.ts 2>&1 | tail -20`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `destructiveTracking.ts`:
```typescript
/** Function-entry init. A `destructive def` commits its whole body: set the
 *  flag true at entry (init runs AFTER arg binding, so a bad-args failure that
 *  halts before init stays retryable). A non-destructive function keeps the
 *  `?? false` default so an externally set value (decision-8, block entry) is
 *  preserved. */
init(inDestructiveFunction: boolean): TsNode {
  return ts.assign(
    ts.self("__destructiveRan"),
    inDestructiveFunction
      ? ts.bool(true)
      : ts.binOp(ts.self("__destructiveRan"), "??", ts.bool(false)),
  );
}

/** The `destructive { }` entry flip. Emitted INLINE in the enclosing function's
 *  stepped body (never in a block frame), so `ts.self` resolves to the
 *  function's `__self`. */
blockEntryFlip(): TsNode {
  return this.markTrue(); // __self.__destructiveRan = true
}
```
Make `markTrue()` non-private (or call `ts.assign(ts.self("__destructiveRan"), ts.bool(true))` directly in `blockEntryFlip`).

Change `statementFlips` so the destructive-function branch no longer scans:
```typescript
statementFlips(stmt, inDestructiveFunction) {
  // A destructive def commits at entry (init); no per-statement flips.
  if (inDestructiveFunction) return {};
  // Rule 2 (non-destructive caller of a destructive fn) — unchanged.
  const outcomeVar = this.destructiveOutcomeVar(stmt);
  if (outcomeVar) return { post: this.outcomeFlip(outcomeVar) };
  return this.names.containsDestructiveCall(stmt) ? { pre: this.markTrue() } : {};
}
```

In `lib/backends/typescriptBuilder.ts:2132`, change the call:
```typescript
setupStmts.push(this.tracking.init(this.scopes.inDestructiveFunction));
```
(`this.scopes.inDestructiveFunction` is set at `:2266` from `node.markers?.destructive`, before this line runs.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run lib/backends/typescriptBuilder/destructiveTracking.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder/destructiveTracking.ts lib/backends/typescriptBuilder.ts lib/backends/typescriptBuilder/destructiveTracking.test.ts
git commit -m "codegen: destructive def commits at function entry; drop per-statement Rule 1"
```

---

### Task 6: Inline-splice codegen for `destructive { }` (the fail-open guard)

**Files:**
- Modify: `lib/backends/typescriptBuilder.ts` — `processBodyAsParts` loop (~3954–4010)
- Test: `tests/typescriptGenerator/destructive-block.agency` + `.mts` (fixtures); assertion below

**Interfaces:**
- Consumes: `DestructiveTracking.blockEntryFlip()` (Task 5).

**THE headline constraint (Global Constraints): the block must be spliced inline into the enclosing stepped stream, NOT compiled as a frame-bearing block, or the flip evaporates and the tool fails open.** Mirror the existing pipe-chain inline expansion.

- [ ] **Step 1: Refactor the loop body into a recursive `emitStmt` closure**

In `processBodyAsParts`, extract the per-statement work (currently the body of `for (const stmt of body)`) into a local `const emitStmt = (stmt: AgencyNode): void => { ... }`, then make the loop `for (const stmt of body) emitStmt(stmt);`. Keep `flushPart()` after the loop. `emitStmt` must contain the existing pipe-chain check, the `flushPart` gate, `statementFlips`, `processStatement`, the `post` flip, async-branch-key, and source-map logic — verbatim, replacing `continue;` with `return;`.

- [ ] **Step 2: Add the `destructiveBlock` case at the top of `emitStmt`**

Immediately after the pipe-chain check inside `emitStmt`:
```typescript
if (stmt.type === "destructiveBlock") {
  // Entry flip on the ENCLOSING function's __self (inline — no block frame),
  // pushed as a non-step preamble into the active part, exactly like a pre-flip.
  if (!currentPart) currentPart = [];
  currentPart.push(this.tracking.blockEntryFlip());
  // Splice the body inline: each inner statement gets continuing substep ids,
  // its declarations stay visible after the block, and interrupts inside resume
  // relative to statements that follow the block.
  for (const inner of (stmt as DestructiveBlock).body) emitStmt(inner);
  return;
}
```
Import `DestructiveBlock` in `typescriptBuilder.ts`.

- [ ] **Step 3: Create the fixture**

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
Generate the `.mts` per the repo's fixture workflow: `make fixtures` (or the documented single-fixture command). Inspect the generated code and CONFIRM: `__self.__destructiveRan = true` appears inside `writeThing`'s body (referencing the function `__self`), NOT inside a `__bstack`/block frame, and the `return try _doWrite(p)` sits in the same stepped stream.

- [ ] **Step 4: Run the generator fixture check**

Run: `pnpm vitest run tests/typescriptGenerator 2>&1 | tail -20`
Expected: PASS (fixture matches committed `.mts`).

- [ ] **Step 5: Commit**

```bash
git add lib/backends/typescriptBuilder.ts tests/typescriptGenerator/destructive-block.*
git commit -m "codegen: inline-splice destructive { } so the entry flip lands on the function __self"
```

---

### Task 7: Derived is-destructive metadata (marked OR contains-block)

**Files:**
- Create: `lib/backends/functionContainsDestructiveBlock.ts` (small shared helper)
- Modify: `lib/backends/typescriptBuilder.ts:2340` (descriptor marker) using the derived value
- Modify: `lib/compilationUnit.ts` (`registerMarkers` call sites at :211/:307 pass a derived `isDestructive`)
- Test: `lib/backends/functionContainsDestructiveBlock.test.ts`; a serving/registry test

**Interfaces:**
- Produces: `functionContainsDestructiveBlock(body: AgencyNode[]): boolean` (walks for any `destructiveBlock`, recursing into nested bodies via `walkNodes`).
- **MUST NOT** mutate `node.markers`. The entry flip / `inDestructiveFunction` (`:2266`) continue to read the raw `node.markers?.destructive` ONLY.

- [ ] **Step 1: Write failing helper test**

`lib/backends/functionContainsDestructiveBlock.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { functionContainsDestructiveBlock } from "./functionContainsDestructiveBlock.js";

describe("functionContainsDestructiveBlock", () => {
  it("true when a destructive block is present (even nested in an if)", () => {
    const body = [{ type: "ifElse", condition: {}, thenBody: [
      { type: "destructiveBlock", body: [] },
    ], elseBody: [] }] as any;
    expect(functionContainsDestructiveBlock(body)).toBe(true);
  });
  it("false with no block", () => {
    expect(functionContainsDestructiveBlock([{ type: "returnStatement", value: {} }] as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run lib/backends/functionContainsDestructiveBlock.test.ts 2>&1 | tail -15`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the helper**

`lib/backends/functionContainsDestructiveBlock.ts`:
```typescript
import { AgencyNode } from "../types.js";
import { walkNodesArray } from "../utils/node.js";

/** True if any `destructive { }` block appears anywhere in `body` (including
 *  nested blocks/ifs/loops). Used for is-destructive METADATA only (descriptor
 *  marker, MCP/HTTP hint, destructiveFunctions registry) — never for the entry
 *  flip, which keys on the raw `destructive def` marker alone. */
export function functionContainsDestructiveBlock(body: AgencyNode[]): boolean {
  for (const { node } of walkNodesArray(body)) {
    if (node.type === "destructiveBlock") return true;
  }
  return false;
}
```
(Confirm `walkNodesArray`'s exact name/signature in `lib/utils/node.ts`; match it.)

- [ ] **Step 4: Use it for the descriptor marker**

In `lib/backends/typescriptBuilder.ts` ~2340:
```typescript
const isDestructive =
  !!node.markers?.destructive ||
  functionContainsDestructiveBlock(node.body);
if (isDestructive || node.markers?.idempotent) {
  const markerProps: Record<string, TsNode> = {};
  if (isDestructive) markerProps.destructive = ts.bool(true);
  if (node.markers.idempotent) markerProps.idempotent = ts.bool(true);
  createProps.markers = ts.obj(markerProps);
}
```
Do NOT touch `:2266` (`inDestructiveFunction = !!node.markers?.destructive`).

- [ ] **Step 5: Use it for the registry**

In `lib/compilationUnit.ts`, at the `registerMarkers(unit, node.functionName, node.markers)` call (~:211) and the re-export call (~:307), pass a marker object whose `destructive` is the derived value. Simplest: extend `registerMarkers` to also take `containsBlock: boolean` and OR it in:
```typescript
function registerMarkers(unit, localName, markers, containsBlock = false) {
  if (markers?.destructive || containsBlock) unit.destructiveFunctions[localName] = true;
  if (markers?.idempotent) unit.idempotentFunctions[localName] = true;
}
```
At `:211`: `registerMarkers(unit, node.functionName, node.markers, functionContainsDestructiveBlock(node.body));`. At `:307` (re-export), the block info comes from the resolved symbol's body if available; if the re-export path has no body, pass `false` (a re-exported name's own def already registered it locally).

- [ ] **Step 6: Run helper test + serving/registry tests**

Run: `pnpm vitest run lib/backends/functionContainsDestructiveBlock.test.ts lib/serve/mcp/adapter.test.ts lib/serve/http/adapter.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/backends/functionContainsDestructiveBlock.ts lib/backends/functionContainsDestructiveBlock.test.ts lib/backends/typescriptBuilder.ts lib/compilationUnit.ts
git commit -m "codegen: derive is-destructive as marked-OR-contains-block for descriptor/hint/registry"
```

---

### Task 8: Remove the dead `containsImpureCall` heuristic

**Files:**
- Modify: `lib/backends/typescriptBuilder/nameClassifier.ts` (remove `containsImpureCall` + `isImpureImportedFunction` if now unused)
- Modify: `nameClassifier.test.ts` (remove its tests)

- [ ] **Step 1: Confirm no remaining consumer**

Run: `grep -rn "containsImpureCall" lib/ | grep -v ".test.ts"`
Expected: only the definition (its sole caller was the old `statementFlips` Rule 1, removed in Task 5). If `isImpureImportedFunction` has no other consumer, remove it too (check with the same grep).

- [ ] **Step 2: Delete the methods and their tests**

Remove `containsImpureCall` (and `isImpureImportedFunction` if dead) from `nameClassifier.ts`; delete the corresponding `nameClassifier.test.ts` cases.

- [ ] **Step 3: Typecheck + nameClassifier tests**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head; pnpm vitest run lib/backends/typescriptBuilder/nameClassifier.test.ts 2>&1 | tail -10`
Expected: no errors; tests pass.

- [ ] **Step 4: Commit**

```bash
git add lib/backends/typescriptBuilder/nameClassifier.ts lib/backends/typescriptBuilder/nameClassifier.test.ts
git commit -m "cleanup: remove dead containsImpureCall import heuristic"
```

---

### Task 9: Rewrite the `destructive-tracking` execution tests to the region model

**Files:**
- Modify: `tests/agency/destructive-tracking.agency`
- Modify: `tests/agency/destructive-tracking.test.json`

**Interfaces:** these are Agency execution tests (no LLM). `destructiveRan`/`neverStarted` are read off the failure Result and returned as arrays for exact match.

- [ ] **Step 1: Rewrite the source to use a block**

`burn` becomes a plain `def` whose destructive work sits in a `destructive { }` block after a validation guard, so "refuse before the region" stays clean:
```
def burn(x: number): Result {
  if (x < 0) {
    return failure("refused before doing anything")   // before the region → clean
  }
  destructive {
    return failure("failed after starting")            // inside the region → committed
  }
}
```
Keep `caller`, `cleanRefusal`, `startedThenFailed`, `plainFailure` node shapes. Add a `destructive def` case to prove function-entry commit, e.g.:
```
destructive def burnWhole(): Result {
  return failure("committed at entry")
}
node wholeEntry() {
  const r = burnWhole()
  if (isFailure(r)) { return [r.neverStarted, r.destructiveRan] }
  return "unexpected"
}
```

- [ ] **Step 2: Update expectations in `.test.json`**

- `cleanRefusal` (burn(-1), refuses before block) → `[false,false]` (unchanged intent).
- `startedThenFailed` (burn(1), fails in block) → `[false,true]`.
- New `wholeEntry` (`destructive def` fails at entry) → `[false,true]`.
- `plainFailure` (unmarked, no block) → `[false,false]`.
- Re-derive the `succeededThenFailed` / `trySwallowed` / `blockHalt` / `blockJoin` / `ifBlock` / `forBlock` cases against the new source (rewrite whichever assumed the old import-heuristic flips). Any case whose destructive work now lives in a `destructive { }` block should still yield `destructiveRan = true` when a failure escapes after entering it.

- [ ] **Step 3: Run the single test**

Run: `pnpm run a test tests/agency/destructive-tracking.test.json 2>&1 | tee /tmp/dtrack.log | tail -30`
Expected: all cases pass.

- [ ] **Step 4: Commit**

```bash
git add tests/agency/destructive-tracking.agency tests/agency/destructive-tracking.test.json
git commit -m "test: rewrite destructive-tracking to the region model"
```

---

### Task 10: Behavior tests — the review's mandated coverage

**Files:**
- Create: `tests/agency/destructive-block.agency` + `tests/agency/destructive-block.test.json`

Cover the four review mandates deterministically (no real LLM):

- [ ] **Step 1: Frame-escape (Finding A — anti-fail-open).** A `def` with a `destructive { }` block whose work fails; the failure escapes the WHOLE function; assert `destructiveRan === true` on the escaping failure (read at the caller, i.e. after the function returns), NOT merely at block entry.
```
def wf(): Result {
  destructive { return failure("boom") }
}
node frameEscape() {
  const r = wf()
  if (isFailure(r)) { return [r.destructiveRan] }   // must be [true]
  return "unexpected"
}
```
Expected output `[true]`. (In a frame-local mis-implementation this is `[false]`.)

- [ ] **Step 2: Return-in-block (Finding D).** Confirm a `return` inside `destructive { }` exits the function and the escaping failure carries the flag — covered by Step 1's `return failure(...)` inside the block; add a success variant:
```
def wr(): number {
  destructive { return 42 }
}
node returnInBlock() { return wr() }   // exact 42
```

- [ ] **Step 3: Declaration visibility (Finding B).** A `let` declared inside the block is used AFTER the block:
```
def dv(): number {
  destructive { let y = 10 }
  return y + 1
}
node declVisible() { return dv() }   // exact 11
```
(If the block were a real frame, `y` would be out of scope → compile error. This test guards the transparency.)

- [ ] **Step 4: Interrupt in a destructive block (mandated).** A `destructive { }` block containing an interrupt; approve → resumes and completes; reject → the tool/function surfaces the rejection. Model on `tests/agency/interrupts/interrupt.agency` structure with `interruptHandlers` in the `.test.json`. Add an interrupt AFTER a statement following the block to prove continuous substep ids on resume:
```
def ib(): string {
  destructive {
    const a = interrupt("go?")
    return "did ${a}"
  }
}
node interruptInBlock() { return ib() }
```
`.test.json` entry with an `approve` handler and exact/expected output; a second entry with `reject` asserting the failure surfaces. Use `useTestLLMProvider: true` if any llm() is involved; here `ib()` has no llm(), so a direct interrupt handler suffices.

- [ ] **Step 5: Run**

Run: `pnpm run a test tests/agency/destructive-block.test.json 2>&1 | tee /tmp/dblock.log | tail -40`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add tests/agency/destructive-block.agency tests/agency/destructive-block.test.json
git commit -m "test: destructive block frame-escape, return, decl-visibility, interrupt-resume"
```

---

### Task 11: Parser disambiguation tests (Finding E)

**Files:**
- Modify: `lib/parsers/destructiveBlock.test.ts` (extend); add a fixture for nested-in-`destructive def`

- [ ] **Step 1: Add cases**

```typescript
it("parses `destructive { }` as a statement inside a function body", () => {
  // via the statement/body parser, not the block parser directly
});
it("nested destructive { } inside a destructive def compiles (no-op, flag already true)", () => {
  // parse `destructive def f() { destructive { return 1 } }` and assert it parses
});
```
Also add an agency fixture `tests/typescriptGenerator/destructive-nested.agency` with a `destructive def` containing a `destructive { }` and confirm it compiles (the inner block's flip is a redundant `= true`).

- [ ] **Step 2: Run parser + generator tests; commit**

Run: `pnpm vitest run lib/parsers/destructiveBlock.test.ts tests/typescriptGenerator 2>&1 | tail -20`
```bash
git add -A && git commit -m "test: destructive block parser disambiguation + nested-in-destructive-def"
```

---

### Task 12: Migrate `stdlib/git.agency`

**Files:** Modify `stdlib/git.agency` (9 functions). Uniform rule: `export destructive def` → `export def`, wrap every statement AFTER the `return interrupt <effect>(...)` gate in `destructive { }`. Prep/validation/message-building BEFORE the gate stays outside.

Per-function work regions (everything after the gate line):
- `gitAdd`: `destructive { _gitRun(dir, addArgs({...})); return "Staged changes" }`
- `gitCommit`: `destructive { return _gitRun(dir, commitArgs({message})) }`
- `gitCheckout`: `destructive { return _gitRun(dir, checkoutArgs({target, force})) }`
- `gitSwitch`: `destructive { return _gitRun(dir, switchArgs({branch, create})) }`
- `gitBranchCreate`: `destructive { _gitRun(dir, branchCreateArgs({branch})); return "Created branch ${branch}" }`
- `gitBranchDelete`: `destructive { _gitRun(dir, branchDeleteArgs({...})); return "Deleted branch ${branch}" }`
- `gitStashPush`: `destructive { return _gitRun(dir, stashPushArgs({message})) }`
- `gitStashPop`: `destructive { return _gitRun(dir, stashPopArgs()) }`
- `gitRestore`: `destructive { _gitRun(dir, restoreArgs({paths, staged})); return "Restored ${paths.length} file(s)" }`

Keep the `raises <std::git::*>` clauses and docstrings unchanged.

- [ ] **Step 1: Apply the migration to all 9 functions** (change `destructive def`→`def`; wrap post-gate work).
- [ ] **Step 2: Rebuild**

Run: `make 2>&1 | tail -15`
Expected: build succeeds.

- [ ] **Step 3: Confirm client hint preserved**

Add/extend a serving test (or reuse `lib/serve/*/adapter.test.ts`) asserting `gitAdd` still reports `destructive: true` / `destructiveHint`. If git isn't in an existing serving fixture, add a focused unit check compiling a tiny module that imports `gitAdd` and asserting the descriptor marker.
Run: `pnpm vitest run lib/serve 2>&1 | tail -15`

- [ ] **Step 4: Commit**

```bash
git add stdlib/git.agency && git commit -m "stdlib: migrate git destructive defs to destructive { } regions"
```

---

### Task 13: Migrate `stdlib/fs.agency`

**Files:** Modify `stdlib/fs.agency` (6 functions). Same rule.

Work regions (after the `return interrupt std::<effect>(...)` gate; prep like `useAgentCwd` resolution and `edit`'s `_previewEdit` stays outside):
- `edit`: `destructive { return try _multiedit(dir, filename, edits) }`
- `applyPatch`: `destructive { return try _applyPatch(patch, allowedPaths) }`
- `mkdir`: `destructive { return try _mkdir(dir, allowedPaths) }`
- `copy`: `destructive { return try _copy(src, dest, allowedPaths) }`
- `move`: `destructive { return try _move(src, dest, allowedPaths) }`
- `remove`: `destructive { return try _remove(target, allowedPaths) }`

- [ ] **Step 1: Apply** (`destructive def`→`def`; wrap post-gate).
- [ ] **Step 2: Rebuild** — `make 2>&1 | tail -15`.
- [ ] **Step 3: Smoke** — compile a file importing `edit` and confirm it builds; if there is an fs stdlib test, run it. Run: `pnpm run compile foo.agency` on a scratch that imports one fs fn, or run any existing `tests/agency/*fs*`/`write-binary` test.
- [ ] **Step 4: Commit** — `git add stdlib/fs.agency && git commit -m "stdlib: migrate fs destructive defs to destructive { } regions"`

---

### Task 14: Migrate `stdlib/index.agency` (`write`, `writeBinary`) and `stdlib/clipboard.agency` (`copy`)

**Files:** Modify `stdlib/index.agency`, `stdlib/clipboard.agency`.

Work regions:
- `write`: `destructive { return try _write(dir, filename, content, mode) }`
- `writeBinary`: `destructive { return try _writeBinary(dir, filename, base64, mode) }`
- `clipboard.copy`: `destructive { _copy(text) }`

(Leave `paste`, `readBinary`, and other non-`destructive` functions untouched.)

- [ ] **Step 1: Apply** (`destructive def`→`def`; wrap post-gate).
- [ ] **Step 2: Rebuild** — `make 2>&1 | tail -15`.
- [ ] **Step 3: Run the write tests** — Run: `pnpm run a test tests/agency/write-binary.test.json 2>&1 | tail -20` and any `write` agency test. Expected: pass (behavior unchanged on approval; the block is transparent).
- [ ] **Step 4: Migrated-tool behavior test.** Add/extend an agency test (deterministic) for `write`: rejecting the "Are you sure?" gate returns a retryable failure (the block was never entered → `destructiveRan` false); a forced in-block failure removes the tool. Model on `tests/agency/write-binary.test.json` (which already has a `writeBinaryRejectedDoesNotWrite` case — extend it to assert retryability/`destructiveRan`).
- [ ] **Step 5: Commit** — `git add stdlib/index.agency stdlib/clipboard.agency tests/agency/write-binary.* && git commit -m "stdlib: migrate write/writeBinary/clipboard.copy to destructive { } regions"`

- [ ] **Step 6: Sweep for any missed `destructive def`**

Run: `grep -rn "destructive def" stdlib/`
Expected: empty (all migrated). If any remain (e.g. `shell.agency` exec/bash), migrate them with the same rule in this step and re-run `make`.

---

### Task 15: Migrate `stdlib/shell.agency` (`exec`, `bash`)

**Files:** Modify `stdlib/shell.agency`. Read each function first (`sed -n '41,140p' stdlib/shell.agency`) — these may not follow the exact `return interrupt` shape, so **enumerate each one's gate/work boundary explicitly** before wrapping (Finding D: a mis-drawn boundary leaves committed work outside the region = fail-open).

- [ ] **Step 1: Read and record each function's split** (prep / gate / work) as a comment in the task notes; wrap only the post-gate effectful work in `destructive { }`; `destructive def`→`def`.
- [ ] **Step 2: Rebuild** — `make 2>&1 | tail -15`.
- [ ] **Step 3: Run any shell/exec agency test; smoke a compile importing `bash`.**
- [ ] **Step 4: Commit** — `git add stdlib/shell.agency && git commit -m "stdlib: migrate shell exec/bash to destructive { } regions"`

---

### Task 16: Docs

**Files:**
- Modify: `docs/site/guide/llm-part-2.md` (the "when a tool call fails" section): document that a `destructive def` commits at entry and introduce the `destructive { }` block for granular regions with the gate-outside pattern.
- Modify: `lib/runtime/result.ts` — JSDoc on `destructiveRan`: "execution entered a destructive region (a `destructive def` body or a `destructive { }` block)."
- Modify: doc comments in `lib/backends/typescriptBuilder/destructiveTracking.ts` referencing the old import-heuristic rationale.

- [ ] **Step 1: Update the three doc locations** with the region model (show the migrated `write` before/after as the example).
- [ ] **Step 2: Regenerate stdlib docs if needed** — Run: `make` (regenerates `agency doc` output). Confirm `docs/site/stdlib/*.md` still builds.
- [ ] **Step 3: Commit** — `git add -A && git commit -m "docs: document destructive { } regions and the region-commit model"`

---

### Task 17: Full-suite verification

- [ ] **Step 1: Structural lint** — Run: `pnpm run lint:structure 2>&1 | tail -20`. Fix any violations.
- [ ] **Step 2: Full lib test suite** — Run: `pnpm test:run 2>&1 | tee /tmp/libtests.log | tail -30`. Expected: green (8000+). Investigate any failure via the saved log.
- [ ] **Step 3: Build** — Run: `make 2>&1 | tail -15`. Expected: success.
- [ ] **Step 4: Do NOT run the full agency suite locally** (slow/expensive; CI runs it). Confirm the targeted agency tests from Tasks 9, 10, 14 pass from their saved logs.
- [ ] **Step 5: Open the PR** — push the branch and open a PR summarizing: region-commit model, new `destructive { }` construct, derived is-destructive metadata, stdlib migration, and the fail-open guard. Note the deferred non-goal (unifying the success path onto the runtime flag).

---

## Self-Review (completed by plan author)

**Spec coverage:** function-entry commit → Task 5; `destructive { }` construct → Tasks 1–4, 6; inline-splice/fail-open guard → Task 6 + Global Constraints; derived is-destructive metadata (no `node.markers` mutation) → Task 7; remove `containsImpureCall` → Task 8; stdlib migration (enumerated) → Tasks 12–15; the four review test mandates → Tasks 10–11; docs → Task 16. All spec sections map to a task.

**Placeholder scan:** every code step shows real code; stdlib splits are enumerated per function; the one genuinely unknown-shape functions (`shell.agency`) get an explicit read-and-enumerate step (Finding D) rather than an assumed pattern.

**Type consistency:** `functionContainsDestructiveBlock(body)`, `init(inDestructiveFunction)`, `blockEntryFlip()`, node `type: "destructiveBlock"` with `.body` are used consistently across Tasks 1, 5, 6, 7.
