# Design: `saveDraft` — salvage partial work when a guard trips

**Date:** 2026-07-14
**Status:** ✅ Design agreed in brainstorm; ready for implementation planning.
**Branch:** `worktree-save-draft-guards`

## Problem

Agency `guard(cost:, time:)` blocks cap a section of work. When the block
exceeds its budget the guard **trips**: the block never reaches its `return`, and
`guard(...) as { ... }` yields a `failure(GuardFailureData)`. **All partial work
is lost.**

The motivating use case: tell an agent *"do this research, but don't spend more
than five minutes,"* and when the clock runs out, have it **return its best
answer so far** instead of throwing everything away.

Guards are binary today — like a non-anytime algorithm, they produce nothing
useful unless they run to completion. We want an *anytime* floor: a value that is
always returnable, improving as the block runs, and handed back on a trip.

## Prior art / context

- **Anytime algorithms** (Dean & Boddy; Zilberstein): maintain a current-best
  result that is always returnable; on interrupt, return it. The core discipline
  — keep the salvageable result *outside* the interrupted step — drives the
  storage decision below.
- **The soft-trip guards brainstorm**
  (`docs/superpowers/specs/2026-07-14-soft-trip-guards-design.md`): proposed an
  `onSoftTrip(data): T` handler that synthesizes a salvage value via `llm()`.
  This design supersedes the handler as the *first* increment — `saveDraft` is
  the smaller, load-bearing primitive underneath it. The handler becomes a later
  `finalize` block (see [Future work](#future-work)).

## Scope

This is the first slice of a larger idea (*"a piece of code can be interrupted
at any point and still return some answer"*). We deliberately ship only the
smallest useful primitive:

**In scope (v1):**
- A `saveDraft(v)` function that records a best-so-far value on the current
  frame.
- On a **guard trip**, the guard returns the last saved draft instead of a
  failure.

**Explicitly deferred** (each has a home in the model below, not a
contradiction):
- `finalize { }` blocks (the salvage/cleanup hook that can synthesize or combine
  values on abort).
- **Deep / cross-type salvage** (returning a nested callee's draft through an
  outer guard) — requires `finalize` to be type-sound (see
  [Why we don't auto-salvage deep](#why-we-dont-auto-salvage-deep)).
- **Fork-array salvage** (a `fork` under a guard returning the array of its
  branches' drafts).
- `sigint()` / `sigkill()` (functions and tools to trigger interrupt/kill).
- **`saveDraft` as an LLM tool** (the model checkpointing its own progress).
- Generalizing beyond guard trips to other abort sources (Esc, `cancel()`,
  race-loss, lost connection).
- A `Both` result variant (partial-success-plus-failure) for making a salvaged
  draft distinguishable from a normal completion.

## Core model

### Drafts are per-frame and per-type

`saveDraft(v)` sets **the current frame's** draft. Because a draft written inside
`verify()` is a value of `verify`'s return type, and a draft written inside
`code()` is a value of `code`'s return type, a draft is only meaningful *at its
own frame's type*.

```
def main() {
  guard(time: 5m) as {
    return code()
  }
}

def code() {
  saveDraft(10)          // draft for code's frame (code's return type)
  const x = verify()     // trip fires inside verify()
  return x + 20
}

def verify() {
  saveDraft(1)           // draft for verify's frame (verify's return type)
  // ... trip fires here ...
  saveDraft(2)
  return 3
}
```

### v1 rule: outermost-set draft under the guard wins

On a trip, as the stack unwinds outward, the **shallowest frame that called
`saveDraft`** provides the value. In the example the guard returns **`10`**
(`code`'s draft). `verify`'s `1` is *not* returned in v1.

### Why we don't auto-salvage deep

The reason is **type safety**, and it is the thing that turns "there's no simple
rule" into a principled one:

- The guard block is `return code()`, so the guard must yield **`code`'s type**.
- `verify`'s draft is a value of **`verify`'s type**. Returning it through the
  guard is a type error in the general case (it only *looks* fine in the example
  because both happen to be numbers).
- The only sound way to lift `verify`'s draft into `code`'s type is a
  user-written conversion at the `code` layer. **That conversion is exactly what
  `finalize` is.** So "salvage as much as possible" is a real goal, but it is
  only *sound* once each layer can convert its inner salvage to its own type —
  which is why deep salvage is deferred behind `finalize`, not shipped as an
  automatic best-effort in v1.

So v1 returns the outermost draft (type-closest to the block), and the type
checker guarantees each draft is well-typed **for its own frame**. In the common
pattern — a guard wrapping a single agent call, and that agent calling
`saveDraft` — the outermost draft's frame type equals the block type, so it is
type-correct.

### Where `finalize` fits (future, not v1)

The same per-frame drafts compose upward once `finalize` exists. On a trip, each
frame produces a *salvage*: its `finalize`'s return if it has one, else its last
draft. A frame's salvage substitutes for its call expression in the parent (so
`const x = verify()` makes `x` = verify's salvage), letting the parent's
`finalize` read it and return *its own* type. `fork` composes the same way: each
branch salvages a `T`, and the fork's salvage is naturally the array of branch
salvages (matching the fork's `T[]` type) — so no arbitrary scalar merge rule is
ever needed. v1 lays down the per-frame drafts this future builds on.

## Design details

### Surface

`saveDraft(v)` is a **statement-form** builtin: it records `v` and execution
continues (a checkpoint, not control flow — like saving in a video game). It does
not return a value and does not alter control flow.

```
guard(time: 5m) as {
  let report = initialReport()
  saveDraft(report)                 // floor: even an immediate trip returns this
  while (moreToDo()) {
    report = refine(report)
    saveDraft(report)               // last-wins: best-so-far keeps improving
  }
  return report
}
```

Implemented as a **TypeScript helper** (see
`docs/site/guide/ts-helpers.html`), the same pattern as `_pushGuard` /
`withCostGuard`:

```ts
// reads the ALS frame the runtime installs around each Agency step
export function saveDraft(value: unknown): void {
  const { stack } = getRuntimeContext();
  stack.lastFrame().draft = { value };
}
```

`stack.lastFrame()` is the frame of the Agency function that called `saveDraft`
(a TS helper does not push its own Agency frame), so the draft lands on the
caller's frame — `code`'s or `verify`'s frame in the example.

Exposed to Agency via a stdlib module import (module TBD during
implementation — `std::thread` alongside `guard`, or `std::agency`; not
load-bearing for the design).

### Storage: a per-frame draft slot

The draft lives on the frame (`State`), as a dedicated, wrapped, serialized
field:

```ts
// lib/runtime/state/stateStack.ts — class State
draft?: { value: any };   // wrapped so "no draft" is distinct from "draft is null"
```

- Serialized in `State.toJSON` / `State.fromJSON` (so it survives
  interrupt/resume, like `locals`).
- **Branch-local for free:** each `fork` / `race` / tool-call branch runs on its
  *own* `StateStack` with its *own* frames, so a branch's draft cannot leak into
  a sibling. This is the property we must not get wrong, and storing on the frame
  gives it structurally rather than by convention.

**Never store the draft on the guard object.** `CostGuard.cloneForBranch`
returns `this` — a shared reference across branches — so a draft on the guard
would let sibling fork branches clobber each other. The frame is the correct
owner.

### Trip behavior: read the outermost draft at the guard boundary

The single site that converts a `guardTrip` to a failure is `__tryCall`'s
owned-guard branch (`lib/runtime/result.ts:211`), reached via the stdlib
`guard`'s `_runGuarded(ids, block)`. The change:

1. The guard records the **stack depth at guard entry** (an index into
   `stack.stack`) so the boundary knows which frames are "under" this guard —
   the frames at that index and above (deeper/on top).
2. When `_runGuarded`'s trip belongs to one of its `ids`, before returning the
   failure it scans `stack.stack` from the guard-entry index toward the top and
   takes the **first (shallowest) frame whose `draft` is set** — the
   outermost-set draft under the guard.
   - Draft found → return `success(draft.value)`.
   - No draft anywhere under the guard → return the failure, **exactly as
     today** (fully additive; no `saveDraft` calls ⇒ no behavior change).

This relies on the inner frames still being live on `stack.stack` at the
boundary — see [Correctness to verify](#correctness-to-verify).

### Type checking

`saveDraft(v)` type-checks `v` against the **enclosing function/node's return
type** (for a bare `guard` block, the block's expected type). This keeps every
draft well-typed for its own frame and is the same information a future
`finalize` needs. Modest checker work: resolve the current scope's expected
return type at the call site.

### Concurrency

- **Branch-locality** is structural (per-frame on per-branch stacks), as above.
- **A guarded block that forks** and sets drafts in multiple branches is *not*
  salvaged as a combined value in v1 — that is the deferred fork-array salvage,
  which needs `finalize`. In v1 such a trip returns the outermost draft on the
  *guarded* frame (e.g. a `saveDraft` in `code` before the `fork`), or the
  failure if there is none. Documented, not silently surprising.

### The three small decisions

1. **Transparent result.** A salvaged draft returns as a normal `success(draft)`
   — the caller cannot tell it was a partial-due-to-trip and does not receive the
   `GuardFailureData`. This is the honest v1 tradeoff; distinguishability is the
   future `Both`/partial-signal's job.
2. **`saveDraft` with no enclosing guard is a harmless no-op** — it sets the
   frame's draft, which simply never gets read. No error; permissive.
3. **Outermost-set-wins**, not deepest — the type-closest-to-the-block choice
   (see rationale above).

## Grounding facts (verified in code)

- Guard trip = `guardTrip` **unwind**, distinct from `RestoreSignal`. An unwind
  does **not** roll back the `StateStack` (`lib/runtime/errors.ts`,
  `lib/runtime/result.ts`).
- `guard()` desugars to `_pushGuard` → `_runGuarded(ids, block)` → `_popGuard`
  (`stdlib/thread.agency:248`). `_runGuarded` runs the block under `__tryCall`
  with `ownedGuardIds: ids`; the trip→failure conversion is
  `lib/runtime/result.ts:205–214`.
- `CostGuard.cloneForBranch` returns `this` (shared across branches);
  `TimeGuard` returns `undefined` (`lib/runtime/guard.ts`). ⇒ the draft must not
  live on the guard.
- Each branch has its own `StateStack`; `State.toJSON` serializes frame `locals`
  and `branches`; `StateStack.other` is branch-local and serialized
  (`lib/runtime/state/stateStack.ts`).
- The generated function catch rung **re-throws `AgencyAbort` untouched and does
  not pop the frame** (`functionCatchFailure.mustache`) — the basis for reading
  live inner frames at the guard boundary.
- TS helpers read `getRuntimeContext().stack` / the ALS frame
  (`docs/site/guide/ts-helpers.md`).

## Correctness to verify (do this first in implementation)

**#1 — Are inner frames live on `stack.stack` at the guard boundary?** The design
reads per-frame drafts at `_runGuarded`. The function catch re-throws aborts
without popping (evidence above), so they *should* be live. **Confirm
empirically** with a test: guard trip deep in a call chain
(`main → code → verify`), assert the boundary reads `code`'s draft (`10`).

- **Fallback if frames are *not* live at the boundary:** persist drafts in
  branch-local `StateStack.other.drafts` as `{ depth, value }` records keyed to a
  monotonic per-`State` frame id (so a popped frame's stale entry can't collide
  with a reused depth), cleared on normal frame return. Same observable
  semantics; different storage. Choose this only if #1 fails.

**#2 — Interrupt/resume across a saved draft.** A guarded block that saves a
draft, interrupts (e.g. user input), and resumes must still have the draft on the
restored frame. Covered by serializing `State.draft`; add a test.

## Test plan

Agency execution tests (no LLM calls needed):

1. **Basic salvage:** guard trips after `saveDraft(x)` in the guarded block →
   guard returns `success(x)`.
2. **No draft:** guard trips with no `saveDraft` → `failure`, unchanged
   (regression guard on additivity).
3. **Last-wins:** multiple `saveDraft` calls → the last value is returned.
4. **Outermost-wins across frames:** `main → code(saveDraft 10) → verify(saveDraft
   1)`, trip inside `verify` → returns `10` (the crux of #1 above).
5. **Branch-locality:** a `fork` where each branch calls `saveDraft` with its own
   value → no cross-branch clobber (assert each branch's frame draft is its own).
6. **Interrupt/resume:** draft survives an interrupt/resume cycle inside the
   guarded block.
7. **Cost and time guards both:** salvage works for a cost trip and a time trip.

## Next steps

1. Implementation planning (writing-plans skill) from this spec.
2. Resolve Correctness item #1 before building the read path.
3. Land `saveDraft` + storage + trip-read + type check + tests.
4. Follow-ups (separate specs): `finalize` blocks, then deep/fork salvage, then
   `sigint`/`sigkill` and tool exposure.
