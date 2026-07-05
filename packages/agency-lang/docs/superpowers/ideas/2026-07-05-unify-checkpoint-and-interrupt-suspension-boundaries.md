# Unify `checkpoint()` and interrupts around suspension boundaries

## Status (2026-07-05)

Design idea, fleshed out in discussion. Not yet scheduled. Grew out of
investigating what `checkpoint()` does when called inside a concurrent
branch (`fork` / `race` / `parallel` / the `runPrompt` tool loop). The
short version: `checkpoint()` today is unsound inside concurrent
execution, and the fix is to model it as a *soft interrupt* so it reuses
the existing concurrent-interrupt machinery. This doc captures the
governing rule, the design, the resume flows, and the risks.

## The bug that started this

`checkpoint()` captures `ctx.stateStack` ([lib/runtime/checkpoint.ts:17])
— the top-level/parent stack — not `getRuntimeContext().stack` (the
branch-local slice). Inside a fork branch these differ deliberately
([lib/runtime/runBatch.ts] docstring: *"MUST be the local slice … NOT
`ctx.stateStack`. This is the one discipline the caller must observe"*),
and capturing `ctx.stateStack` violates the **slice rule** that all
concurrent checkpoint composition depends on
([docs/dev/concurrent-interrupts.md] Invariant #1).

Because the parent frame holds every branch's live `BranchState` and
`State.toJSON` walks them, a `checkpoint()` call inside a branch today
"accidentally" serializes the **whole fork** — including sibling
branches captured at whatever arbitrary in-flight point they happen to be
at — tagged with the *calling branch's* source location but the
*parent's* stack. Location/stack mismatch, mid-flight sibling capture,
and a global-reset restore. It is not a designed or tested path.

## The governing rule: capture only at a suspension boundary

**A branch may only be captured when it is at a suspension boundary — a
point where it is not actively executing. In-flight capture is
forbidden.**

This is a soundness rule, not a preference:

1. **Nondeterminism.** A sibling captured at a random await point makes
   the checkpoint's contents depend on timing — different on every run.
2. **Impossibility (decisive).** Checkpoints serialize *Agency* stack
   frames only. A branch suspended inside a TypeScript function has
   execution state with no representation in a checkpoint. Capturing it
   would not be nondeterministic — it would be **corrupt**: a frame that
   claims to be at an Agency step boundary while actually parked inside
   opaque JS.

Interrupts already obey this rule by construction: an interrupt *is* a
boundary, and the concurrent-interrupt barrier
(`runBatch`'s `Promise.allSettled`) waits for every sibling to *settle*
before stamping the shared checkpoint. `checkpoint()` obeys neither
today.

## What counts as a boundary: why the rule must be "finish OR interrupt OR checkpoint"

When branch A wants to capture, its siblings must each reach a boundary
first. Three candidate definitions of "boundary":

1. **Finish only.** Breaks the moment a sibling interrupts: an
   interrupted sibling never "finishes" (it waits for a user response
   that can't arrive while A is blocked in `checkpoint()`). Deadlock, or
   only valid when you can guarantee no sibling ever interrupts — which
   is unpredictable. Reject.
2. **Finish or interrupt.** Correct for interrupts, but **incomplete for
   checkpoints**: if A and C both call `checkpoint()`, A waits for C to
   finish-or-interrupt and C waits for A to finish-or-interrupt — neither
   does. Deadlock.
3. **Finish or interrupt or checkpoint.** The completion of (2): a
   sibling's own `checkpoint()` call is the boundary that breaks the
   two-checkpoint deadlock. **This is the only complete rule.** It maps
   onto the existing `runBatch` barrier with `checkpoint` added as a
   third "settle" event alongside `result` and `interrupt`.

Note (3) is not "also fine" — you cannot have (2) without (3).

## The model: `checkpoint()` is a *soft* interrupt

Reimplement `checkpoint()` to participate in the interrupt machinery as a
**soft (conditional) interrupt** — NOT a hard one.

A hard interrupt always suspends and unwinds to the host. That would
break the common case: today `const id = checkpoint(); print(x)` at the
top level continues inline. A hard-interrupt `checkpoint()` would unwind,
surface `std::checkpoint` to the host, and only run `print(x)` on a
resume round-trip. Unacceptable.

The soft-interrupt semantics — exactly *"by itself doesn't interrupt, but
if another thread interrupts, it pauses too"*:

- **Always reaches the batch barrier** (a genuine boundary). Siblings
  settle at finish / interrupt / checkpoint. The barrier waiting for a
  sibling to return from a TS call into Agency at a boundary is what
  makes the "can't capture mid-TS-call" problem impossible by
  construction.
- **Pure-checkpoint batch (no real interrupt):** auto-resolve — stamp the
  one shared checkpoint, everyone continues inline, no host round-trip.
  `id` is returned and execution proceeds.
- **Mixed batch (a real interrupt present):** the whole batch surfaces to
  the host; the checkpointing branch pins at its boundary; all resume
  together via the unified resume path.

### Solo checkpoints stay inline

A `checkpoint()` with no live sibling branches (top-level, single branch)
is a single-branch batch that auto-resolves immediately with no unwind —
i.e. today's cheap inline snapshot, fixed only to capture the **local
slice** instead of `ctx.stateStack`. The soft-interrupt barrier machinery
only engages when there are live siblings. This preserves existing
top-level `checkpoint()` ergonomics.

## Why the checkpointing branch MUST pause in a mixed batch (correctness)

When A calls `checkpoint()`, C raises a real interrupt, and B has
finished: the batch contains a real interrupt, so it surfaces and A
pauses at its boundary — **even though A only checkpointed.** This is
required for correctness, not consistency:

If A were allowed to run past its checkpoint boundary (e.g. execute
`print(randomNumber)`) and the batch were later resumed from the shared
checkpoint, resume would re-enter A at its boundary and run `print`
**again** — double execution of A's tail. So the instant the checkpoint
becomes a live resume point (a sibling holds a real interrupt), A is
pinned at its boundary. A physically cannot advance past the point that
is about to become the resume target.

This also answers "surface immediately, or let A continue?" →
**surface immediately.** C is genuinely blocked, the fork suspends as a
unit, and A cannot move.

## Worked example: A checkpoints, B finishes, C interrupts

```
fork(range(3)) as i {           // branches A(i=0), B(i=1), C(i=2)
  const r = llm("...")
  sleep(r)
  const id = checkpoint()       // A reaches here
  maybeInterrupt(i)             // C interrupts here; B returns
  print(r)
}
```

**Capture time:**
1. A's `checkpoint()` reaches the barrier as a soft interrupt.
2. B finishes → `result` cached. C raises a real interrupt → leaf
   checkpoint + `interruptId`.
3. Barrier settles (A: checkpoint boundary, B: result, C: interrupt).
4. ONE shared checkpoint is stamped. Its `branches` map holds: B →
   `result`; C → `interruptId` + `interruptData` + leaf slice; A →
   checkpoint-marker (a soft-interrupt id) at its boundary slice.
5. Batch contains a real interrupt (C) → surface to host, A pins at its
   boundary. The surfaced batch carries C's interrupt (needs a response)
   and A's `std::checkpoint` marker (auto-response; its data includes the
   checkpoint id).

**Resume (`resume(cp, {C: response})`):**
- B: `result` present → short-circuit, no re-run.
- C: re-invoke with saved stack, consume the user's response, continue.
- A: re-enter at its checkpoint boundary and continue (`print(r)` runs
  now, exactly once).

**Later user-initiated `restore(id)` (after the fork joined):** re-enters
the whole fork from the shared checkpoint. Because the captured boundary
had C waiting at its interrupt, restore **re-raises C's interrupt** — the
user answers again. Consistent with "rewind to a point where C was
waiting"; surprising enough to document loudly.

## Unify the resume entry points

`restore(cp)` and `respondToInterrupts(interrupts, responses)` already
both funnel through `execCtx.restoreState(cp)` then re-run the entry node
([docs/dev/concurrent-interrupts.md:466] for the interrupt path;
[lib/runtime/checkpoint.ts] `restore` → `RestoreSignal` →
[lib/runtime/node.ts] `restoreState` for the checkpoint path). They are
two doors to one room; the only difference is whether a response map is
supplied.

Collapse them into one primitive:

```
resume(cp, responses?)   // responses covers the checkpoint's pending interrupts;
                         // empty/absent for a pure checkpoint
```

Then the three user-facing notions are one object with a spectrum of
"pending interrupt" content:

| Concept | = a checkpoint whose pending-interrupt set is… |
| --- | --- |
| pure checkpoint | empty |
| interrupt batch | non-empty, no user checkpoint marker |
| checkpoint-containing-interrupt | non-empty **and** carries a user checkpoint marker |

"A checkpoint that contains interrupts" is not a new mechanism: `State.
toJSON` already serializes branch `interruptId` / `interruptData`
([lib/runtime/state/stateStack.ts:229-231]), so batch checkpoints already
contain parked-interrupt branches. What is new is (a) a *user-taken*
checkpoint marker coexisting with a pending interrupt, and (b) exposing
one unified `resume`.

## Risks / costs to weigh before building

1. **Handler & host surface.** A new `std::checkpoint` interrupt type
   appears in handler chains and, in mixed batches, in the surfaced
   array. Needs a **built-in default auto-responder** so unhandled
   `std::checkpoint` resolves itself — existing hosts/handlers keep
   working; only users who want to react (persist the id, etc.) write a
   handler. In pure batches it never reaches the host.
2. **Post-join `restore(id)` re-raises contained interrupts.** Consistent
   with rewind semantics, but surprising. Document.
3. **`checkpoint()` inside a fork is a barrier.** Blocks until the
   slowest sibling reaches its next boundary — forever if a sibling loops
   without interrupting. Same cost a batched interrupt already pays;
   "checkpoint is instant" stops being true inside concurrent regions.
4. **Determinism improved, not perfect.** The boundary rule kills the bad
   nondeterminism (mid-await / mid-TS capture). Whether a sibling appears
   in the batch as *finished* vs *interrupted* still reflects the
   program's real concurrent logic — correct to preserve, not a
   checkpoint artifact.
5. **One genuinely new code path: auto-resolve without unwinding.** Today
   every batch reaching the barrier with an interrupt unwinds to
   `respondToInterrupts`. The pure-checkpoint batch must stamp-and-
   continue *in place*. This is the piece that doesn't exist yet and
   where a bug would silently turn a snapshot into a mandatory
   suspend/resume. Highest design/test attention.

## Implementation sketch / touch points

- `lib/runtime/checkpoint.ts` — `checkpoint()` no longer captures
  `ctx.stateStack` directly. Solo path: capture `getRuntimeContext().
  stack` (local slice) inline. Concurrent path: emit a `std::checkpoint`
  soft interrupt that flows through the branch's `runBatch`.
- `lib/runtime/runBatch.ts` — treat a returned `std::checkpoint` marker
  as a third settle outcome alongside value/interrupt; stamp the shared
  checkpoint as today; add the **auto-resolve-in-place** path when the
  settled batch contains only checkpoints + results (no real interrupt).
- `lib/runtime/interrupts.ts` — `respondToInterrupts` and `restore`
  refactored behind a single `resume(cp, responses?)`; a default
  auto-responder for `std::checkpoint`.
- `lib/runtime/state/stateStack.ts` — `BranchState` gains a way to mark a
  branch as parked-at-checkpoint (vs interrupt vs result); `State.toJSON`
  already serializes the interrupt fields, extend for the checkpoint
  marker.
- Handler / effect declarations — register `std::checkpoint` as a known
  interrupt kind; default-handled.
- Docs: `docs/site/guide/checkpointing.md`, `docs/dev/checkpointing.md`,
  `docs/dev/concurrent-interrupts.md` — document the boundary rule, the
  soft-interrupt model, the barrier cost, and the re-raise-on-restore
  behavior.

## Open questions

- **Exact auto-resolve mechanics** (risk #5): how to stamp-and-continue
  in place without unwinding, while other siblings in the same batch may
  have unwound (a real interrupt) or not (soft checkpoints). Likely:
  soft-only batches never unwind (all branches are live-suspended at
  their `checkpoint()` await); the presence of any real interrupt forces
  the existing unwind path.
- **Should a `std::checkpoint` marker be user-suppressible / handleable
  to *reject*?** A handler that "rejects" a checkpoint — meaningful, or
  nonsense? Probably nonsense (a checkpoint has nothing to approve), but
  the handler surface makes it expressible; decide the contract.
- **Naming.** `std::checkpoint` vs a distinct "soft interrupt" category
  so handlers can pattern-match "real interrupts only" easily.

## Related

- `docs/dev/concurrent-interrupts.md` — the batch barrier, slice rule,
  shared-checkpoint stamping, resume mechanics this design reuses.
- `docs/dev/checkpointing.md` — current checkpoint/restore model.
- `docs/dev/runBatch.md` — the primitive that would gain the checkpoint
  settle outcome + auto-resolve path.
- `lib/runtime/checkpoint.ts`, `lib/runtime/interrupts.ts`,
  `lib/runtime/state/stateStack.ts`, `lib/runtime/runBatch.ts`,
  `lib/runtime/node.ts` — primary touch points.
- Prior session ticket: the concurrent-streaming lock redesign
  (`2026-07-03-concurrent-streaming-serializes-on-global-lock.md`) — a
  separate but thematically-adjacent "concurrency primitive needs real
  synchronization" cleanup.
