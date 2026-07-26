# Guard trips should return a failure that still carries the block's value

## Status (2026-07-03)

Idea. Not yet scheduled. Came out of a discussion about whether the
cost guard's post-call check should be dropped in favor of a pre-call
gate only.

## The Problem

Today, when a guard trips, the block's return value is thrown away. On
a trip, `prompt.ts` throws a `GuardExceededError` at the enforcement
site; `_runGuarded` catches it via `__tryCall` and produces a
`Failure`. The value the block was about to return never surfaces.

The waste is sharpest on the **last** priced operation in a block. A
cost guard can never be a hard cap — you don't know a call's price
until it returns, so the pre-call gate (`prompt.ts:432`) admits any
call while `spent <= limit`, and that call can overshoot arbitrarily.
The overspend on the tripping call has therefore *already happened*
under the current model; the post-call check
(`prompt.ts:564-567`) doesn't prevent it, it only *reports* it. So in
the common case:

```ts
const result = guard(cost: $0.20) as {
  const category = llm("classify this email")   // spent = $0.15
  const reply = llm("draft a reply")            // spent = $0.30, trips
  return category
}
```

the user paid $0.30 **and** got a `Failure` with no usable value —
the worst cell in the matrix. The money is spent and irreversible; the
`category` value is legitimate (its call completed normally); discarding
it is pure waste.

### Why not just drop the post-call check?

Considered and rejected. "Check before every call only" would make the
final-call trip return `success` with the value. But that silently
breaks the contract that `success` ⟺ "stayed within budget", which
callers rely on for accounting / SLA / audit decisions. And the
final-call overshoot is **not** bounded to "a little" — a single call
can blow the budget by orders of magnitude:

```ts
guard(cost: $0.01) as { return llm("one huge expensive call") }
// pre-call gate sees $0 <= $0.01, admits it, call costs $2.00
```

Reporting that as clean success is actively misleading. So we keep the
honest failure signal **and** salvage the value — that dominates both
"drop the check" (loses the signal) and today's behavior (loses the
value).

## Proposed Behavior

**On a trip, return a `Failure` as today, but attach the block's return
value when the block ran to completion.**

- Block reaches its `return` but the guard is over budget → `Failure`
  whose error carries the completed value. `isFailure(result)` is still
  `true`; the caller can choose to read the salvaged value.
- Block is aborted mid-work (a later priced op was refused, so `return`
  was never reached) → `Failure` with **no** value, exactly as today.
  There is no legitimate value to hand back — the computation was
  truncated.

`success` continues to mean "within budget." Nothing that inspects
`isFailure` / `result.error.type` changes. The only addition is an
optional salvaged value on the failure.

### Apply to the time guard too, for consistency

The user's call, and the right one. The time guard has the identical
shape: compute time is already spent when the timer fires
(`guards.md:73`), the `timeoutFailure` is a signal, not a prevention,
and today the block's value is discarded the same way. If a timed block
runs to completion just as the timer expires, the value should be
salvageable on the failure just like the cost case. Making only cost do
this would split the two dimensions that are otherwise deliberately
symmetric (`stdlib/thread.agency:256-260`).

## Design Questions

### Where does the salvaged value live on the `Result`?

Two options:

1. **Optional `value` field on the failure branch** — `failure(error)`
   gains an optional companion value. Cleanest at the use site
   (`match(result) { failure(error, value?) => ... }`) but touches the
   `Result` pattern-match surface and codegen.
2. **`partialValue` field on `GuardFailureData`** — no change to
   `Result`; the salvaged value rides inside the existing error record
   (`stdlib/thread.agency:218-224`). Smaller blast radius, but stuffs a
   value into a type named `...FailureData` and makes it `any`-typed.

Lean toward (2) for a v1 (minimal surface, no pattern-match changes),
with (1) as the eventual ergonomic form if salvage becomes common.
Decide during design.

### How does the value survive to `_runGuarded`?

Today the post-call `enforceGuards()` throws *inside the block*, before
the block's `return` executes — so at throw time the return value isn't
assembled yet. To hand back a completed value we need the block to reach
its `return` first. Sketch:

- Replace the **post-call throw** with a **mark-over-budget flag** on the
  guard. The post-call check stops throwing; it flags the guard as
  tripped and lets execution continue.
- Convert the flag into a thrown `GuardExceededError` only at the **next
  enforcement point** — the pre-call gate before the next priced op
  (cost) or the next runner step boundary (time). If there is a next op,
  the block aborts before its `return` → failure, no value (correct:
  more work remained).
- If the block **completes** with the flag set (no further enforcement
  point fires), `_runGuarded` sees "block returned V, but guard flagged
  over budget" and produces `Failure(guardFailureData, value: V)` instead
  of `success(V)`.

This is essentially the pre-call-gate model for *enforcement*, plus a
completion check that converts a clean finish under an over-budget flag
into a value-carrying failure. Note it also subtly changes *when* a
mid-block trip fires: from "immediately after the charge" to "at the next
priced op / step boundary." That is behavior-visible (one extra
statement may run after the overshoot before the abort) and needs a test
+ a doc note. Confirm this is acceptable — it likely is, since that
statement can't make a *priced* call without hitting the gate.

### Interaction with fork / shared cost guards

Shared cost guards across fork branches (`guards.md:128`) mark-over-
budget on the shared instance; the flag must be observed by whichever
branch runs the next enforcement point, same as the throw is today. The
pre-call gate already handles "a sibling pushed us over" — the flag
model needs to preserve that (a branch seeing the flag set on entry
throws before its own next call). Worked example to add to the test
matrix.

### JS-bodied tool overshoot

Unchanged and still a known limitation (`guards.md:165`): a JS tool body
runs to completion regardless, and its cost is seen only at the next
step boundary. Under the flag model that step boundary is exactly where
the trip converts to a throw, so no regression — just note it.

## Touch Points (sketch)

- `lib/runtime/prompt.ts` — post-call site (`~564-567`): replace throw
  with mark-over-budget; keep the pre-call gate (`~424-432`) throwing.
- `lib/runtime/guard.ts` — add an `overBudget`/`tripped` flag to the
  `Guard` interface (cost and time); `enforceGuards()` throws when the
  flag is set at an enforcement point.
- `lib/runtime/runner.ts` — `shouldSkip` / step-boundary path converts a
  set time-guard flag into the `GuardExceededError("time", ...)`.
- `stdlib/thread.agency` — `_runGuarded` (`~292-295`) attaches the
  completed block value to the failure; `guard` docstring updated to
  document salvaged-value-on-failure. `GuardFailureData` gains
  `partialValue` if we take option (2).
- `lib/runtime/result.ts` (+ codegen / pattern-match) — only if we take
  option (1) for the `Result` shape.
- Docs: `docs/site/guide/guards.md` — document that a trip returns a
  failure that may carry the block's value; fix the "fires after every
  LLM call" line while here (the check fires both before and after —
  it's already described correctly at `guards.md:131` and `:179`, the
  one-line summary at `:49` is incomplete).

## Tests

- Cost: last-call overshoot, block returns → `Failure` with salvaged
  value present.
- Cost: mid-block overshoot with a later priced op → `Failure`, no value
  (aborted before return).
- Cost: single-call 200x overshoot → `Failure` with salvaged value
  (signal preserved, value salvaged).
- Time: timer fires as the block completes → `Failure` with value; timer
  fires mid-work → `Failure`, no value.
- Fork: shared cost guard tripped by sibling → the branch reaching the
  next enforcement point fails; salvage semantics on the completing
  branch.
- Nested guards: inner trip carries inner's value; outer still charged
  and independent (`guards.md:94-108`).

## Related

- `docs/site/guide/guards.md` — user-facing guard semantics.
- `docs/superpowers/specs/2026-05-05-guards-design.md` — original design.
- `docs/superpowers/plans/2026-05-23-builtin-cost-guards.md` — cost-guard
  implementation.
- `stdlib/thread.agency:218-296` — `guard` / `GuardFailureData` /
  `_runGuarded`.
