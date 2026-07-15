# Design: `saveDraft` — salvage partial work when a guard trips

**Date:** 2026-07-14
**Status:** ✅ Design agreed in brainstorm; external review incorporated
(storage pivoted to `StateStack.other` + clearing rule — see history below).
Ready for implementation planning.
**Branch:** `worktree-save-draft-guards`

**Review incorporated (2026-07-14):** a Fable-5 review caught that the original
per-frame storage fails because the def/block `finally` pops every frame *before*
the guard boundary runs (verified: `typescriptBuilder.ts` finally-pop +
`blockSetup.mustache`). Storage moved to branch-local `StateStack.other`, and a
**clearing rule** (clear a frame's draft on normal completion, keep on abort, plus
a boundary sweep) is now load-bearing. `#549`/`#550` facts refreshed; aliasing and
altitude caveats added.

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
- A `saveDraft(v)` function that records a best-so-far value keyed to the current
  frame (stored branch-locally on the stack — see Storage).
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

**Out of scope, worth stating:** the not-yet-merged `--max-cost` / `--max-time`
**root budgets** install a guard with **no `_runGuarded` boundary** — a root trip
exits the process (code 3), so `saveDraft` does **not** salvage a root-budget trip
in v1. Natural future hook: the budget exit reporter could print the outermost
draft before exiting.

## Why a primitive, not sugar

A fair objection: if a guard block can already mutate an enclosing `let`, then
same-frame salvage is expressible today as `let best = …; guard as { …; best = x
}`. (Whether a plain `as { }` block can mutate an outer `let` deserves a
two-minute probe during implementation — callback blocks demonstrably can, per the
`callback-forwarding-child-events` fixture.) Even if it can, `saveDraft`'s real
payoff is the part that hand-rolling *can't* express:

1. **Callee-side drafts.** A called `def` cannot reach its caller's `let`.
   `saveDraft` lets `verify()` deep in the call tree record progress that the
   guard boundary can still find.
2. **Survival across interrupt/resume**, via serialization into
   `StateStack.other` — a plain outer `let` is just as serialized, but the point
   is the primitive owns this, uniformly, for callee frames too.
3. **The typed substrate `finalize` needs.** Per-frame drafts are the foundation
   the deferred composition model builds on.

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
`withCostGuard` — it writes to branch-local stack state (see Storage):

```ts
// reads the ALS frame the runtime installs around each Agency step
export function saveDraft(value: unknown): void {
  const { stack } = getRuntimeContext();
  const depth = stack.stack.length - 1;            // the calling Agency frame's index
  (stack.other.drafts ??= {})[depth] = { value };  // wrapped; last-wins per frame
}
```

`stack.stack.length - 1` is the frame of the Agency function that called
`saveDraft` (a TS helper does not push its own Agency frame), so the draft is
attributed to the caller's frame — `code`'s or `verify`'s in the example.

Exposed to Agency via a stdlib module import (module TBD during
implementation — `std::thread` alongside `guard`, or `std::agency`; not
load-bearing for the design).

### Storage: branch-local `StateStack.other`, keyed by frame depth

**The draft cannot live on the frame object.** Frames are popped by the unwind
*before* the guard boundary runs: the generated def wraps body+catch in a `try`
whose **`finally` pops unconditionally** (`__stateStack()?.pop()`), and blocks do
the same (`blockSetup.mustache`'s `finally` runs `__bsetup.stateStack.pop()`). A
`finally` runs even when the `catch` re-throws, so as the trip unwinds,
`verify`'s, `code`'s, **and the `as { }` block's** frames are all gone from
`stack.stack` by the time `_runGuarded` converts the trip. A per-frame
`State.draft` would be unreadable — the block-frame case (a `saveDraft` directly
in the guard block) is the *first* frame to pop.

Instead, drafts live in **`StateStack.other`**, which *outlives* frame pops, as a
map keyed by the saving frame's depth:

```ts
// stack.other.drafts : Record<frameDepth, { value: any }>
```

- **Branch-local for free:** each `fork` / `race` / tool-call branch runs on its
  *own* `StateStack`, and `other` is per-stack, so a branch's drafts cannot leak
  into a sibling. This is the property we must not get wrong; `other` gives it
  structurally (the same mechanism `memoryFrames` / `llmDefaults` /
  `pendingReplyAttachments` already ride).
- **Survives interrupt/resume:** `StateStack.toJSON` deep-clones and serializes
  `other`.
- **Never on the guard object.** `CostGuard.cloneForBranch` returns `this`
  (shared across branches), and since #549 `TimeGuard.cloneForBranch` returns a
  *per-branch* clone — either way a draft on the guard is wrong (shared clobber,
  or multiplied per branch). `other` is the correct owner.

### Trip behavior: read the outermost draft, then sweep

The single site that converts a `guardTrip` to a failure is `__tryCall`'s
owned-guard branch (`lib/runtime/result.ts:205`), reached via the stdlib
`guard`'s `_runGuarded(ids, block)`. The change:

1. The guard records the **stack depth at guard entry** (an index into
   `stack.stack`) so it knows which drafts are "under" it — those keyed at
   depth ≥ entry.
2. When `_runGuarded`'s trip belongs to one of its `ids`, before returning the
   failure it reads `stack.other.drafts` at the **smallest key ≥ entry depth**
   (the shallowest = outermost-set draft under the guard):
   - Found → return `success(draft.value)`.
   - None → return the failure, **exactly as today** (fully additive; no
     `saveDraft` calls ⇒ no behavior change).
3. On **both** outcomes it then **sweeps** — deletes every `drafts` key ≥ entry
   depth — so nothing leaks into a later sibling or an outer guard.

### Clearing rule (load-bearing)

Because frames are already popped at the boundary, the reader **cannot validate
that a draft belongs to a still-live frame**. So a frame's draft must be cleared
the moment it completes *normally*, or a later trip could salvage a stale value —
which is worse than a failure:

```
guard(time: …) as {
  const a = code()   // saves a draft, returns NORMALLY
  const b = code()   // trips BEFORE its first saveDraft — must yield failure, not a's draft
}
```

A monotonic per-frame id would prevent depth-*collision* but not this: the reader
still can't tell live from dead. **Reliable clearing on normal completion is the
real invariant.** Two cheap levers, each with the signal already in scope:

- **Defs:** the generated `finally` already binds `__functionCompleted` (it gates
  `onFunctionEnd`, `typescriptBuilder.ts` ~2250). Clear this frame's `drafts` key
  next to the `pop()` **only when `__functionCompleted` is true** — on normal
  return, not on an abort unwind (an unwinding frame must *keep* its draft for the
  boundary to read).
- **Blocks** (`blockSetup.mustache`): clear the block frame's `drafts` key as the
  **last statement of the block's `try` body** — a thrown trip skips it; normal
  completion runs it. (Equivalently, gate on `runner.halted`.)
- **Guard boundary:** the sweep in Trip-behavior step 3 clears the whole region
  on the way out.

Pinned by test 8 (stale-sibling).

### Type checking

`saveDraft(v)` type-checks `v` against the **enclosing function/node's return
type** (for a bare `guard` block, the block's expected type). This keeps every
draft well-typed for its own frame and is the same information a future
`finalize` needs. Modest checker work: resolve the current scope's expected
return type at the call site.

**Escape hatch (deliberate v1 line item):** this is a **name-keyed** special case
— the checker recognizes the `saveDraft` call by name. Aliasing or partial
application (`const s = saveDraft; s(v)`, passing `saveDraft` as a first-class
value) **escapes the check silently** — `v` goes unverified, and it is *not* an
error. This is acceptable for v1 (aliasing a stdlib control primitive is rare),
but is called out explicitly because the repo has been burned by name-keyed
detection before (see the `feedback_default_invoke` lesson). Revisit if `finalize`
makes drafts common enough that aliasing shows up.

### Concurrency

- **Branch-locality** is structural: each branch has its own `StateStack`, so its
  `other.drafts` is separate. A branch's drafts cannot leak into a sibling.
- **A guarded block that forks** and sets drafts in multiple branches is *not*
  salvaged as a combined value in v1 — each branch's drafts live on that branch's
  own `StateStack.other`, which the parent guard's boundary scan (on the parent
  stack) never sees. This lands exactly on the intended v1 fork scoping: such a
  trip returns the outermost draft on the *guarded* (parent) frame — e.g. a
  `saveDraft` in `code` before the `fork` — or the failure if there is none.
  Combining branch drafts into the fork's array is the deferred fork-array
  salvage, which needs `finalize`.

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
  (`stdlib/thread.agency`, ~L249). `_runGuarded` runs the block under `__tryCall`
  with `ownedGuardIds: ids`; the trip→failure conversion is the owned-guard
  branch of `__tryCall` (`lib/runtime/result.ts`, ~L205).
- **Frames are popped by the unwind before the boundary.** The def codegen wraps
  body+catch in a `try` whose `finally` runs `__stateStack()?.pop()`
  unconditionally (`lib/backends/typescriptBuilder.ts` ~L2241); blocks pop the
  same way in `blockSetup.mustache`'s `finally`. A `finally` runs when the `catch`
  re-throws (`functionCatchFailure.mustache` re-throws every `AgencyAbort`), so
  by the time `_runGuarded` catches, all frames under the guard are gone. **⇒
  drafts must live in `StateStack.other`, not on `State`.**
- `CostGuard.cloneForBranch` returns `this` (shared across branches). Since #549,
  `TimeGuard.cloneForBranch` returns a **per-branch clone** carrying the parent's
  guardId (`lib/runtime/guard.ts`). ⇒ either way, the draft must **not** live on
  the guard object.
- Each branch has its own `StateStack`; `StateStack.other` is branch-local and
  serialized via `toJSON` (deep-cloned) (`lib/runtime/state/stateStack.ts`).
- The generated def `finally` binds `__functionCompleted` (gates `onFunctionEnd`,
  `typescriptBuilder.ts` ~L2250) — the lever for the normal-completion clearing
  rule.
- TS helpers read `getRuntimeContext().stack` / the ALS frame
  (`docs/site/guide/ts-helpers.md`).
- **Not yet on main:** `--max-cost` / `--max-time` root budgets (the #550 branch)
  install a **root guard with no `_runGuarded` boundary**; a root trip exits the
  process (code 3) via the budget exit reporter. See Scope for the implication.

## Correctness to verify (do this first in implementation)

**#1 — Clearing correctness (the load-bearing one).** The reader cannot validate
draft liveness (frames are popped), so the design depends on frames reliably
clearing their `drafts` key on **normal** completion while **keeping** it on an
abort unwind. Confirm the `__functionCompleted` (def) and end-of-`try` (block)
levers fire exactly as intended, with the stale-sibling test (test 8) as the
gate. This replaces the earlier "are frames live at the boundary?" question —
that is now *resolved* (they are not; hence `other`-storage).

**#2 — Interrupt/resume across a saved draft.** A guarded block that saves a
draft, interrupts (e.g. user input), and resumes must still have the draft in the
restored stack. Covered by serializing `StateStack.other`; assert against the
serialized `other.drafts`, add a test.

## Test plan

Agency execution tests (no LLM calls needed):

1. **Basic salvage (draft in the guard block):** guard trips after `saveDraft(x)`
   directly in the `as { }` block → returns `success(x)`. This is the primary
   happy path under `other`-storage (it was the *broken* case under the discarded
   per-frame design — the block frame pops first).
2. **No draft:** guard trips with no `saveDraft` → `failure`, unchanged
   (regression guard on additivity).
3. **Last-wins:** multiple `saveDraft` calls in a frame → the last value is
   returned.
4. **Outermost-wins across frames:** `main → code(saveDraft 10) → verify(saveDraft
   1)`, trip inside `verify` → returns `10`.
5. **Branch-locality:** a `fork` where each branch calls `saveDraft` with its own
   value → no cross-branch clobber (each branch's `other.drafts` is its own).
6. **Interrupt/resume:** draft survives an interrupt/resume cycle inside the
   guarded block — assert against serialized `StateStack.other.drafts`.
7. **Cost and time guards both:** salvage works for a cost trip and a time trip.
8. **Stale-sibling (pins the clearing rule):** `const a = code() /*saves, returns
   normally*/; const b = code() /*trips before its saveDraft*/` inside one guard →
   returns `failure`, **not** `a`'s draft.
9. **Sequential guards don't leak:** guard A trips and salvages; guard B (same
   function, after A) trips with no `saveDraft` → `failure` (the boundary sweep).
10. **Nested guards:** inner guard trips and salvages its own draft; the outer
    guard's *later* trip must not read records from the inner's (swept) region.

## Next steps

1. Implementation planning (writing-plans skill) from this spec.
2. Build the clearing rule (Correctness #1) alongside the `other`-storage write
   and the boundary read+sweep — they are one interlocking unit; prove them
   together with the stale-sibling test (test 8) before anything else.
3. Land `saveDraft` + `other`-storage + trip read/sweep + clearing + type check +
   tests.
4. Follow-ups (separate specs): `finalize` blocks, then deep/fork salvage, then
   `sigint`/`sigkill` and tool exposure.
