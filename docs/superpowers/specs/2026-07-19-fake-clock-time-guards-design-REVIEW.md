# Review — Fake clock for time-guard tests (#575)

Reviewed against the actual implementation in `lib/runtime/guard.ts` and
`stdlib/supervise.agency`, not just read on its own terms. Overall the design is
sound: the seam is in the right place, the scope is disciplined, and the real
fallback and per-test opt-in are correct. The issues below are mostly with the
spec's *explanation of the mechanism*, which is wrong in a way that would mislead
whoever implements it and whoever writes fixtures against it.

Two things I checked and can confirm the spec got right:
- `agencyStore.getStore()?.ctx` is the correct field path (matches
  `lib/runtime/agency.ts`'s `ctxMaybe`).
- The no-frame real-clock fallback is genuinely needed — a revived guard runs
  outside an execution frame, and the strict `getRuntimeContext()` throws there.

---

## 🔴 Biggest issue: the re-arm premise is wrong

**Where:** "The clock seam" → the paragraph beginning "The loop is the important
part" (around line 190).

The spec says: "Each timer that fires runs a guard's abort callback, and that
callback can arm the next interval timer. So the loop re-reads the pending list
after every firing."

I checked `guard.ts`. The guard's `setTimeout` callback (line 866) does exactly
one thing: `controller.abort(...)`. It never re-arms. The interval is re-armed
only by `startWindow()`, which is reached from install, resume, and
`extendBudget` — i.e. from the supervise handler's `approve(...)` (lines 586,
661, 731). That handler runs at an async runner step, **outside** `advance()`.

So the claim does not hold for a single guard. Inside one synchronous
`advance()` call, a given guard's timer fires **at most once** — there is nothing
on the pending list to re-read, because the re-arm happens later, after the block
yields and the interrupt is answered. The multi-trip behavior you see in practice
comes from the *fixture* calling `advanceTime` more than once (once in the block
body, once inside `slowCheck`), interleaved with runner steps — not from one
`advance()` firing a chain.

The loop still needs to fire every *currently-due* timer, because several
distinct guards (nested guards, or concurrent fork/race branches) can be due at
once — so keep the loop. But please rewrite this paragraph so it does not claim a
single guard re-arms itself inside `advance()`. A fixture author will size their
`advanceTime` amount based on this narrative, and the narrative is misleading.
This also undercuts the firing-cap rationale — see below.

---

## 🟡 The firing cap's stated cause can't happen

**Where:** "The firing cap" (around line 300).

This section assumes one `advance()` can fire a re-arming interval thousands of
times. It can't, per the finding above: a single guard fires once per
`advance()`, then waits on the async handler to re-arm. "`every: 1ms` advanced by
500ms fires roughly 500 times" is not what happens — it fires once. So the
600,000-trip runaway is not reachable from one guard.

A cap can still be worth keeping as a cheap backstop against *many concurrent*
due timers, but justify it on that basis, not on the re-arming-interval story.
And reconsider whether 10,000 earns its keep: if the real firing count per
`advance()` is "number of guards currently due" (small), a much lower cap — or
none — may be simpler. Either way, fix the error-message text and the rationale
so they describe a failure mode that can actually occur.

---

## 🟡 Walk the `overshootIsCoveredByTheGrant` fixture through the real mechanism

**Where:** "What this ships" → the reduced fixture (around line 80).

I traced this one and it does work, but not the way the spec implies:

1. `advanceTime(500)` in the block body fires the guard once (abort at `dueAt`
   100, clock lands at 500).
2. At the next runner step the guard raises the trip; the handler runs
   `slowCheck`, which itself calls `advanceTime(500)` — but no timer is armed at
   that point (the fired one wasn't re-armed yet), so that second call just moves
   the clock.
3. `approve` re-arms and the block resumes to `return`.

Net result: one real trip, `spent = 500`, `overshoot = 400`, which is exactly
what catches the `grant = nextInterval` regression. Good.

Two asks:
- Put this trace in the plan explicitly, and add the early test the "out of
  scope" section already promises — the design's correctness rests on this
  interleaving, not on the firing loop.
- Confirm the second `advanceTime(500)` (inside `slowCheck`) firing nothing is
  intended and harmless. As written it reads like it's meant to advance a live
  interval, and it isn't.

---

## 🟡 Confirm `guard.ts` really is the whole blast radius

**Where:** "How the guard reads it" → "no other file changes" (around line 213).

The six reads inside `guard.ts` are right. But a time-guard/supervise fixture can
*observe* time through other reads this seam does not touch — e.g. per-branch
working-time budget accounting (the cost/time CLI guards) and statelog
timestamps also read wall/monotonic time. If any of those participate in what a
fixture asserts, they'll diverge from the fake clock inside the same test.

Have the plan grep for `performance.now` / `Date.now` across the runtime and
state, and either confirm none of the surviving reads affect a fixture's
observable result, or list the ones that do. `sleep()` is already called out;
make sure that list is exhaustive, not just `guard.ts`.

---

## 🟢 The "synchronous" conclusion is right — and my findings reinforce it

**Where:** "What is deliberately out of scope" → "`advanceTime` is synchronous"
(around line 325).

Synchronous is correct, and it's a direct consequence of the re-arm finding:
since the guard's timer callback only calls `controller.abort()` and never
touches promises, `advance()` has nothing to await. Worth stating the connection
explicitly — "sync works *because* firing a guard timer only sets an abort; the
re-arm and the check run later at a runner step" — so a reader doesn't reach for
async out of caution.

---

## 🟢 Minor / future

- **`maxFirings` plumbing** (around line 161): `advance(ms, maxFirings)` takes the
  cap as a required param, but `advanceTime(ms)` takes only `ms`. Say where the
  cap value is supplied at the call site (a module constant in the `advanceTime`
  backing?), so the plan doesn't have to guess.
- **`wallBaseMs = 0`** (around line 144): a frozen calendar reads as Jan 1 1970.
  Harmless now (nothing calls `wallTime()`), but when #609 wires `std::date`
  through the seam, a test reading "today" gets 1970. Cheap to fix later by
  seeding `wallBaseMs` from a realistic epoch at construction. No change needed
  for this PR — just a known follow-up.
