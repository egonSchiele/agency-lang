# Plan review: resumable guards, rev 7 (2026-07-16)

**Reviewing:** `docs/superpowers/plans/2026-07-16-resumable-guards.md` (rev 7)
**Supersedes:** the rev-6 review.
**Verdict:** The deadlock fix is correct — I walked the concurrency and it holds.
Two small things remain, both inside the new sketch, both a few lines to fix.
Neither is a design question. After them, execute.

All line references are `packages/agency-lang/`, verified today.

---

# Findings

## 1. The detect→raise call site needs a loop, and a single check leaks a request

Task 2.2 says: "The prompt/addCost sites move to a new sibling
(`detectTrippedGuard(): Guard | null`) and call the raise." One detect, one
raise. The parked-branch line in the sketch has the same shape:

```ts
if (detectTrippedGuard(stack) !== tripped) return;   // refilled — done
```

Both assume that once *this* guard's question is answered, the gate is clear. It
is not, and decision 16 is exactly why:

> If newly granted inner spend later pushes an OUTER guard over its limit, the
> outer guard trips on its own, raises its own interrupt…

That "on its own" has to happen *somewhere*. With a single check it happens one
request too late. Concretely, at site 1 (the pre-call gate):

1. The inner guard is over budget. `detectTrippedGuard` returns it, the gate
   raises, the handler grants $0.50.
2. `raiseGuardTrip` returns. The gate treats that as "clear" and **sends the
   request** — while the outer guard is now over its own limit.
3. The outer guard's question gets asked at the *post-charge* site instead, after
   the money is spent.

That contradicts the taxonomy's headline claim for site 1, which is the reason
site 1 raises where it does: *"Nothing is in flight while the question is out,
and not a cent can leak, because the request was never sent."* A cent can leak —
one whole request's worth — and it leaks precisely in the case decision 16 was
written to describe.

The parked-branch `return` is the same bug through a second door: it returns
"approved" whenever the newly-tripped guard is not the one it was parked on,
including when a *different* guard is now over budget.

**Fix.** The call site loops until the stack is actually clear:

```ts
let g: Guard | null;
while ((g = stack.detectTrippedGuard()) !== null) {
  await raiseGuardTrip(stack, g, dimensionOf(g));   // returns = this one is settled
}
// only now: send the request / book the charge
```

The parked branch then just returns and lets its caller re-detect, which is what
its `!== tripped` check was reaching for. Both raising sites need it — the
post-charge site too, since one charge can push an inner guard and its enclosing
outer over together, and each is owed its own question. Worth one sentence in
Task 2.2 saying so, because "raise, then proceed" is what a reader will write
from the current text.

## 2. The pending record is set outside the `try`, which re-opens the deadlock

The new sketch:

```ts
const pending = makePendingTrip();
tripped.pendingTrip = pending;                        // ← set

const interruptKey = guardTripKey(tripped, dimension);  // ← can throw
scope.suspendAll();                                     // ← can throw
try {
  ...
} finally {
  scope.unsuspendAll();
  tripped.pendingTrip = undefined;
  pending.settle();
}
```

There is a three-line window between the set and the `try` where a throw leaks
the record permanently: never cleared, never settled, so every future branch that
touches this guard parks forever on a promise with no owner. That is the exact
deadlock the `finally` was added to prevent, re-entering through the gap in front
of it. `guardTripKey` calls `currentLimit()` and `suspendAll` walks members —
neither is obviously infallible, and "obviously infallible today" is not a
property worth betting a hang on.

**Fix:** move `try` to immediately after the assignment, so the record's lifetime
and the `finally` are the same region:

```ts
tripped.pendingTrip = makePendingTrip();
try {
  const interruptKey = guardTripKey(tripped, dimension);
  scope.suspendAll();
  ...
} finally {
  scope.unsuspendAll();          // safe if suspendAll never ran — it is a no-op
  const p = tripped.pendingTrip;
  tripped.pendingTrip = undefined;
  p?.settle();
}
```

## Trivial

- `detectTrippedGuard(stack)` in the sketch vs `detectTrippedGuard(): Guard | null`
  as a `StateStack` method in the Files list — free function in one place, method
  in the other. Pick one.

---

# The concurrency walk (it holds)

Recording this so the next reader does not have to re-derive it, because the
"why" is not obvious from the code:

- **Mutual exclusion is real.** `raiseGuardTrip` runs synchronously from its
  entry to `tripped.pendingTrip = pending` — `resolve`, `containsRootBudget`, the
  `while` condition on an empty record, `makePendingTrip` are all sync, and an
  `async` function body executes synchronously until its first `await`. So a
  second branch entering after the first cannot miss the record. The comment says
  this; it is correct.
- **The `while` (not `if`) is load-bearing.** A third branch can claim the record
  between a parked branch's wake and its re-check, and the loop parks it again.
- **The wake sees a cleared record.** The `finally` sets `pendingTrip = undefined`
  *before* `settle()`, so a woken branch's loop condition is false and it proceeds
  to claim its own.
- **The halt path releases correctly.** Propagate throws `HaltSignal`, the
  `finally` still runs, parked siblings wake, re-check, and raise their own trips
  — which also propagate, and concurrent branch interrupts are already supported.
  The fork join (`Promise.allSettled`, `runBatch.ts:602`) gets every branch.
- **Time guards make this code inert for free**, which is worth one clause in the
  plan: `pendingTrip` lives on the guard object, `TimeGuard.cloneForBranch` gives
  each branch its own object, so the `while` always sees `undefined` and the
  dedupe no-ops. Decision 10 says "cost-only by construction" — this is the
  construction, and saying so stops someone from later "fixing" the missing time
  dedupe.

# What is right

The fix is not just applied, it is explained where the explanation is needed: the
`finally` comment names all four exits and says why three of them being throws is
the whole point. That comment will still be doing its job in a year, when
somebody wonders why a settle sits next to an unsuspend.

The `guardTripKey` comment now walks all five cases, including the two that look
like holes until you read them (clamped-to-zero errors before the key is reused;
disarm repeats the key but has no next trip). And the unsuspend-during-propagate
clause is exactly the right length — it answers the reader's objection and moves
on.

# Recommended next steps

1. Loop the detect→raise call sites (finding 1).
2. Move the `try` up (finding 2).
3. Execute PR 1.
