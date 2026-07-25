# Tarsec: nested parsing, committed failures, and terminated scans

Status: design, awaiting review
Target: the tarsec library (agency-lang is the motivating consumer)
Date: 2026-07-24

## Background

### How we got here

Agency's code literals (`[| ... |]`, PR #673) needed something no tarsec consumer had needed before: **a full parse running inside another parse**. A literal's body is real Agency code, parsed at parse time of the enclosing file — so mid-way through parsing `main.agency`, the literal parser turns around and runs `exprParser`, `bodyParser`, or the whole program grammar on the body text.

Tarsec was never designed for that, and it showed. Getting literals to work took four workarounds, all of which now live in `packages/agency-lang/lib/parsers/parsers.ts` as imperative, comment-heavy code: a four-way global-state save/restore with a `finally`, a hand-rolled deep walker that shifts source locations after the fact, a module-level error side-channel with preference logic in two different failure paths of `parser.ts`, and an index-arithmetic scanner. The owner's review of that code was blunt and correct: it is extremely imperative, and most of it is compensating for library gaps rather than expressing grammar.

This spec describes the gaps precisely — each with the failure it caused, reproduced during development — and proposes four tarsec features that would let the consumer code collapse back into combinators. Everything here was hit for real; nothing is speculative hardening.

### What "nested parse" means, concretely

```ts
// Inside the enclosing parse of main.agency, at the point where the
// input starts with "[|":
const scanned = scanCodeLiteralBody(input.slice(2));   // find the matching |]
const parsed = exprParser(scanned.body);               // ← a parse INSIDE a parse
```

That inner `exprParser` call is an ordinary tarsec parser invocation — but it runs while the outer parse is suspended, and both parses share every piece of tarsec's module-global state.

## The issues

### Issue 1: parse state is module-global, and nested parses corrupt it

Tarsec keeps three pieces of state at module scope, all keyed to "the one parse currently running":

1. **The input string** — `setInputStr` (`trace.ts`). Every position computation (`withSpan`, `getPosition`, `recordFailure`) derives offsets as `inputStr.length - remainingInput.length`. Setting it also **resets the rightmost-failure record** (`trace.js:198` calls `resetRightmostFailure()`).
2. **The rightmost-failure record** (`rightmostFailure.ts`) — module-level `rightmostFailurePos` / `rightmostFailureExpected`.
3. **The memo caches** — `memo()` caches keyed by remaining-input string, with a documented purity caveat: *"memo assumes its wrapped parser is a pure function of its input. Don't memoize parsers that consult mutable external state"* (`combinators.d.ts`). But memoized parsers like `exprParser` produce nodes carrying `loc`s derived from `inputStr` — so cache entries are only valid for the input they were computed against. `resetMemos()`'s own doc says to call it "at the start of each top-level parse" for exactly this reason.

A nested parse violates all three at once. The failure we hit, in sequence:

- The inner parse calls `setInputStr(bodyText)`. From that moment, every position the **outer** parse computes is against the wrong string. When the outer parse later failed and tarsec formatted the error, it computed a caret column from mismatched lengths and crashed:

  ```
  RangeError: Invalid count value: -15
      at trace.js:214  —  messages.push(`${" ".repeat(index + prefix.length)}^`)
  ```

  Not a wrong message — a crash, inside error *formatting*, far from the actual mistake.
- The inner parse's `setInputStr` also wiped the outer parse's rightmost-failure record (the reset at `trace.js:198`), silently degrading outer error messages even when nothing crashed.
- Inner-parse memo entries were computed against the body string; once control returned to the outer parse, value-equal input suffixes could collide across the two parses and serve stale, wrong-`loc` results.

The consumer-side workaround, verbatim from `parsers.ts` — this is the block the spec exists to delete:

```ts
const savedInput = getInputStr();
const savedRightmost = saveRightmostFailure();
const savedPending = pendingCodeLiteralError;
const savedOffset = currentTemplateOffset;
setTemplateOffset(0);
try {
  setInputStr(trimmed);
  /* ... three nested parse attempts ... */
} finally {
  setInputStr(savedInput);
  restoreRightmostFailure(savedRightmost);
  pendingCodeLiteralError = savedPending;
  setTemplateOffset(savedOffset);
  resetMemos();   // inner-input entries are poison for the outer parse
}
```

Every consumer who ever nests a parse will have to rediscover and rewrite this block — including the ordering subtlety that `setInputStr` must come *before* `restoreRightmostFailure` (because setting the input resets the record).

### Issue 2: nested parses report positions in the wrong coordinate system

The inner parse's `withSpan`/`withLoc` positions are relative to the *body string it was handed*. For a literal opening at line 40 of the enclosing file, a node on body line 2 must report line ~43 — but the inner parse says line 2, and nothing in tarsec can be told otherwise.

The consumer-side workaround is a hand-rolled recursive walker that visits every object carrying a `loc` and adds a delta after the fact:

```ts
function shiftLiteralLocs(value: unknown, lineDelta: number, offsetDelta: number): void {
  // ...generic recursion over arrays/objects, += on line/start/end...
}
```

This is both imperative and fragile: the delta must account for the enclosing template offset *and* the whitespace trimmed off the body before parsing (get either wrong and every location in a multi-line literal maps early — a bug the plan review caught before it shipped). It is also exactly the kind of generic object-walk the anti-pattern catalog frowns at, living in a parser file because the library had no hook.

### Issue 3: `label()` scrubs deep failures, so the wrong error wins

`label` is implemented as save-run-restore (`parsers.js:251-259`):

```js
export function label(name, parser) {
  return (input) => {
    const saved = saveRightmostFailure();
    const result = parser(input);
    restoreRightmostFailure(saved);          // ← unconditionally
    if (!result.success) recordFailure(input, name);
    return result;
  };
}
```

The unconditional restore means: whatever precise, deep failure the child recorded, `label` **throws it away** and substitutes its own name at its own (shallower) position. Since Agency's grammar is labeled at nearly every level, any deep failure recorded inside a construct is scrubbed on the way out, level by level, until only the outermost label survives.

The reproduced consequence: a malformed literal body recorded a mapped, directive error at position 52 —

```
code literal body: Line 3, col 11: expected whitespace, "break", ...
```

— and the surfaced parse error was the rightmost record at position **24**, reading, in full:

```
expected node body
```

The deep record was not out-competed; it was *deleted* by the restore in every enclosing `label`. The consumer-side workaround is a dedicated module-global side-channel (`pendingCodeLiteralError`) that failures write to outside tarsec's machinery, plus preference logic in **two** places in `parser.ts` — the failure-return path of `_parseAgency` *and* the `TarsecError` catch in `parseAgency`, because some grammar paths throw rather than return failure, and both exits need the same arbitration.

Note the scope of this issue: it is not literal-specific. *Every* deep failure inside *any* labeled region in *any* tarsec grammar is being scrubbed today. Agency users see it as vague errors ("expected node body") where the parser actually knew something far more specific.

### Issue 4: no way to commit to a branch

Once the scanner has seen `[|`, the construct *is* a code literal — no other interpretation exists. But tarsec's `or()` has no way to know that: when the literal parser fails, `or()` cheerfully backtracks and lets `bracketAccessParser`, `comprehensionParser`, and `agencyArrayParser` each take a bite at `[| const = broken...`, generating their own (shallower, wronger) failure records, and eventually the statement and node-body parsers fail with generic complaints that win the message.

This is the classic problem that `cut` (Prolog) / `commit` (most parsec descendants) solves, and its absence is *why* issue 3 bit so hard: without commit, error attribution is a fight between every failed alternative, and with `label` scrubbing, the vaguest contender wins.

### Issue 5: no combinators for "scan raw text to a terminator, skipping regions"

The literal's end-scan must find `|]` in *code position* — skipping over strings (with escapes and `${...}` interpolations, nested strings included) and comments, where `|]` is inert. Tarsec has excellent parsers for exactly those regions (`_stringParser`, `commentParser`, `multiLineCommentParser`), but no way to compose "repeat these until a terminator, and hand me the raw text you consumed." The consumer-side result is an index-walking loop with a measuring helper:

```ts
function consumeWith(parser: Parser<unknown>, input: string, from: number): number {
  const result = parser(input.slice(from));
  if (!result.success) return -1;
  return from + (input.length - from - result.rest.length);   // arithmetic, not grammar
}

function scanCodeLiteralBody(input: string): ... {
  let i = 0;
  while (i < input.length) {
    if (input.startsWith(CODE_LITERAL_CLOSE, i)) { ... }
    if (input.startsWith(CODE_LITERAL_OPEN, i)) { ...error... }
    const ch = input[i];
    if (ch === '"' || ch === "'" || ch === "`") { i = ...; continue; }
    // ...comment cases...
    i += 1;
  }
}
```

The *intent* — "strings and comments are inert, `[|` is an error, `|]` ends it" — is a grammar. The implementation is a state machine.

## Proposed tarsec features

Four additions, ordered by how much consumer code each deletes. All are additive except the `label` fix, which changes error *text* (strictly for the better) — see Compatibility.

### F1: `runNested` — an isolated sub-parse, with position offsetting

```ts
export type NestedOptions = {
  /** Positions in the sub-parse's results are offset by this, so spans
   *  come out in the ENCLOSING parse's coordinates. Defaults to zero. */
  basePosition?: Position;   // { offset, line, column }
};

/** Run a complete parse of `input` with its own input string, rightmost-
 *  failure record, and memo namespace, restoring the enclosing parse's
 *  state on exit (success, failure, or throw). The one supported way to
 *  parse inside a parse. */
export function runNested<T>(
  parser: Parser<T>,
  input: string,
  opts?: NestedOptions,
): ParserResult<T>;
```

Semantics, spelled out because each clause corresponds to a bug we hit:

- **Input string**: saved, replaced with `input`, restored in a `finally`. The restore must re-establish the *outer* rightmost record after the reset that `setInputStr` performs — i.e. `runNested` owns the ordering subtlety so consumers never learn it exists.
- **Rightmost failure**: the inner parse gets a fresh record; on exit the outer record is restored exactly. (If F2/F3 land, a committed inner failure instead surfaces through the returned result — never by mutating the outer record.)
- **Memos**: inner cache entries must not serve the outer parse and vice versa. Implementation freedom: a save/clear/restore of the caches, or namespacing entries by a parse generation counter. The observable contract is isolation, both directions.
- **`basePosition`**: every `Position` the sub-parse produces (spans, failure positions, error-message line/col) is offset by it — `offset += base.offset`, `line += base.line`, and column offset applied on the first line only, the standard composition. This replaces the consumer's post-hoc loc-shifting walker *and* its error-message line-rewriting regex in one stroke, and it makes the offsetting additive by construction (the nested-inside-an-already-offset case is where the hand-rolled version nearly shipped wrong).

What Agency deletes: the entire save/restore block from issue 1, `shiftLiteralLocs`, the `strippedPrefix` line-counting, the `Line (\d+)` rewriting regex, and the `resetMemos()` call with its apology comment.

### F2: `label` stops deleting deeper knowledge

Two-line behavioral fix: on child failure, keep the child's record when it is **deeper** than the saved one; only add the label's own name when the label's position is the rightmost.

```js
export function label(name, parser) {
  return (input) => {
    const saved = saveRightmostFailure();
    const result = parser(input);
    const child = saveRightmostFailure();
    restoreRightmostFailure(child.pos > saved.pos ? child : saved);   // keep the deeper
    if (!result.success) recordFailure(input, name);                  // no-op unless rightmost
    return result;
  };
}
```

The current behavior makes `label` an information destroyer: a parser that knew "line 3, col 11: expected an expression" reports "expected node body" because six labels between the knowledge and the surface each restored over it. After this fix, the rightmost-failure machinery does what its name says — the *deepest* recorded failure survives, with labels contributing their names only where they genuinely are the frontier.

This helps every tarsec consumer's error messages, not just literals. Note `recordFailure` already dedupes and merges expectations at equal positions, so the "expected A, B, or C" aggregation behavior at the true frontier is unchanged.

### F3: `commit` — a branch that stops backtracking

```ts
/** Once `prefix` succeeds, the branch is COMMITTED: a failure of `rest`
 *  propagates as a final, non-backtrackable failure. `or()` does not try
 *  later alternatives past a committed failure, and the committed
 *  failure's message and position win error reporting outright. */
export function committed<A, B>(prefix: Parser<A>, rest: (a: A) => Parser<B>): Parser<B>;
```

(Exact shape negotiable — a `commit: Parser<null>` marker inside `seqC` would fit tarsec's style too; what matters is the semantics below.)

- A committed failure carries a marker (`{ success: false, committed: true, ... }`).
- `or()` returns a committed failure immediately instead of trying further alternatives.
- `label` and every other wrapper pass committed failures through untouched — no re-labeling, no restore games.
- `getErrorMessage()` prefers a committed failure over the rightmost record.
- `many`/`optional` treat a committed failure as a failure of the *whole* repetition, not as "zero more items."

For the literal: `committed(str("[|"), () => literalBody)` makes "malformed body" *the* parse error by construction. What Agency deletes: `pendingCodeLiteralError`, its reset/get/report helpers, and the preference branches in both of `parser.ts`'s failure exits. It also deletes the class of bug where a deliberately-thrown grammar path (`TarsecError`) bypasses the arbitration — commit semantics apply uniformly because they live in the result type, not in a side channel.

F2 and F3 overlap: F2 alone would have surfaced the literal's message in the observed case (its record was deepest). F3 is the guarantee — the right message wins even when some fallback parser stumbles *deeper* into the text than the committed failure. Ship F2 regardless (it is two lines and repairs `label`'s contract); ship F3 for constructs with an unambiguous prefix, which is most of them.

### F4: `manyTill` and `matchedText` — terminated scans as grammar

```ts
/** Repeat `chunk` until `terminator` succeeds (terminator NOT consumed).
 *  Fails if input ends before the terminator. */
export function manyTill<T>(chunk: Parser<T>, terminator: Parser<unknown>): Parser<T[]>;

/** Discard `parser`'s structured result; produce the raw consumed text. */
export function matchedText(parser: Parser<unknown>): Parser<string>;
```

The literal's end-scan becomes a grammar again:

```ts
const bodyChunk = or(
  _stringParser,                 // strings: escapes + ${} interpolations, inert
  commentParser,
  multiLineCommentParser,
  committedFailure(str("[|"),    // with F3; else a mapped failure
    "nested code literals are not supported; build the inner piece as its own value and graft it into a hole"),
  anyCharExceptSeq("|]"),
);
export const literalBodyText = matchedText(manyTill(bodyChunk, peek(str("|]"))));
```

Five declarative lines that *say* the ruling — strings and comments are inert, nesting is an error, `|]` ends it — instead of encoding it in indices. What Agency deletes: `scanCodeLiteralBody`, `consumeWith`, and the two delimiter constants' arithmetic. (`anyCharExceptSeq` is trivial sugar; if `manyTill` tries `terminator` before `chunk` each round, plain `anyChar` suffices and the sugar is unnecessary — implementer's choice, but specify the try-order either way, since it decides whether `chunk` can accidentally eat the terminator's first character.)

## What remains in agency-lang afterward

Honesty about the floor: kind inference (three `runNested` attempts, smallest-first) stays — it is policy, not plumbing, and reads fine. The `registerProgramParserForLiterals` injection stays unless we separately restructure the `parser.ts` ↔ `parsers.ts` layering; that is an agency-lang problem, not tarsec's. Rough deletion estimate for `parsers.ts` + `parser.ts`: the literal support drops from ~250 lines to well under 100, and the *comments* shrink more than the code — most of them exist to explain global-state hazards that stop existing.

## Compatibility

- **F1, F3, F4 are additive.** No existing behavior changes; consumers opt in.
- **F2 changes error text**, strictly toward specificity: messages that today name a shallow label will start naming the deepest real failure. That is the point — but consumers with tests asserting exact message text (agency-lang has several) will need a sweep. Recommendation: land it as the default rather than behind a flag; a flagged error-quality fix never gets turned on. The agency-lang sweep can ride the same upgrade PR that adopts F1.
- One interaction to pin in tarsec's own tests: `runNested` (F1) restoring the outer rightmost record must compose with F2's keep-the-deeper rule — the inner parse's depths are in a different coordinate space and must never leak into the outer record by raw position comparison. Isolation first, then monotonicity within each parse.

## Testing strategy (tarsec-side)

Each feature's tests should include the Agency repro that motivated it, reduced:

- **F1**: a parser that runs `runNested` mid-parse, then fails in the *outer* parse — the outer error message formats correctly (this is the `RangeError: Invalid count value` regression); the outer rightmost record survives an inner parse that fails deeply; memo isolation both directions (same input suffix, different parses, different `basePosition` — the cached `loc`s must not cross); `basePosition` arithmetic including the column-on-first-line rule and a nested-inside-offset case.
- **F2**: a two-level labeled grammar where the inner parser fails deep — the surfaced message names the inner expectation, not the outer label; equal-position expectations still merge into "expected A or B."
- **F3**: `or(committedBranch, fallback)` where the fallback would succeed — the committed failure wins; `many` of a committed-failing chunk fails the repetition; `label(committedFailure)` passes through unchanged.
- **F4**: terminator inside a string/comment chunk is inert; unterminated input fails naming the terminator; `matchedText` returns the exact consumed slice (escapes intact, no normalization).

## Open questions

1. **`commit`'s surface shape**: `committed(prefix, rest)` versus a zero-width `commit` marker usable inside `seqC`. The marker is more tarsec-idiomatic; the function form makes the committed region explicit. Needs a call from tarsec's owner.
2. **Should `runNested` compose template offsets automatically?** Agency layers its own `currentTemplateOffset` on top of tarsec positions. `basePosition` handles the mechanics, but the *user-coordinate* conversion (prelude offset subtraction) is agency-lang's; the spec keeps it that way. If tarsec ever grows first-class "virtual origin" support, revisit.
