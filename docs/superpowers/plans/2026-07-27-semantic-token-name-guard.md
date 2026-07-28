# Semantic Token Name Guard Implementation Plan

> Revised 2026-07-27 after review. See `2026-07-27-semantic-token-name-guard-REVIEW.md` for the findings this revision answers.

**Goal:** Stop the LSP from emitting semantic tokens whose length comes from a synthesized name that is longer than the source text at that position, which currently paints neighbouring characters the wrong color.

**Architecture:** `getSemanticTokens` already drops tokens that cannot fit in the current buffer (`fitsInCurrentText`). Extend that same filter into a stronger claim: a token is only emitted if the text at its position **is** the identifier it names, as a whole word. This is one guard in `lib/lsp/semanticTokens.ts`; no lowering, parser, or AST change.

**Tech Stack:** TypeScript, vitest, `vscode-languageserver` (`SemanticTokensBuilder`), run through pnpm in `packages/agency-lang`.

## Background — why this bug exists

`toToken` (lib/lsp/semanticTokens.ts:184) sets a token's width from the AST name:

```ts
length: slot.name.length,
```

That is correct for identifiers the user actually typed. It is wrong for nodes that **lowering synthesizes**, because those synthetic nodes carry a real source `loc` under a name that never appears in the source. `resultCheckCall` (lib/lowering/patternLowering.ts:1277-1288) is the clearest case:

```ts
functionName: kind === "success" ? "isSuccess" : "isFailure",
arguments: [cloneExpr(source)],
loc: loc as SourceLocation,   // the loc of `failure` / `success` in the source
```

`"isFailure".length` is 9, but the source text at that `loc` is `failure` — 7 characters. The token overruns by 2.

### How much of this there is

Running the current encoder over every `.agency` file in `stdlib/` and `tests/agency/` — 1105 files, 5650 emitted tokens — 382 tokens are painted over text that is not the name they claim. They come from five different lowerings, not one:

| Synthesized name | Tokens | Comes from | What it paints today |
|---|---|---|---|
| `_guard` | 157 | the `guard` keyword construct | `guard(` — the keyword plus the paren |
| `isFailure` | 87 | `is failure(...)` lowering | `failure(x` — into the binder |
| `isSuccess` | 71 | `is success(...)` lowering | `success(v` |
| `map` / `filter` / `_pairsOf` | 40 | list-comprehension lowering | `[do` — the bracket and two letters |
| `__objectRest` | 8 | object-rest patterns | the `if` keyword |
| `matchInit$N`, `__requireLength` | 8 | match and array-length lowering | assorted |

`_guard` is the largest and appears in nearly every agent under `stdlib/agents/` — for example `stdlib/agents/coding.agency:128`, `return guard(cost: maxCost, ...)`. The source word is five characters, the synthesized name is six, so the token runs onto the `(`.

The comprehension case is the most visually wrong: the synthesized `map` call is hung on the loc of the whole comprehension, so in `tests/agency/comprehensions/basic.agency:17` — `const doubled = [double(x) for x in xs]` — the token paints `[do`.

`stdlib/safeBash.agency:398` is the case that was originally reported: the `r` of `reason` renders in the function color while `eason` keeps the grammar's variable color.

### Real calls the guard also drops

Not every mismatch is a synthesized name. Some are genuine user-written calls whose `loc.col` points at a keyword rather than at the callee:

```
tests/agency/substeps/async-in-if.agency:8    const a = async double(x)
```

The slot's name is `double`, six characters, but its column is the column of `async`, so the token paints `async ` — the keyword and a space. After this change that token is dropped, and `double` gets no semantic token at all.

That is still the right outcome. No color is better than a wrong color on a keyword, and the TextMate grammar already colors `double(` as a call, so nothing visibly disappears. But it means the guard **hides** a position bug rather than fixing it. Task 2 records that with a tripwire test, and a follow-up issue should be filed for the `async` loc itself.

The same shape shows up for `match` statements whose scrutinee is an `is` pattern — `match (r is success(v))` anchors a lowered `failure` call on the `match` keyword.

**Rejected alternative:** fixing the locs at the lowering sites. Those `loc`s are shared with diagnostics, hover, and go-to-definition; narrowing them to satisfy the highlighter risks regressing error positions in a much larger surface. The guard also covers synthesized names not yet written, without a per-site audit.

## Global Constraints

- Package root for every command: `packages/agency-lang`.
- The legend is a wire contract — `SEMANTIC_TOKENS_LEGEND.tokenTypes` stays `["function"]` and `tokenModifiers` stays `["defaultLibrary"]`. Do not add, remove, or reorder entries.
- Do not change `lib/lowering/patternLowering.ts`, the parser, or any AST type.
- `getSemanticTokens(state)` with no text argument must keep working — many callers and tests construct state directly.
- Token push order must stay sorted by position; `SemanticTokensBuilder` emits deltas and never sorts.
- Do not change the existing test helpers `stateFor`, `decodeTokens`, `tokensFor`, `textsFor`. `tokensFor` calls the ONE-argument form of `getSemanticTokens` (lib/lsp/semanticTokens.test.ts:89-91), which is why the source-text fallback below is part of the same task rather than a follow-up: without it, none of the new tests would exercise the guard at all.

---

## File Structure

- `lib/lsp/semanticTokens.ts` — the only implementation change. `Token` gains a `name` field; `fitsInCurrentText` is replaced by a whole-word name match; `getSemanticTokens` falls back to the text the state was parsed from.
- `lib/lsp/semanticTokens.test.ts` — one new `describe` block for synthesized names, and one tripwire appended to the existing `known gaps` block. Existing blocks are otherwise untouched.

---

### Task 1: Drop tokens whose text is not the whole word they name

**Files:**
- Modify: `lib/lsp/semanticTokens.ts` — the `Token` type (69-75), `toToken` (167-188), `fitsInCurrentText` (203-221), the doc comment and head of `getSemanticTokens` (223-238), the filter chain (244-248)
- Test: `lib/lsp/semanticTokens.test.ts` (append a new `describe` block at the end)

**Interfaces:**
- Consumes: existing `Token`, `IdentifierSlot`, `getSemanticTokens(state, currentText?)`, `DocumentState.info.sourceText` (`string | undefined`, lib/compilationUnit.ts:136; populated on the LSP path at lib/lsp/diagnostics.ts:228 with `doc.getText()`), and the test helpers already in the test file.
- Produces: `Token` gains `name: string`. `fitsInCurrentText` is replaced by `paintsItsOwnName(token, lines)` with the same `(Token, string[] | null) => boolean` shape. No exported signature changes.

- [ ] **Step 1: Write the failing tests**

Append to the end of `lib/lsp/semanticTokens.test.ts`:

```ts
describe("getSemanticTokens against synthesized names", () => {
  // Lowering builds calls whose names never appear in the source but
  // which carry a real source loc — `is failure(x)` becomes a call to
  // `isFailure` sitting on the seven characters `failure`, `guard(...)`
  // becomes `_guard`, a comprehension becomes `map`. Length comes from
  // the name, so those tokens ran past the word they sat on.

  /** Every token must cover exactly one whole identifier. */
  function expectWholeWords(source: string): void {
    for (const token of tokensFor(source)) {
      expect(token.text).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  }

  it("does not overrun the source word for `is failure(binder)`", () => {
    expectWholeWords(
      `node main() {\n  const r = pass()\n  if (r is failure(reason)) {\n    print(reason)\n  }\n}`,
    );
  });

  it("does not overrun the source word for `is success(binder)`", () => {
    expectWholeWords(
      `node main() {\n  const r = pass()\n  if (r is success(v)) {\n    print(v)\n  }\n}`,
    );
  });

  it("does not paint the paren after `guard`", () => {
    // The biggest case by volume: `_guard` is six characters over the
    // five of `guard`, so the token used to swallow the `(`.
    expectWholeWords(
      `node main() {\n  const r = guard(cost: 1) {\n    print("hi")\n  }\n}`,
    );
  });

  it("does not paint the bracket of a comprehension", () => {
    // A comprehension lowers to `map`, hung on the loc of the WHOLE
    // comprehension, so the token painted `[do`.
    expectWholeWords(
      `def double(x: number): number {\n  return x * 2\n}\n\nnode main() {\n  const xs = [1, 2]\n  const doubled = [double(x) for x in xs]\n  print(doubled)\n}`,
    );
  });

  it("emits no token at all for the object-rest helper", () => {
    // The worst case: the synthesized name is hung on the `if`
    // statement's own loc, so the token painted the `if` keyword.
    const source = `node main() {\n  const o = { a: 1, b: 2 }\n  if (o is { a, ...rest }) {\n    print(a)\n  }\n}`;
    const onIfLine = tokensFor(source).filter((t) => t.line === 2);
    expect(onIfLine).toEqual([]);
  });

  it("still colors the real calls around a lowered pattern", () => {
    // The guard must drop the synthetic token WITHOUT taking the
    // genuine ones with it, or the fix is just "emit nothing".
    const source = `node main() {\n  const r = pass()\n  if (r is failure(reason)) {\n    print(reason)\n  }\n}`;
    expect(textsFor(source)).toEqual(["pass", "print"]);
  });

  it("drops a token that is only a prefix of the word now at its position", () => {
    // A stale buffer, mid-rename: state says `helper` at a position
    // where the user has since typed `helperTwo`. The slice matches the
    // name, so a bare equality check would paint the first six letters
    // of a longer word — the very failure this guard exists to stop.
    const before = `def helper(): number {\n  return 1\n}\n\nnode main() {\n  helper()\n}`;
    const after = before.replace("  helper()", "  helperTwo()");
    const data = getSemanticTokens(stateFor(before), after).data;
    expect(decodeTokens(data, after).filter((t) => t.line === 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/agency-lang
npx vitest run lib/lsp/semanticTokens.test.ts -t "synthesized names" 2>&1 | tee /tmp/st-before.txt
```

Expected: 7 tests, 6 FAIL and `still colors the real calls around a lowered pattern` fails too (it currently sees a third, truncated element). Read the output rather than assuming which ones fail — `tokensFor` uses the one-argument form, so nothing but the last test passes any text in.

- [ ] **Step 3: Add `name` to the `Token` type**

In `lib/lsp/semanticTokens.ts`, replace the `Token` type (currently lines 69-75):

```ts
type Token = {
  line: number;
  col: number;
  length: number;
  /** The identifier this token claims to paint — see paintsItsOwnName. */
  name: string;
  typeIndex: number;
  modifiers: number;
};
```

- [ ] **Step 4: Populate it in `toToken`**

In the object literal returned by `toToken` (currently lines 179-187), add the `name` field next to the `length` it is derived from, so the two cannot drift:

```ts
  return {
    line: slot.line,
    col: slot.col,
    // The identifier's own length. A node's loc spans the whole node, so
    // `end - start` would paint a call's arguments too.
    length: slot.name.length,
    name: slot.name,
    typeIndex: FUNCTION_TYPE_INDEX,
    modifiers: isStandardLibrary(effectiveName, state) ? DEFAULT_LIBRARY_BIT : 0,
  };
```

- [ ] **Step 5: Replace the bounds check with a whole-word name check**

Replace `fitsInCurrentText` and its doc comment (currently lines 203-221) with:

```ts
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/**
 * Does this token paint the exact word it names?
 *
 * Two things make the answer no. A token can be STALE — computed from a
 * document older than the buffer it renders against, which is the
 * deliberate trade in DocumentStateCache — and land past the end of a
 * line that shrank. Or it can be SYNTHESIZED: lowering builds calls whose
 * names never appear in the source, like the `isFailure` behind
 * `x is failure(e)`, and length comes from that longer name.
 *
 * Dropping beats clamping. A clamped token paints whatever text now sits
 * at that position, which is a wrong color on a real word; a dropped one
 * leaves the grammar's color in place, and the grammar already colors
 * every word this drops.
 */
function paintsItsOwnName(token: Token, lines: string[] | null): boolean {
  if (lines === null) return true;
  const line = lines[token.line];
  if (line === undefined) return false;
  const end = token.col + token.length;
  if (line.slice(token.col, end) !== token.name) return false;
  // Equality alone accepts a token that is a PREFIX of the word now at
  // that position — `helper` against a freshly typed `helperTwo`.
  return !IDENTIFIER_CHAR.test(line[end] ?? "");
}
```

- [ ] **Step 6: Point the filter chain at the new guard**

In `getSemanticTokens`, change the filter (currently line 247):

```ts
    .filter((token) => paintsItsOwnName(token, lines))
```

- [ ] **Step 7: Fall back to the text the state was parsed from**

The server passes `doc?.getText()` (lib/lsp/server.ts:362), which is `undefined` whenever the document is not in the open-documents map — a real path that would otherwise serve unguarded tokens. `state.info.sourceText` is the text the state was parsed from, so it is the right thing to check a token against when nothing newer is on offer.

Replace the doc comment above `getSemanticTokens` and its first body line (currently lines 223-238) with:

```ts
/**
 * `currentText` is the buffer as it is RIGHT NOW, which may differ from
 * the text `state` was built from. Omit it and the check falls back to
 * `state.info.sourceText` — older, but still the text these positions
 * were computed against. Only a state assembled with no source text at
 * all skips the check.
 *
 * Cost is O(identifiers x scopes): makeScopeFinder builds its definition
 * map once, but the finder it returns still scans the scope list per
 * call. Linear in identifiers alone would need the scopes sorted by
 * range and a binary search. Measured at 0.3-0.7 ms on real stdlib files
 * and 5.4 ms on a generated 1200-line file, so this is a note for the
 * next reader rather than a todo.
 */
export function getSemanticTokens(
  state: DocumentState,
  currentText?: string,
): SemanticTokens {
  const text = currentText ?? state.info.sourceText;
  const lines = text === undefined ? null : text.split("\n");
```

Leave the rest of the function body unchanged.

- [ ] **Step 8: Run the new tests to verify they pass**

```bash
cd packages/agency-lang
npx vitest run lib/lsp/semanticTokens.test.ts -t "synthesized names" 2>&1 | tee /tmp/st-after.txt
```

Expected: 7 passed.

- [ ] **Step 9: Run the whole semantic tokens suite**

```bash
cd packages/agency-lang
npx vitest run lib/lsp/semanticTokens.test.ts 2>&1 | tee /tmp/st-suite.txt
```

Expected: every test passes, including the three in `getSemanticTokens against a changed document`. A whole-word name comparison is strictly stronger than the bounds check it replaces, so those cases still drop. `emits every token when the text is unchanged` also still passes: its `LONG` fixture contains no lowered construct, and both of its paths are now guarded against the same text.

If that test fails, stop and read the failure rather than loosening the guard — it means a genuine token is being dropped.

- [ ] **Step 10: Typecheck**

```bash
cd packages/agency-lang
pnpm typecheck
```

Expected: no errors. A missing `name` on a `Token` literal surfaces here.

- [ ] **Step 11: Commit**

Write the message to a file first — apostrophes on the command line break the shell.

```
fix(lsp): drop semantic tokens that do not match their source text

Lowering synthesizes calls (isFailure, isSuccess, _guard, the
comprehension map, the object-rest helper) that carry a real source loc
under a name that never appears in the source. Token length comes from
the name, so those tokens ran past the word and painted neighbouring
characters: the first letter of a binder in `x is failure(e)`, the paren
after `guard`, the opening bracket of a comprehension, and the `if`
keyword itself for object-rest patterns. 382 of 5650 tokens across
stdlib and tests/agency were affected.

Replaces the bounds check with a whole-word name comparison, which
subsumes it, and applies it on the no-current-text path too — the server
passes doc?.getText(), which is undefined for a document that is not
open.
```

---

### Task 2: Record the `async` position bug as a tripwire

The guard drops the token for `async double(x)` because the call's `loc.col` points at `async`. That is a position bug in its own right, and hiding it silently is how it stays hidden. The file already has a `getSemanticTokens known gaps` block whose `valueAccess` test is written to fail when the gap closes; this follows that pattern.

**Files:**
- Test only: `lib/lsp/semanticTokens.test.ts`, appended inside `describe("getSemanticTokens known gaps", …)`

- [ ] **Step 1: Add the tripwire**

```ts
  it("TRIPWIRE: cannot color the callee of an `async` call", () => {
    // An `async foo()` call node takes its loc.col from the `async`
    // keyword, not from `foo`. The token would paint `async ` — the
    // keyword and a space — so paintsItsOwnName drops it and the call
    // gets no semantic color. The TextMate grammar still colors it.
    //
    // WHEN THIS TEST FAILS: someone fixed the loc. That is the good
    // outcome. Delete this test.
    const source = `def helper(): number {\n  return 1\n}\n\nnode main() {\n  const a = async helper()\n  print(a)\n}`;
    expect(textsFor(source).filter((t) => t === "helper")).toEqual([]);
  });
```

- [ ] **Step 2: Run the suite**

```bash
cd packages/agency-lang
npx vitest run lib/lsp/semanticTokens.test.ts 2>&1 | tee /tmp/st-suite2.txt
```

Expected: all pass.

- [ ] **Step 3: Run the rest of the LSP tests**

```bash
cd packages/agency-lang
npx vitest run lib/lsp 2>&1 | tee /tmp/lsp-suite.txt
```

Expected: all pass. Nothing else calls `getSemanticTokens`, but `documentStateCache.test.ts` and `server.test.ts` share the state-construction helpers this touched.

- [ ] **Step 4: Commit**

```
test(lsp): tripwire for the async call position bug

`async foo()` takes its loc from the `async` keyword, so the name guard
drops its semantic token. Records the gap so that fixing the loc fails
loudly instead of going unnoticed.
```

- [ ] **Step 5: File the follow-up issue**

Title: `LSP: async call nodes take loc.col from the async keyword`. Body: the token for `async foo()` names `foo` but sits at the column of `async`, so the semantic-token guard drops it and the call gets no semantic color. Reference the tripwire test.

---

## Manual verification

After both tasks, confirm the reported bug is gone in a real editor:

1. Build the package: `cd packages/agency-lang && pnpm build`
2. Open `stdlib/safeBash.agency` in VS Code with the Agency extension active, go to line 398, `if (written is failure(reason)) {`. The `r` of `reason` should now render in the same color as `eason`. `failure` keeps its color from the TextMate grammar (`support.function.builtin.agency`), so nothing there should visibly change.
3. Open `stdlib/agents/coding.agency` at line 128, `return guard(cost: maxCost, ...)`. The `(` after `guard` should no longer be painted in the function color. This is the largest case by volume, so it is the one most likely to be noticed if the guard misses.
4. Put the cursor on the `r` of `reason` and run **Developer: Inspect Editor Tokens and Scopes**. The `semantic token type` row should be absent for that character; before the fix it read `function`.
