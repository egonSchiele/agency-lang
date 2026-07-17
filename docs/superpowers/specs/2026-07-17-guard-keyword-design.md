# Spec: `guard` as a language-level construct

**Status:** brainstormed with the owner 2026-07-17; all open decisions
settled. Review round 1 folded same day (findings in
`2026-07-17-guard-keyword-design-REVIEW.md`: the soundness property is
now stated rather than implied, the unhandled-interrupt warning learns
the construct, the impl-reachability mechanism is named, and the
keyword reservation is position-sensitive). Supersedes the idea doc
(`docs/superpowers/specs/2026-07-16-guard-keyword-idea.md`), which keeps
the fuller origin story and the file-pointer inventory.

**Scope decision (owner):** the construct plus static `raises` analysis
only. Typed interrupt and approve payloads stay in #555, which now has
its anchor. Tracking issue for this feature: #571.

---

## Part 1: Background

### What guard is today

`guard` is a stdlib function (`stdlib/thread.agency`, exported from
`std::thread`). The syntax

```ts
import { guard } from "std::thread"

const r = guard(cost: $0.50, time: 5m, label: "research") as {
  return research(topic)
}
```

parses as an ordinary function call. The `as { ... }` tail is the
generic block-argument mechanism: the block compiles to a lifted
closure (`__block_N`) passed as the `block` parameter. The stdlib def's
body is four lines: `_pushGuard`, `_runGuarded`, `_popGuard`, return.
Those three helpers are the real machinery (`lib/stdlib/thread.ts`),
and everything the resumable-guards work built — gate steps, the
step-boundary raise, trip keys, settle-at-exit, the join rule, the
feedback channel — hangs off them.

### The problem: guard trips are invisible to `raises`

The `raises` effect system gives static guarantees about which
interrupts a function can raise. Guard trips (`std::guard`) are
invisible to it, and the naive fix — track the raise point — collapses:
time trips raise at ANY step boundary of ANY function running under a
guard, and guards are installed dynamically by callers a callee never
sees. Tracking raise points would mark every function in every program.
That collapse is why the #560 review thread briefly settled on treating
`std::guard` as an ambient effect.

### The reversal: attribute the effect to the source

A guard CONSTRUCT lets the checker attribute the effect to its SOURCE:
the `std::guard` interrupt is raised by the guard construct. A function
that lexically contains one may raise `std::guard`; normal transitive
effect propagation through callers does the rest. Functions with no
guard anywhere beneath their call tree carry nothing.

This attribution is sound because of the registration-site eligibility
rule from #558: a handler registered inside a guard's dynamic extent
can never adjudicate that guard's trip. The property the attribution
preserves — stated precisely, because review round 1 showed the loose
version has a counterexample — is:

> A function's `raises` clause bounds the interrupts that can ESCAPE it
> to a handler that could act on them. It does not bound pass-through:
> an interrupt raised under a guard installed by a caller travels
> through un-annotated frames, and that is deliberate, because no
> handler those frames could register is eligible to see it.

Under that property, the marked chain (the construct's containing
function and its transitive callers) covers every escape. The
counterexample the loose version admits: `ctx.handlers` is
context-wide, so a handler registered in fork branch A is eligible for
sibling branch B's branch-local trip (A's captured `liveGuardIds`
cannot contain B's guard) while sitting in no caller chain of B's
construct. Re-derived under the stated property, it is not a
counterexample: both branches are lexically inside the fork's
containing function, which the analysis marks (the construct is inside
it, directly or through a marked callee) — the sibling handler is an
observer INSIDE the marked function, not an un-marked escape. The
budget-scoping rule and the effect-attribution rule are the same rule.

The hard cases all hold: time trips are attributed to the construct
regardless of where the clock catches the branch; a tool defined
outside any guard but executed by an `llm()` inside one is covered
because that `llm()` call's containing construct is in the marked
chain; fork and race clones carry the parent's guardId, and the
construct is in the parent chain.

### What the construct buys beyond `raises`

- **Aliasing-proof recognition.** A checker could pattern-match calls
  to `std::thread.guard`, but that breaks under `const g = guard`,
  partial application, and re-export. A keyword cannot be renamed away.
  Safety infrastructure should not be dodge-able — the same reason
  `handle` and `finalize` are keywords.
- **Precise result typing.** The construct is natively `Result<T>`
  instead of what the generic stdlib signature manages.
- **The anchor #555 needs.** The construct is where typed trip data and
  typed approve payloads will attach later. Not in scope here.

---

## Part 2: Decisions made in the brainstorm

All settled with the owner on 2026-07-17:

1. **Scope:** construct + static `raises` only. Typed payloads → #555.
2. **Drop the `as`.** Canonical syntax is `guard(head) { body }`.
3. **Migration is the formatter, not diagnostics.** The construct
   parser ACCEPTS an optional `as` after the head and ignores it; the
   AgencyGenerator's canonical form omits it. Running `agency fmt`
   mechanically strips every `as` from a codebase. No new diagnostic
   codes anywhere in this feature: the now-dead
   `import { guard } from "std::thread"` line falls through to the
   existing AG4010 (defined but not exported), which is a one-line
   obvious fix.
4. **Hard-require on annotated code.** A `raises`-annotated def that
   contains a guard, or transitively calls something that does, must
   list `std::guard`. Enforced by the existing `checkFunctionTypeRaises`
   pass and its existing diagnostic. Same for `raises` on function
   types. No auto-admit, no warning tier.
5. **No handler discharge for `raises` — because effect discharge does
   not exist.** All handlers up the chain fire; a handle block never
   consumes an interrupt the way try/catch consumes an exception, and
   the `raises` machinery has no subtraction. Wrapping a guard in a
   rejecting handler does not remove `std::guard` from the containing
   function's effects. One distinction, per review: the
   unhandled-interrupt WARNING (`isInsideHandler` in
   `interruptAnalysis.ts`) is a different system and DOES go quiet
   inside a handle block — the construct follows that existing warning
   behavior too (see decision 8).
6. **`withCostGuard` / `withTimeGuard` stay, unchanged.** They already
   run on the identical runtime (`stack.pushGuard(new CostGuard(...))`)
   and their trips are fully resumable. Their static invisibility is
   the existing TS-boundary posture (AG3016 family: interrupts from TS
   callees are not statically visible; the runtime is the backstop),
   not a guard-specific exception. Documented, not deprecated.
7. **No cross-version checkpoint compatibility obligations** for the
   internalized impl (owner: backwards compat not needed).
8. **The unhandled-interrupt warning learns the construct** (review
   finding 2). `checkUnhandledInterruptWarnings` keys on `functionCall`
   nodes, so without a fix a BARE `guard { }` in a node body would go
   silent while calling a def containing one warns — inverted, and
   exactly the case the resumable-guards breaking change made
   warn-worthy (an unhandled trip goes to the user). The walker gains a
   `guardBlock` case using the same existing warning code and the same
   `isInsideHandler` discharge. Consequence, owned rather than
   discovered: bare node-body guards across the corpus start warning;
   handler-wrapped ones (most fixtures, post race-proofing) stay
   silent. Warnings do not fail fixtures.
9. **Keyword reservation is position-sensitive** (review finding 4,
   resolving the decision-3 / Part-3 contradiction in decision 3's
   favor). The construct parser only commits on the full shape —
   `guard` + word boundary + `(...)` + optional `as` + `{` — and fails
   through to the ordinary grammar otherwise. So
   `import { guard } from "std::thread"` PARSES and fails at import
   resolution with the existing diagnostic (the migration story
   stands), and `const guard = 5` still parses (identifier position is
   untouched). Only the `guard(...) {` shape is claimed.

---

## Part 3: Syntax and grammar

Canonical form:

```ts
const r = guard(cost: $0.50, time: 5m, label: "research") {
  const a = llm("step 1")
  return a
}
```

- **Head:** the `guard` keyword, then a mandatory parenthesized list of
  the three named arguments — `cost:`, `time:`, `label:` — each
  optional, any order. Null and negative values keep today's meaning
  ("this limit is disabled") so callers with an optional cap can pass a
  computed value. `guard() { ... }` is legal and just runs the block.
- **Optional legacy `as`:** `guard(head) as { body }` parses
  identically; the `as` is ignored. The generator never prints it.
- **Expression position.** The construct joins the expression grammar
  (precedent: the `match` expression — the one existing block-shaped
  expression). Statement use falls out as an expression statement. This
  is the difference from `thread` / `subthread`, which are
  statement-position constructs; AG4006's "block keywords take no `as`
  because there is nothing to bind" does not apply because a guard
  binds its `Result`.
- **Word boundary** after the keyword, copied from `handleBlockParser`,
  so `guardrails(...)` stays a call.
- **`return` inside the block is block-scoped**, exactly as today: it
  produces the guard's value and does not return from the enclosing
  function. `saveDraft` and `finalize` inside the block are unchanged.
- **AST:** a new `guardBlock` node —
  `{ cost, time, label: Expression | null, body: Statement[], loc }` —
  registered in `bodySlots` (walkers and the AG6033-style nesting
  checks then see it for free). The formatter round-trips it.
- **What breaks:** only the `guard(...) {` shape is claimed (decision
  9): the import line parses and dies at resolution with the existing
  unresolved-import diagnostic, `const guard = 5` still parses, and a
  user function named `guard` only conflicts when called with a
  trailing block. Strictly less breakage than a globally reserved word.
- **Parser risk note (review):** a block-shaped primary adjacent to the
  precedence-climbing binop parser is the grammar area with known sharp
  edges (`!(...)` on paren-exprs, `.concat()` on array literals).
  Budget real time for the expression-position integration and test it
  against those neighborhoods.

---

## Part 4: Typing and effects

### Result typing

The construct types as `Result<T>`, where `T` is synthesized from the
block the way an unannotated def body is: the join of its `return`
statement types. The failure side is the existing `GuardFailureData`.
All existing flow-sensitive narrowing (`isFailure` / `isSuccess`,
`match` with `success(v)` / `failure(e)` binders, exhaustiveness) works
unchanged because the shape is the same `Result`; the construct just
stops laundering `T` through the stdlib function's generic signature.

Two rules carry over with sharper teeth:

- `saveDraft(value)` inside the block checks `value` against `T`.
- A `finalize` block's return checks against `T` (its value is the
  salvaged result).

### Effect entry and propagation

The interrupt-effects walker adds `std::guard` to the containing
function's entry in `interruptEffectsByFunction` when it encounters a
`guardBlock` node — the same way an interrupting builtin call
contributes today. The existing transitive machinery propagates it to
callers with no new code. There is no subtraction anywhere (decision 5).

### Enforcement

- An annotated `raises` clause missing `std::guard` where the analysis
  requires it fails via the existing `checkFunctionTypeRaises`
  diagnostic. Hard error (decision 4).
- Function types: passing a guard-containing function where the
  expected type's `raises` lacks `std::guard` is an error, via the
  existing #434/#511 machinery.
- The stdlib migrates its own annotated signatures in the same PR.

### The TS boundary

Guards installed from TypeScript (`agency.withCostGuard` /
`agency.withTimeGuard`) behave identically at runtime and are invisible
to the static analysis, like every TS-raised effect. One added
paragraph in the ts-helpers guide and the effects guide states this
(decision 6). If TS imports ever grow effect declarations, that feature
covers this case generically; this spec does not attempt it.

---

## Part 5: Codegen and lowering

**The construct compiles to exactly what today's syntax already
compiles to.** The stdlib `guard` def is renamed to the internal
`__guard` (still exported — see the reachability bullet below) and
becomes the construct's lowering target; the emitted call — impl
reference plus `cost` / `time` / `label` plus the block closure — keeps
the shape the old parse produced.

Why lowering to the same call is load-bearing, not laziness: the guard
function's own frame and step structure carry everything the
resumable-guards work depends on. The trip keys persisted in that
frame's `stack.other`, the settle window being "exactly one step before
`_popGuard`", the checkpoint step paths that resumes replay into, and
the `__block_N` closure naming that checkpoint revival depends on (the
#513 lazy-stub machinery) all assume guard-is-a-call-with-a-frame.
Inlining push/run/pop into the containing function would silently shift
every step path and re-open replay validation. The rule: front end
changes, emitted call does not.

Concretely:

- A preprocessor desugar pass (`lib/preprocessors/guardDesugar.ts`, the
  `parallelDesugar` precedent) rewrites the `guardBlock` node into the
  legacy `functionCall` + `blockArgument` shape before callback
  lifting, so the body goes through the EXISTING `__block_N` lifting
  and the builder never sees the construct. This implements the "same
  emitted call" invariant more directly than a hand-rolled TSIR module.
- **Impl reachability, named concretely (review finding 3):** the
  stdlib def renames `guard` → `__guard` and STAYS exported from
  `std::thread` (the prelude imports exports — de-exporting would fight
  it); `stdlib/index.agency` re-exports it into the auto-import prelude
  (the saveDraft move from #553 is the precedent, including its
  re-export-TDZ gotcha; `index.agency` is non-templated). The
  underscore prefix marks it internal; verify the doc generator skips
  underscore-prefixed exports, and if it does not, its docstring says
  "internal — use the guard construct".
- The AgencyGenerator prints the construct with the head arguments in
  their source order and no `as`, so `fmt` round-trips and `writeAST`
  stays canonical.
- Untouched: `guard.ts`, `guardScope.ts`, `guardTripInterrupt.ts`, the
  prompt gates, the runBatch join rule, all serialization formats.

**Acceptance test for this part:** the migrated guards fixture suite
passes with only `.agency` source syntax changed, and the `make
fixtures` regen shows near-zero compiled-output churn. Large churn in
that regen means the lowering drifted.

---

## Part 6: Migration, docs, and testing

### Migration

- **User code:** run `agency fmt` (strips every `as`), delete the
  `import { guard }` line when AG4010 points at it.
- **Stdlib:** every stdlib use of `guard` migrates to the construct
  (`std::agents` is the largest); annotated stdlib `raises` clauses
  gain `std::guard` where required; the stdlib def becomes the internal
  `__guard` (renamed, still exported, prelude-re-exported — Part 5).
- **Test corpus:** all fixtures using `guard` get the formatter pass
  plus import-line removal, then `make fixtures`.

### Docs

- Guards guide: syntax update (owner-owned page — the change is
  mechanical, but flagged for the owner's read).
- ts-helpers guide + effects guide: the TS-boundary paragraph
  (decision 6) and `std::guard` in the effects listing.
- The generated stdlib reference drops the `guard` entry (only exports
  are documented); its doc comment content lives on in the guide.

### Testing

- **Parser:** head-argument permutations and order freedom; empty head;
  expression vs statement position; legacy-`as` acceptance; the word-
  boundary case; formatter round-trip (`fmt` of old syntax emits
  canonical new syntax — this doubles as the migration-tool test).
- **Typechecker:** `Result<T>` inference (single return, joined mixed
  returns, nested constructs); `saveDraft` / `finalize` mismatches
  against inferred `T`; the effects battery — annotated def containing
  a guard without `std::guard` errors, the transitive-caller case, the
  function-type case, and the negative case (guard-free functions gain
  nothing).
- **Runtime:** the migrated guards suite (70+ fixtures spanning trips,
  salvage, forks, joins, checkpoints, the feedback channel) is the
  regression net. Needing a NEW runtime fixture would itself indicate
  the Part 5 invariant broke.
- **Lint and coverage gates:** structural lint; no new diagnostic codes
  means no new explanation pages.

---

## Part 7: Out of scope, recorded so they stay decisions

- Typed trip/approve payloads and checked `i.data` access — #555.
- Effect declarations for TS imports (the generic fix for the
  `withCostGuard` static blind spot).
- Guard-specific lints (nesting advice, label conventions) — the
  construct is their natural home later, but none ship here.
- Deprecating the legacy `as` acceptance. It costs one `optional()` in
  the parser; revisit only if it confuses anyone.
