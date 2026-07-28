# Review — Semantic Token Name Guard plan (2026-07-27)

Plan reviewed: `docs/superpowers/plans/2026-07-27-semantic-token-name-guard.md`

**Overall:** the diagnosis is right, the fix is the right size, and the "drop rather than clamp" reasoning holds up. I verified every code claim in the plan against the files, and I ran the current encoder over 1105 Agency files to measure what the proposed guard would actually do. Three things need to change before this is executed. One of them makes Task 1's own tests fail at the step where the plan says they pass.

---

## What I verified

All of the plan's factual claims check out:

- `lib/lsp/semanticTokens.ts:184` sets `length: slot.name.length`. The line numbers the plan cites for the `Token` type (69-75), `toToken` (167-188), `fitsInCurrentText` (203-221) and the filter chain (244-248) are all correct.
- `lib/lowering/patternLowering.ts:1277-1288` builds the `isSuccess` / `isFailure` call and hands it the source `loc`, exactly as quoted.
- `lib/lsp/server.ts:362` passes `doc?.getText()`, which is `undefined` when the document is not in the open-documents map. That path really is unguarded today.
- `state.info.sourceText` exists (`lib/compilationUnit.ts:136`) and the LSP path really does populate it: `lib/lsp/diagnostics.ts:228` passes `source`, which is `doc.getText()` (`lib/lsp/diagnostics.ts:103`). So Task 2's fallback has something to fall back to.
- Only two node kinds produce identifier slots at all (`variableName`, `functionCall` in `lib/utils/identifierSlots.ts`), and both take `col` from the identifier's own start. That is why a name comparison is safe for ordinary hand-written code.
- `LONG` in the existing `getSemanticTokens against a changed document` block contains no lowered construct, so the plan is right that those three tests keep passing.

To measure the blast radius I temporarily added a probe test that ran the current encoder over every `.agency` file in `stdlib/` and `tests/agency/` (1105 files, 5650 emitted tokens), matched each emitted token back to the slot it came from, and counted how many would be dropped by `slice === name`. The probe file has been deleted; the numbers below come from that run.

---

## Finding 1 (blocking): Task 1's tests will not pass at the end of Task 1

The test helper the plan builds on calls the **one-argument** form:

```ts
// lib/lsp/semanticTokens.test.ts:89-91
function tokensFor(source: string): DecodedToken[] {
  return decodeTokens(getSemanticTokens(stateFor(source)).data, source);
}
```

No `currentText`. So `lines` is `null` and the guard returns `true` for everything — that is true of `fitsInCurrentText` today and would stay true of `paintsItsOwnName` after Task 1.

All four of Task 1's tests go through `tokensFor` or `textsFor` (and `textsFor` calls `tokensFor`). They will still fail at Task 1 Step 7, where the plan says "4 passed". They only start passing after Task 2 Step 3 adds the `state.info.sourceText` fallback.

This also makes the sentence in Task 2 Step 2 wrong:

> The other tests in the block pass, because `tokensFor` goes through the two-argument form.

It does not. And it makes Task 2's new test ("drops a synthesized token even when no current text is passed") an exact duplicate of the first Task 1 test — same source, same assertion, same code path.

Three ways out. My recommendation is the first:

1. **Merge the two tasks into one.** The split was justified by "Task 1 is the behavior fix and can ship alone", but the tests cannot demonstrate Task 1 alone, and the source-text fallback is three lines. One task, one commit.
2. Keep the split, and have Task 1's tests pass the source explicitly: `decodeTokens(getSemanticTokens(stateFor(src), src).data, src)`. Then Task 2's test stays meaningful as the no-text case.
3. Change `tokensFor` to pass the source. This quietly changes what every existing test in the file exercises, so I would not.

## Finding 2 (blocking): the guard drops far more than the three cases the plan lists

The plan names `isSuccess`, `isFailure` and the object-rest helper, and says future synthesized names are covered "without a per-site audit". That is the right design, but the plan reads as though this is a three-case fix. Measured over the corpus, 382 of 5650 tokens are dropped, and the largest source is not on the plan's list:

| Synthesized name | Tokens dropped | Where it comes from |
|---|---|---|
| `_guard` | 157 | the `guard` keyword construct |
| `isFailure` | 87 | `is failure(...)` lowering |
| `isSuccess` | 71 | `is success(...)` lowering |
| `map` / `filter` / `_pairsOf` | 40 | list-comprehension lowering |
| `__objectRest` | 8 | object-rest patterns |
| `matchInit$N` | 4 | match lowering |
| `__requireLength` | 4 | array-length patterns |

`_guard` is the single biggest case and is visible in almost every agent in `stdlib/agents/`: the source says `guard(`, the synthesized name is `_guard` (six characters against five), so the token paints the opening paren. `stdlib/agents/coding.agency:128` is a live example.

The comprehension case is the most visually wrong of all, because the synthesized `map` call is hung on the loc of the whole comprehension. In `tests/agency/comprehensions/basic.agency:17`, `const doubled = [double(x) for x in xs]`, the emitted token paints `[do` — the opening bracket and two letters.

Please fold these into the plan's bug table, and add a `guard(...)` case and a comprehension case to the tests. They are separate lowerings from pattern lowering, so a test that only covers `is failure` does not pin them.

## Finding 3 (should fix): the guard also drops tokens for genuine calls, and the plan does not say so

Not every dropped token is synthetic. Some are real user-written calls whose `loc.col` points at a keyword rather than at the callee. `async` is the clearest:

```
tests/agency/substeps/async-in-if.agency:8   const a = async double(x)
```

The slot's name is `double` (six characters) but its column is the column of `async`, so the token currently paints `async ` — the keyword and the following space. After the guard, that token is dropped and `double` gets no semantic token at all.

There is a second family: match statements whose scrutinee is an `is` pattern, such as `match (r is success(v))` (`tests/agency/pattern-matching/resultPatternMatchIs.agency:11`), where a lowered `failure` call is anchored on the `match` keyword.

Dropping is still the right outcome — a wrong color on a keyword is worse than no color on a call the TextMate grammar already colors. But two things follow:

- The plan should say plainly that the guard hides an underlying position bug for `async` calls rather than fixing it, and a follow-up issue should be filed for the `async` loc. Otherwise the next person to look at `async foo()` highlighting has no trail.
- That case belongs in the existing `getSemanticTokens known gaps` describe block as a tripwire test, alongside the `valueAccess` one. Written the same way: when someone fixes the `async` loc, the test fails and tells them to delete it.

## Finding 4 (minor): the comparison has no word boundary

`line.slice(col, col + name.length) === name` accepts a match that is a prefix of a longer word. Against a stale buffer where the user has just typed `foo` into `foobar`, a token named `foo` still passes the guard and paints the first three characters of `foobar`. That is precisely the failure the guard exists to prevent, just rarer.

One extra condition covers it — the character at `col + length` (and at `col - 1`) must not be an identifier character. Cheap, and it makes the function's name honest: right now `paintsItsOwnName` returns true in a case where it demonstrably does not.

## Finding 5 (minor): the doc comment on `paintsItsOwnName` is too long

Step 5's replacement comment is 25 lines for a five-line function, and roughly half of it is history that is not needed to use or change the function. `docs/dev/anti-patterns.md` calls out narrating comments; a comment that argues at this length invites the next reader to skip it. The two facts worth keeping are: which two failures answer no (stale positions, synthesized names), and why dropping beats clamping. Three or four sentences.

The same applies, more mildly, to the four-sentence comments inside the tests.

## Finding 6 (minor): the manual verification step should cover the biggest case

Step 2 of "Manual verification" checks `stdlib/safeBash.agency:398`, an `is failure` case. Add the `guard(` case, since it is 40% of the change by volume and it is in almost every stdlib agent: open `stdlib/agents/coding.agency:128` and confirm the `(` after `guard` is no longer painted in the function color.

---

## What I did not check

- I did not run the LSP end to end in an editor, so the "Inspect Editor Tokens and Scopes" claim in the manual verification section is unverified.
- My corpus scan covered `stdlib/` and `tests/agency/`. Files that fail to parse were skipped silently, so the counts are a lower bound.
- I did not check code inside template literals (`[| ... |]`) or splices. `lib/utils/identifierSlots.ts` says positions are in the user's file whichever parse mode ran, so I expect the guard behaves there, but I have no measurement.

## Suggested order after the revisions

1. One task, not two: `Token.name`, the guard, the `sourceText` fallback, all in one commit.
2. Tests: `is failure` / `is success` binder overrun, `guard(`, a comprehension, object-rest, plus the "real calls still colored" control.
3. A tripwire test for the `async` call loc in the known-gaps block, and an issue filed for the loc itself.
