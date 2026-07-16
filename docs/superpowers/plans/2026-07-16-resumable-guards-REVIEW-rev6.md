# Plan review: resumable guards, rev 6 (2026-07-16)

**Reviewing:** `docs/superpowers/plans/2026-07-16-resumable-guards.md` (rev 6)
**Supersedes:** the rev-5 review.
**Verdict:** Ship it, after one fix. Every rev-5 item is folded, and folded with
the reasoning attached rather than the conclusion copied. The capture point is
right, the three-caller rules are explicit, and the `preapprove()` catch is one
the plan found on its own that I missed. **One finding left: the pending-trip
record's lifecycle is specified only in prose fragments, and the gap it leaves
is a fork deadlock on the propagate path** — the feature's headline path. It is
a paragraph of specification, not a redesign.

All line references are `packages/agency-lang/`, verified today.

---

# The finding

## The `pendingTrip` record can hang a fork, because nothing says who settles it

Task 2.2 says the shared `CostGuard` holds a live `pendingTrip: {key, settled}`
record, and that "a branch that finds one pending `await`s its `settled` promise,
then re-checks." What the plan never says is **who resolves `settled`, and on
which paths**. There are four exits from a raise, and only one of them obviously
resolves it:

| Exit | Resolves `settled`? |
|---|---|
| A handler approves | yes — the raise returns normally |
| A handler rejects | the raise **throws** `GuardExceededError` |
| No handler → propagate → checkpoint + halt | the raise **throws** `HaltSignal` and the run stops |
| The merge/decision-8 error | the raise **throws** |

Three of four leave by a throw, and the propagate case is worse than a throw: the
answer arrives in a *different run*, after a checkpoint. A parked sibling is
sitting on a promise that, by construction, nobody in this process will ever
resolve.

That is a hang, not a slow path. `runBatch`'s fork join is
`await Promise.allSettled(...)` (`runBatch.ts:602`), so a branch parked forever
means the join never returns — and the run hangs instead of surfacing branch A's
interrupt to the user. The reachable case is small and ordinary: a fork, a shared
cost guard, no in-program handler. Exactly the setup of the plan's own
`dedupe restore variant` fixture. (`race` is unaffected — `Promise.race` at
`:703` doesn't wait for the loser.)

**What to specify** — one paragraph in Task 2.2, next to the record:

- **Set it synchronously.** The sketch shows `raiseGuardTrip` *checking* the
  record but never *setting* it, and the set has to happen before the first
  `await` or two branches both pass the check and both raise. `resolve` →
  `containsRootBudget` → `guardTripKey` → **set the record** → `suspendAll` →
  `await`.
- **Settle it on every exit,** which means a `finally`, next to the existing
  `unsuspendAll()`. Approve, reject, decision-8 error, and halt all release the
  parked siblings.
- **Decide what a parked branch does when the settle came from a halt.** The
  natural answer is the one the plan already relies on elsewhere: it re-checks,
  finds the guard still over budget, and raises its own trip — which propagates
  too, and concurrent branch interrupts are already supported
  (`docs/dev/concurrent-interrupts.md`). The user is asked twice, which is
  exactly the documented v1 trade the dedupe section already owns for the restore
  case. Say that it is the same trade, arriving by the same door.

The `dedupe restore variant` fixture would catch this — as a hanging test, which
is the worst way to learn it. Specify the lifecycle and the fixture becomes a
pin instead of a discovery.

---

# Notes

## The `finally` unsuspends during a propagate — harmless, worth one clause

`raiseGuardTrip`'s `finally { scope.unsuspendAll(); }` runs on the `HaltSignal`
unwind too, so the scope is unsuspended while the run is halted waiting for a
human — which reads like it contradicts the bullet above it ("between raise and
verdict the scope must not tick or gate anything — including during
propagate-to-user").

It is fine, for a reason worth stating rather than leaving a reader to
reconstruct: `Runner.halt` already pauses every guard (`runner.ts:253`), so
nothing ticks regardless; and on resume the guards come back from a checkpoint
that never carried `suspended`, so the replayed raise re-suspends them. The
suspension bracket protects the *in-process* deliberation window; the halt
protects the propagate window. Two mechanisms, one property.

## Small

- Task 1.3's test list has no test for the `preapprove()` → `pass()` rule, though
  1.3a promises one ("Pin it with a fixture"). It belongs in the Task 1.3 list or
  the Task 2.5 table; right now it is named in prose and absent from both.
- `guardTripKey`'s comment covers three of the five cases I walked in the rev-5
  review. The two missing are cheap to add and are the ones a reader will
  stumble on: a clamped-to-zero delta can't produce a stale key (decision 8
  errors first), and disarm leaves the limit unchanged but there is no next trip
  to collide with.

---

# What is right

The `preapprove()` finding is the kind of thing that makes a plan trustworthy:
its auto-approve handler answers *every* interrupt with `approve()`, which for a
trip is `approve({})`, which decision 8 turns into a runtime error — so every
preapproved tool that tripped a guard would have blown up inside the wrapper.
Nobody asked for that; the plan found it by taking its own rule seriously across
all three registration paths. That is what "ruled explicitly" is for.

The cross-branch rule is better than what I asked for. I flagged the arbitrary
hidden set and asked for *a* rule; the plan noticed that the main use case
**depends** on cross-branch eligibility — the walked example's handler registers
before the fork, so branch trips must reach it — and derived a rule that keeps it
working: evaluate `guardsHiddenFrom` against the raising branch's stack, so
pre-registration guards (shared cost guards, inherited clones carrying the
parent's id) still meter the handler, and anything branch-local to the sibling is
hidden.

And `runner.ts:772` now carries decision 14's proof in Part 1.3, in the function
the task edits. Four counter designs died on that line. Having it quoted where
the next person will be tempted to add a fifth is the most durable thing in the
document.

# Recommended next steps

1. Specify the `pendingTrip` lifecycle: set synchronously before the first await,
   settle in a `finally` on all four exits, and state what a halt-released branch
   does.
2. Add the `preapprove()`-passes fixture to a list, and the two missing key cases
   to the comment.
3. Execute PR 1.
