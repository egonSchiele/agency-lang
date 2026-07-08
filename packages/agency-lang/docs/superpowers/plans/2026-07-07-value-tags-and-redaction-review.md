# Review: Value Tags & Statelog Redaction Implementation Plan

**Plan:** `docs/superpowers/plans/2026-07-07-value-tags-and-redaction.md`
**Spec:** `docs/superpowers/specs/2026-07-07-value-tags-and-redaction-design.md`
**Reviewer:** Claude (Opus 4.8)
**Date:** 2026-07-07

## Verdict

Strong plan. It is TDD-structured, self-contained, and — importantly — its
code-level claims are accurate. I verified every infrastructure touchpoint
against the current code and all of them hold:

- `GlobalStore` API (`get`/`set`/`INTERNAL_MODULE = "__internal"`/`clone`/
  `toJSON`/`fromJSON`) matches `lib/runtime/state/globalStore.ts`. `__tokenStats`
  under `__internal` is a real precedent for the `__valueTags` Map.
- `MapReviver` serializes as `Array.from(value.entries())` and revives via
  `new Map(entries)`, so primitive **key types survive** the round-trip
  (`1` vs `"1"` stay distinct). The plan's claim is correct.
- `fromJSON` constructs a **fresh** `GlobalStore`, so a new `objectTags` WeakMap
  field is empty after clone/restore — exactly the branch-local behavior the
  plan wants, for free.
- `__globals()` returns `GlobalStore | undefined` (`lib/runtime/asyncContext.ts`).
- `runInTestContext(ctx, stack, threads, fn)` seeds the ALS `globals` slot from
  `ctx.globals`; `createExecutionContext` returns a `RuntimeContext` carrying
  `.globals` / `.stateStack` / `.statelogClient`. The Task 3/4 test harness usage
  is valid.
- The `post()` body the plan patches (Task 4, Step 3) is a **verbatim** match of
  `lib/statelogClient.ts` (~line 1164, not 1165–1173 — trivial). The exact-string
  edit will apply.
- `agency-lang/stdlib-lib/tag.js` is the established stdlib TS-import convention;
  `./stdlib-lib/*` → `./dist/lib/stdlib/*` is a real export map entry. Default
  params (`val: any = true`) are supported (`stdlib/fs.agency`). `std::` modules
  resolve **by file** (`importPaths.ts`), so "drop `stdlib/tag.agency` + `make`"
  is sufficient — there is no manifest/allowlist to update.

So the plumbing is right. The issues below are about **correctness of the walker**
and **coverage of the headline durability claim** — not about wrong file paths or
APIs.

---

## Must-fix

### 1. The `redactForStatelog` walker corrupts non-plain objects (Date, Error, Map, URL, class instances)

**Severity: high (silent data corruption in telemetry).**

The walker (Task 2) treats *every* `typeof value === "object"` as a plain record
and deep-copies it via `Object.entries`:

```ts
if (value !== null && typeof value === "object") {
  ...
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walk(v, globals, seen);
  }
  return out;
}
```

Today `post()` does a plain `JSON.stringify(body)` with **no replacer**. So a
`Date` in an event body currently serializes via `Date.prototype.toJSON()` to an
ISO string. After the walker runs first, `Object.entries(someDate)` is `[]`, so
the Date becomes `{}` *before* `JSON.stringify` ever sees it — the timestamp is
lost. The same flattening hits anything whose data lives in non-enumerable form
or behind a custom `toJSON`: `Error`, `Map`, `Set`, `URL`, and ordinary class
instances. These are exactly the types the codebase has revivers for because
they show up in serialized runtime state.

This is not hypothetical for `toolCall` output/args and `error` events: tool
return values are arbitrary user data and routinely contain `Date`s or class
instances. The result is a regression that only shows up in logs, so it will be
easy to miss.

**Fix:** in `walk`, recurse only into arrays and *plain* objects
(`Object.getPrototypeOf(v) === Object.prototype || === null`). For any other
object, redact-if-tagged, otherwise return it **unchanged by reference** and let
`JSON.stringify` serialize it exactly as it does today.

**Add a test:** a body containing `{ when: new Date("2026-01-01") }` still
serializes to the ISO string after redaction (and an untagged `Error`/class
instance is not flattened).

---

## Should-fix

### 2. Redaction deep-copies every statelog event unconditionally, even with zero tags

**Severity: medium (hot-path allocation regressing the common case).**

`redactForStatelog` short-circuits only when `globals` is `undefined`. In the
normal case `globals` exists but nothing is tagged — yet the walker still
allocates a full deep copy of **every** event body on **every** `post()`. That is
~40 event types firing continuously, including `promptCompletion` events with
large message arrays and base64 image attachments. For programs that never call
`redact`/`tag` (the overwhelming majority), this is pure overhead added to the
telemetry hot path.

**Fix:** add a cheap "any tags at all?" gate. WeakMap size isn't observable, so
track object-tag presence with a boolean/counter on `GlobalStore` (set in
`setTag` for the ref branch) and check the primitive `Map`'s `size`. Expose e.g.
`GlobalStore.hasAnyTags(): boolean`, and have `redactForStatelog` return `body`
unchanged when it's false. This keeps the zero-config, tag-free path at
today's cost.

### 3. No end-to-end test of the headline claim: redaction surviving `fork`/interrupt

**Severity: medium (coverage gap on a stated Goal).**

The spec's Goals lead with *"Make redaction of primitive secrets fully robust —
including across fork/parallel/race branches and interrupt/resume,"* and its
Testing section explicitly calls for: redaction surviving a fork and an
interrupt/resume for a primitive; `shared: true` propagation; and pinning the
object-tags-are-branch-local limitation with a test.

The plan proves the *store* clones the Map (Task 1 unit tests) but explicitly
defers the *compiled* fork/interrupt redaction fixture and does not test
`shared: true`. The unit test does not prove that `__globals()` inside a
**branch's** `post()` actually sees the inherited tag and emits `[REDACTED]` —
which is the whole selling point. That gap is exactly where a wiring bug (e.g.
the branch's cloned globals not being the one `post()` reads) would hide.

**Recommendation:** promote at least one execution test out of "deferred":
a program that `fork`s, sets or inherits a `redact` tag on a primitive in the
branch, and asserts `[REDACTED]` appears in the branch's statelog output. That
pins the durable path end-to-end. The object-tags-don't-survive-fork assertion
(spec's explicit ask) is cheap to add alongside it and locks the documented
limitation.

---

## Minor / confirm

### 4. Events posted outside an ALS frame are silently not redacted (document it)

`post()` reads `__globals()`; when an event is emitted outside a branch ALS
frame (some bootstrap/flush paths), `__globals()` is `undefined` and redaction
is a no-op passthrough. This is fail-open and fine for the API-key-in-a-node
case, but it means redaction is not an airtight secrecy guarantee. The spec
already says redaction is a statelog concern and not general secrecy — good — but
the plan/guide should state this ALS-frame boundary explicitly so nobody assumes
otherwise. (This dovetails with the spec's existing "not a secrecy guarantee"
framing.)

### 5. Verify the doc-comment parser tolerates a nested ```` ``` ```` fence

The `tag.agency` `/** @module ... */` docstring (Task 5) embeds a fenced
```` ```ts ```` code block *inside* the block comment. The block comment itself
terminates on `*/`, so this should be inert to the parser — but confirm that
`agency doc` (Task 6, Step 2) extracts and renders the nested fence correctly
rather than truncating the module doc at the inner fence. A 30-second check when
you run `agency doc`; flagging so it isn't a surprise.

### 6. Nits (no action needed)

- Task 4 cites `post()` at "line 1165–1173"; it's ~1164. The exact-string match
  makes the line number irrelevant.
- Test counts ("6 tests", "7 tests") match the `it(...)` blocks as written.
- The spec's "optional low-entropy dev-mode warning" is correctly left in
  deferred follow-ups — not a gap.

---

## Summary

| # | Issue | Severity | Action |
|---|-------|----------|--------|
| 1 | Walker flattens Date/Error/Map/URL/class instances via `Object.entries` | High | Guard to plain-objects-and-arrays; pass others through by ref; add Date test |
| 2 | Unconditional deep-copy of every event even with no tags | Medium | Add `hasAnyTags()` fast-path on `GlobalStore` |
| 3 | No e2e test of redaction surviving fork/interrupt (a stated Goal) | Medium | Promote a fork-redaction execution test out of "deferred" |
| 4 | Events outside an ALS frame aren't redacted | Low | Document the fail-open boundary |
| 5 | Nested code fence in `@module` docstring | Low | Confirm `agency doc` renders it |

Items 1 and 3 are the ones I would not ship without: 1 is a latent correctness
bug the tests as written won't catch (they only use plain objects/primitives),
and 3 leaves the feature's headline guarantee unverified end-to-end.

---

## Appendix: check against `docs/dev/anti-patterns.md`

**Headline question — does the plan write declarative interfaces that encapsulate
complexity, keeping imperative code in a few places?** *At the architecture level,
yes — this is a strength.* The plan is a good example of the principle, not a
violation:

- `std::tag` exposes `tag` / `getTags` / `redact` — users write the *what*
  (`redact(apiKey)`); the *how* (two side stores, value-vs-reference keying, ALS
  access) is hidden.
- `GlobalStore.setTag` / `getTagsFor` encapsulate the primitive-Map-vs-object-
  WeakMap dispatch behind two methods; no caller sees the split.
- Redaction is applied at the **single `post()` chokepoint** instead of imperative
  scrubbing at ~40 event call sites — the textbook "encapsulate the *how* in one
  place" move.
- `_getTags` returns a **copy** (`{ ...t }`), with a test, so the live store
  object never leaks to callers.

The imperative internals (the `walk` loop, get-or-create) are fine *because* they
sit behind those interfaces — the anti-pattern is imperative code *leaking
everywhere*, which this avoids.

**Not flagged (checked, but they match house style / aren't enforced):**

- One-line guard returns (`if (!globals) return value;`). The doc lists
  "one-line if statements," but `eslint lib/` (the `lint:structure` target) does
  not enforce it and runtime code uses this guard form pervasively
  (`if (!thread) return [];` etc.). Flagging it would be over-reading the doc.
- Single-char temporaries (`m`, `t`, `g`) in tight scopes — the codebase uses the
  same (`k`, `n`, `p`, `m`). Not worth a change.
- No nested ternaries, dynamic requires, unlogged catch blocks, magic numbers,
  nested type defs, or order-dependent mutable state in the plan's code.

**Genuine anti-pattern findings:**

### AP-1. Duplicating existing traversal — the walker should be a `JSON.stringify` replacer (ties to Must-fix #1)

`redactForStatelog`'s hand-rolled `walk()` re-implements deep value traversal that
the codebase **already owns**: `nativeTypeReplacer`
(`lib/runtime/revivers/index.ts`), the replacer behind `GlobalStore.toJSON`,
already walks values and correctly handles `Date`/`URL`/`Map`/`Set`/`Error`/
`RegExp` — including recovering the *raw* pre-`toJSON` value via `this[key]`,
which is exactly what value-identity redaction needs.

This is the "Duplicating existing code" anti-pattern with real consequences: the
parallel walker is *why* Must-fix #1 exists (it flattens Dates to `{}`). Since
`post()` is about to `JSON.stringify(body)` anyway, redaction is more naturally a
**stringify replacer**:

```ts
// one traversal, inside stringify, so toJSON/Date semantics are preserved
const postBody = JSON.stringify({ ...envelope, data: { ...body, timestamp } },
  redactReplacer(globals));
```

A replacer that reads the raw value via `this[key]`, returns `"[REDACTED]"` when
`getTagsFor(raw)?.redact === true`, and otherwise returns `value` unchanged: (a)
removes the separate deep-copy pass entirely — fixing the unconditional-copy perf
finding (#2) as well, since a no-tag program pays only a per-key function call, not
a full body clone; (b) preserves `Date`→ISO and other `toJSON` output for free —
fixing #1; (c) is strictly less code. (Cycles: `JSON.stringify` throws on cycles
regardless, so the walker's `seen`-map cycle handling doesn't actually protect the
emitted log — the downstream stringify would already throw. One more reason the
separate pass earns its keep only if it were doing something stringify can't.)

### AP-2. Leaky abstraction — the meaning of "redacted" is a magic string spread across files

The representation of redaction — the tag key `"redact"` with value `true` — is
duplicated in `tag.ts` (`_redact` writes it), `redactForStatelog.ts` (reads
`tags["redact"] === true`), and the docs. No single owner defines "what redacted
means," so the walker is coupled to the tag's internal shape. The output string is
nicely constified (`const REDACTED`), but the *key* is not. Encapsulate it: a
shared `const REDACT_TAG = "redact"`, or better a `GlobalStore.isRedacted(value):
boolean` predicate the walker/replacer calls, so redaction semantics live in one
place.

### AP-3. Minor duplication inside `setTag`

The get-or-create-then-assign block is written twice (object-WeakMap branch and
primitive-Map branch). A small `upsertTag(store, value, key, val)` helper — or
resolving to the target store first, then a single upsert — removes the
repetition. Low priority.

**Net:** the plan gets the *interface* design right (declarative surface, single
chokepoint, hidden two-store split). The anti-pattern worth acting on is AP-1 — and
it's the same fix as Must-fix #1 and Should-fix #2, so reworking the walker into a
replacer resolves all three at once.

---

## Appendix: test-plan review

Three questions: do the tests test what they claim, will they fail if the code
breaks, and what's missing?

### What's genuinely well-tested (would fail if broken)

- **Task 1 is the strongest part of the plan.** The discriminating tests are
  exactly the right ones: `1` vs `"1"` staying distinct *directly* guards the
  Map-not-plain-object decision (a plain-object impl coerces both to `"1"` and
  the test fails); "clone keeps primitive, drops object" pins the whole durability
  model; "merges multiple tags" guards against whole-record overwrite. These are
  not happy-path rubber stamps — each one fails loudly if its specific behavior
  regresses.
- **Task 3** correctly exercises the layer Task 1 doesn't: the `__globals()` ALS
  wiring, the `{ ...t }` copy (mutating the returned object doesn't dirty the
  store), and the outside-a-frame no-op. Real guards.
- **Task 4** is a proper end-to-end integration test of the primitive→`post()`
  path: it asserts both presence of `[REDACTED]` *and* absence of the raw secret,
  through the real `stdout` sink. It would fail if redaction weren't wired. I
  traced the wiring — `runInTestContext` seeds ALS `globals` from `execCtx.globals`,
  the test tags that same object, and `post()` reads it via `__globals()`, so the
  test genuinely exercises the seam it claims to.

### Where a broken implementation would still pass (the real problem)

1. **The Date/Map/Error corruption bug (Must-fix #1) is invisible to every test.**
   Every walker input in Task 2 is a plain object, array, string, or number.
   Nothing feeds the walker a `Date`, `Error`, `Map`, `URL`, or class instance —
   the exact values `Object.entries` flattens to `{}`. So the code can corrupt
   native types in the log and **the suite stays green.** This is the classic
   "tests confirm what the code does, not what it should do" trap, and it's why
   the bug is latent. Required additions:
   - `redactForStatelog({ when: new Date("2026-01-01T00:00:00Z") }, gs)` still
     yields the ISO string (fails today).
   - an untagged `Error` / `Map` in the body survives intact.

2. **The headline durability claim (fork/parallel/race + interrupt/resume) has no
   end-to-end test.** Task 1 proves the *store* clones its Map, but nothing proves
   that `__globals()` inside a **real forked branch's** `post()` sees the inherited
   tag and emits `[REDACTED]`. A regression in branch-ALS globals wiring — the most
   likely place for this feature to break — ships green. This is the biggest
   coverage gap relative to a stated Goal. Add at least one test that forks, tags a
   primitive in/for the branch, and asserts `[REDACTED]` in the branch's statelog.
   The spec also explicitly asks to pin the *opposite* for objects (tag does **not**
   survive fork) and `shared: true` propagation — both untested.

3. **`redact` has no compiled execution test.** Task 5 proves the module compiles
   and value-keying works, but tags `"color"`, never `redact`. The flagship
   feature's only redaction coverage is a TS-level unit test; nothing drives
   `redact(x)` → `[REDACTED]` through compile → run → statelog. The spec's Testing
   section asks for exactly this ("redact on a string → event shows [REDACTED] in
   the emitted JSON"). Add a `tests/agency/` program with a logFile/stdout sink.

4. **The deliberate v1 boundary — substring NOT redacted — is unpinned.** The spec
   wants this locked by a test so a future change can't silently cross it:
   `redactForStatelog({ url: "https://api.com?key=" + tagged }, gs)` leaves the URL
   untouched. Missing.

### Smaller discrimination gaps

- **`redact: false` vs absent.** "does not redact tags without redact:true" uses a
  `color` tag, so it wouldn't catch a check written as `"redact" in tags` instead
  of `=== true`. Add an explicit `redact: false` → not redacted.
- **Boolean/null primitive keys.** Only `1`/`"1"` distinctness is tested. `true`
  vs `"true"` vs `1` (the low-entropy keys the spec calls out) aren't. A key-
  stringifying regression would slip through for booleans.
- **`getTagsFor` purity.** The impl comment claims a pure lookup "never mutates
  state" (reads without creating the Map). No test pins it — if a refactor made
  `getTagsFor` call `valueTagMap()` (which creates), every read would dirty the
  store and clones would carry an empty Map. Cheap test: `getTagsFor("x")` on a
  fresh store, then assert `toJSON().store` has no `__valueTags` key.
- **Top-level tagged primitive** (`redactForStatelog("secret", gs)` → `[REDACTED]`)
  and **object-node redaction end-to-end** (only primitive is integration-tested).
  Low priority.

### Verdict on the test plan

Unit-level tests are strong and discriminating. The gaps are all at the
**integration/behavioral edge**, and two of them are serious: the walker's native-
type handling is untested (hiding a real bug), and the feature's headline
durability guarantee is only proven at the store level, never end-to-end through a
fork. Both are cases where the code breaks and nothing turns red — the exact
failure mode this review is meant to catch. Fixing the walker per AP-1 (make it a
stringify replacer) also makes the native-type test trivial to write and pass.
