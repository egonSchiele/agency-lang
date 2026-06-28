# Match Metadata Preservation (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop discarding the original `match` structure during pattern lowering — carry it on the lowered scrutinee assignment as an optional `matchSource` field — so a later type-checker pass can do exhaustiveness checking. No behavior change.

**Architecture:** `lowerMatchBlock` rewrites a pattern-arm `match` into `[scrutineeAssign, ifChain]` and currently drops the `MatchBlock`. Add `matchSource?: MatchBlock` to the `Assignment` type and set it on the synthetic scrutinee assignment. Codegen and every downstream pass ignore the field; it exists only for the type checker.

**Scope note (intentional):** Only the **pattern-arm** path of `lowerMatchBlock` is tagged. The separate `match (x is …)` form has its own lowering path (`lowerMatchIsForm`, `lib/lowering/patternLowering.ts:292`) and is **deliberately not** tagged here — Part A targets pattern-arm exhaustiveness. A future consumer must not assume the is-form scrutinee carries `matchSource`.

**Tech Stack:** TypeScript, vitest. This is the prerequisite for both `match-exhaustiveness-spec.md` (B1/B2) and `handler-narrowing-spec.md` — but it ships and is reviewable on its own.

## Global Constraints

- NEVER use dynamic imports. Use `type` aliases not `interface`. (CLAUDE.md)
- This is a vitest **unit** change: `npx vitest run <path>`, NOT the agency execution runner.
- **No behavior change.** Codegen output must be byte-identical; the field is additive and read by nobody yet. Verify the full lowering + typecheck suites stay green.
- **Verified facts (do not re-derive):**
  - `Assignment` is at `lib/types.ts:173`; `MatchBlock` is **already imported** at `lib/types.ts:20` (no new import / no new cycle).
  - `lowerMatchBlock`'s pattern-arm path builds `scrutineeAssign` at `lib/lowering/patternLowering.ts:279-285` and always emits it (`return ifChain ? [scrutineeAssign, ifChain] : [scrutineeAssign]`). `node` in scope there is the original `MatchBlock`.
  - The literal-passthrough path returns the `matchBlock` node unchanged — it needs no tag (the structure is already intact).
  - Lowering test helpers exist in `lib/lowering/patternLowering.test.ts`: `lower(source)` (lowers a `node main()` body) and `parseAgency(src, {}, false, false)` (parse with lowering OFF). `liftCallbackBlocks` is in `lib/preprocessors/liftCallbacks.ts`; callback-block syntax is `callback("hook") as data { … }`.
  - The test file **already imports** `AgencyNode`, `Assignment`, and `MatchBlock` from `../types.js` (lines 12-18). Do NOT re-import them — a duplicate `Assignment` import is a TS2300 error that `tsc --noEmit` (Step 6) will reject.

---

## File Structure

- **Modify** `lib/types.ts` — add `matchSource?: MatchBlock` to `Assignment`.
- **Modify** `lib/lowering/patternLowering.ts` — set `matchSource: node` on the scrutinee assignment in `lowerMatchBlock`.
- **Modify** `lib/lowering/patternLowering.test.ts` — presence test + survives-lifting test.

---

### Task 1: Preserve the match structure on the lowered scrutinee assignment

**Files:**
- Modify: `lib/types.ts:173` (the `Assignment` type)
- Modify: `lib/lowering/patternLowering.ts:279-285` (`lowerMatchBlock` scrutinee assignment)
- Test: `lib/lowering/patternLowering.test.ts`

**Interfaces:**
- Produces: `Assignment.matchSource?: MatchBlock` — set only by `lowerMatchBlock`'s pattern-arm path; consumed later by the exhaustiveness diagnostic (not in this plan).

- [ ] **Step 1: Add the `matchSource` field to `Assignment`**

In `lib/types.ts`, in the `Assignment` type (starts at line 173), add the field (after `exported?: boolean;`):

```ts
  tags?: Tag[];
  exported?: boolean;
  /** Set by pattern lowering on the synthetic scrutinee binding of a lowered
   *  `match` with pattern arms. Lets the type checker recover the original arm
   *  structure (exhaustiveness; future match-native narrowing) even though the
   *  executable form is the lowered if-chain. Holds the *un-lowered* MatchBlock,
   *  so its case bodies are pre-lowering — consumers must read only the arm
   *  patterns (`caseValue`/`guard`), never the bodies. Ignored by codegen.
   *  `MatchBlock` is already imported at the top of this file. */
  matchSource?: MatchBlock;
```

- [ ] **Step 2: Write the failing tests**

In `lib/lowering/patternLowering.test.ts`, add ONLY these imports at the top (alongside the existing ones). `AgencyNode`, `Assignment`, and `MatchBlock` are already imported from `../types.js` — do NOT re-import them. Use `walkNodesArray` (not the `walkNodes` generator) so the helper can use `.find(...)`:

```ts
import { walkNodesArray } from "../utils/node.js";
import { liftCallbackBlocks } from "../preprocessors/liftCallbacks.js";
import type { ResultPattern } from "../types/pattern.js";
```

Then append this describe block at the end of the file:

```ts
describe("match metadata preservation (matchSource)", () => {
  function findTaggedAssignment(nodes: AgencyNode[]): Assignment | undefined {
    const hit = walkNodesArray(nodes).find(
      ({ node }) => node.type === "assignment" && node.matchSource,
    );
    return hit?.node as Assignment | undefined;
  }

  it("tags the lowered scrutinee assignment with the original match", () => {
    const lowered = lower(`
let r = foo()
match (r) {
  success(v) => print(v)
  failure(e) => print(e)
}
`);
    const tagged = findTaggedAssignment(lowered);
    expect(tagged).toBeDefined();
    expect(tagged?.matchSource?.type).toBe("matchBlock");
    const cases = tagged?.matchSource?.cases.filter(
      (c) => c.type === "matchBlockCase",
    );
    expect(cases?.length).toBe(2); // success + failure arms preserved
    // Assert structure carried through, not just the arm count: the first arm
    // is a `success(...)` result pattern.
    const first = cases?.[0];
    const pattern =
      first?.type === "matchBlockCase" ? first.caseValue : undefined;
    expect(pattern !== "_" && (pattern as ResultPattern)?.kind).toBe("success");
  });

  it("survives liftCallbackBlocks (match nested in a callback block)", () => {
    // Uses parseAgency + lowerPatterns directly rather than the `lower(...)`
    // helper: `lower` wraps its input in a `node main()` body, but we want the
    // callback block as the top-level shape fed to liftCallbackBlocks so the
    // lift actually moves it. Do NOT "simplify" this back to `lower(...)`.
    const src = `callback("onNodeStart") as data {
  let r = foo()
  match (r) {
    success(v) => print(v)
    failure(e) => print(e)
  }
}
`;
    const parsed = parseAgency(src, {}, false, false);
    if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
    const loweredProgram = {
      ...parsed.result,
      nodes: lowerPatterns(parsed.result.nodes),
    };
    const lifted = liftCallbackBlocks(loweredProgram);
    expect(findTaggedAssignment(lifted.nodes)).toBeDefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run lib/lowering/patternLowering.test.ts -t "matchSource"`
Expected: both tests FAIL — `matchSource` is never set, so `findTaggedAssignment` returns `undefined`. (Step 1 makes them *compile*; the behavior is still missing.)

- [ ] **Step 4: Set `matchSource` on the scrutinee assignment**

In `lib/lowering/patternLowering.ts`, in `lowerMatchBlock`'s pattern-arm path, add the field to the `scrutineeAssign` literal (currently lines 279-285):

```ts
    const scrutineeAssign: Assignment = {
      type: "assignment",
      variableName: scrutineeName,
      declKind: "const",
      value: node.expression,
      loc: node.loc,
      matchSource: node,
    };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/lowering/patternLowering.test.ts`
Expected: PASS (the two new tests plus all existing lowering tests).

- [ ] **Step 6: Verify no behavior change downstream**

The only plausible regression is a test that structurally serializes/compares whole `Assignment` nodes (e.g. an AST-JSON golden). The one such test in the repo is
`lib/preprocessors/typescriptPreprocessor.integration.test.ts` (it `JSON.stringify`s the preprocessed AST against `tests/typescriptPreprocessor/*.json` fixtures). It must run. Codegen ignores the field, so generated-TS fixtures are unaffected — but run the backends/typechecker suites too as a backstop.

Run: `npx vitest run lib/preprocessors/ lib/lowering/ lib/typeChecker/ lib/backends/ 2>&1 | tee /tmp/partA.log`
Expected: PASS (no regressions). If anything fails, inspect `/tmp/partA.log` — a failure here means some pass is structurally-comparing whole `Assignment` nodes (e.g. a snapshot/golden), which would need the field excluded or the fixture regenerated. (If time permits, the fully safe check is the whole unit suite: `npx vitest run`.)

Run: `npx tsc --noEmit`
Expected: clean. (This is what catches a stray duplicate import or type mismatch.)

- [ ] **Step 7: Commit**

```bash
git add lib/types.ts lib/lowering/patternLowering.ts lib/lowering/patternLowering.test.ts
git commit -F - <<'EOF'
feat(lowering): preserve match structure as Assignment.matchSource

Pattern lowering rewrites a pattern-arm `match` into a scrutinee-temp +
if-chain, discarding the original MatchBlock before the type checker runs.
Tag the scrutinee assignment with the original match so a later exhaustiveness
pass (and future match-native narrowing) can recover the arm structure.
Additive optional field, ignored by codegen — no behavior change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Self-Review

**Spec coverage (`match-exhaustiveness-spec.md` Part A):**
- `Assignment.matchSource` added, `MatchBlock` already imported → Step 1. ✓
- Tag set on the pattern-arm scrutinee assignment; literal path and is-form path unchanged → Step 4 + Scope note. ✓
- Presence test + survives-lifting test → Step 2. ✓
- No behavior change (codegen/downstream untouched) → Step 6 guards it. ✓

**Placeholder scan:** none — every code step shows complete code; every run step shows command + expected outcome.

**Type consistency:** `matchSource?: MatchBlock` is the same name/type in `types.ts`, in the `scrutineeAssign` literal, and in the test's `node.matchSource` access. `findTaggedAssignment` narrows on `node.type === "assignment" && node.matchSource`, so the `.matchSource`/`.cases` accesses typecheck. The test reuses the file's existing `AgencyNode`/`Assignment`/`MatchBlock` imports and adds only `walkNodesArray`, `liftCallbackBlocks`, `ResultPattern`.

**Risk to watch (Step 6):** the only plausible regression is a test that structurally compares or snapshots whole `Assignment` nodes and would now see an extra field. The repo's one AST-JSON golden test lives in `lib/preprocessors/`, so Step 6 runs that directory explicitly (no pattern-arm `match` exists in its fixtures today, so nothing is expected to break); if a future fixture does, exclude `matchSource` from the comparison or regenerate the golden rather than dropping the field.
