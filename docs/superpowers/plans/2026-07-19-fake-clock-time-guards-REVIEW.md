# Review — Fake clock for time-guard tests (#575) — Implementation Plan

Reviewed against the code, not just read on its own terms. This plan is strong: it
absorbed the spec-review findings cleanly (firing cap dropped, re-arm described
correctly in Task 1's `advance` doc-comment and Task 6's trace), and the TDD
structure with a red-first step per task is exactly right.

Things I checked and can confirm the plan got right:
- **The env-var mechanism is idiomatic, not a module-global smell.** `executeNodeAsync`
  spawns a `node` subprocess via `execFileAsync` with `env: { ...process.env, ...env }`
  (`lib/cli/util.ts:352,357`). Setting `env.AGENCY_FAKE_CLOCK = "1"` scopes the flag
  to that child only — it never mutates the parent worker's `process.env`. This is
  the same pattern as `AGENCY_LLM_MOCKS` / `AGENCY_FETCH_MOCKS_FILE`. Good fit.
- **The `_installSlowInput` precedent is exact.** `stdlib/thread.agency:205` is a
  non-exported `def` calling `_installSlowInputImpl` (exported from
  `lib/stdlib/builtins.ts:133`), reached via `import test`. Task 4 mirrors it
  precisely, including the `agency-lang/stdlib-lib/builtins.js` import specifier.
- **`check()` returns, it does not throw.** `TimeGuard.check(stack): GuardExceededError | null`
  (`guard.ts:175,681`), so the Task 3 unit-test assertions (`toBeNull()` /
  `not.toBeNull()`) are correct. Note the once-only consume flag (`guard.ts:537`):
  the second `check()` after a trip returns null. The Task 3 test is fine because
  its first `check()` is under budget (returns null), and it calls `check()` twice,
  not three times — but keep that flag in mind if the test grows.
- **No existing clock seam is being duplicated.** `guard.ts` calls `performance.now`
  and `setTimeout` directly today; there's no runtime `Clock` abstraction to reuse.
  Correct altitude — this seam is genuinely new.

---

## 🔴 Task 6, Step 4: the nested / subprocess fixtures are the real risk, and they're treated as routine

Step 4 says "swap each guard-clock `spin(...)` for the equivalent `_advanceTime(...)`"
for the `nested-pause-*` and `guards/*` fixtures in one line. Two mechanics make
this the hardest part of the whole change, not a rote swap:

**1. `_advanceTime` advances only the clock of the process it runs in.** The
`nested-pause-*` fixtures are subprocess-IPC fixtures — the guard whose budget must
expire may be armed in a *child* agency process, not the one where the old `spin()`
ran. `AGENCY_FAKE_CLOCK=1` is inherited by every descendant process (env inheritance
on spawn), so each has its *own* `FakeClock`, but a `_advanceTime` call moves only
the clock of the process that executes it. Before converting each subprocess fixture,
the plan should require tracing which process holds the guard timer that must fire,
and confirming the `_advanceTime` call runs in that same process. A swap that moves
the parent's clock while the guard lives in the child will simply never trip.

**2. One `_advanceTime` fires every due timer at once, so it can over-shoot a trip
that a real run would have stopped at.** `advance(ms)` fires all timers with
`dueAt <= target`, in due order. For a single guard that's fine (and the dueAt
ordering correctly preserves inner-before-outer trip order). But when two guards are
armed with different limits — an inner `guard(time: 50ms)` inside an outer
`guard(time: 100ms)` — `_advanceTime(200)` sets *both* tripped flags in one
synchronous call, before the runner observes either. In a real `spin()` run the
inner trip aborts the block at 50ms and the outer timer is never reached. The fake
clock reaches it anyway. For any fixture with nested or concurrent guards, this can
change which guards trip and how many. The plan should call this out and, per such
fixture, either advance in increments that stop at the first expected trip, or
confirm the multi-trip outcome matches the original.

Neither of these breaks the design — they're migration hazards. But Task 6 Step 4
currently hands them to the implementer as a one-liner. Give each nested/subprocess
fixture its own sub-step with the "which process / which guard trips first" check
written out, the way `overshootIsCoveredByTheGrant` got its trace in Step 1.

---

## 🟡 Task 0's gating decision lives only in the PR description

Task 0 audits which fixtures assert on a non-guard time read, and its output is "one
line per fixture in the PR description." That finding *gates* Task 6 (a fixture that
asserts on a non-guard time value must not be migrated). Right now the linkage is
informal: Task 6 Step 4 re-decides "convert only fixtures whose slowness comes from a
guard clock" on its own rather than consuming Task 0's list.

Make it explicit: Task 6 Step 4 should reference the Task 0 cleared-list by name and
migrate exactly that set, no more. Otherwise the audit and the migration can drift,
and a fixture Task 0 flagged as unsafe can still get swapped in Task 6. A durable home
for the list (even a scratch note committed with the branch) beats a PR-description-only
record that's gone once the PR merges.

---

## 🟢 Minor / affirmations

- **Two paths install the fake clock, by design.** The explicit `clock?: Clock`
  constructor arg (Task 2) is the *unit-test* seam; the `AGENCY_FAKE_CLOCK` env var is
  the *subprocess e2e* seam. Both are legitimate, but the plan never says the arg is
  never used in production. One sentence in Task 2 saying so would stop a reader from
  hunting for the arg's production call site.
- **`wallBaseMs = 0`** (Task 1): a frozen calendar reads as Jan 1 1970. Nothing calls
  `wallTime()` in this feature, so it's harmless now, but flag it as a known follow-up
  for #609 (seed the base from a realistic epoch at construction) so it's a decision,
  not a surprise. No change needed here.
- **Number inconsistency:** the spec's `spin` example counts to 3,000,000; Task 6
  Step 1 says replace `spin(300000)` (300k). Harmless, but reconcile so the "was:"
  comments match what's actually in the fixture.
- **Task 5 Step 2's red is a red-for-a-different-reason.** The fixture first fails
  because `_advanceTime` throws "needs a fake clock" (fail-loud proof), not because the
  trip interleaving is unproven. That interleaving is only proven green at Step 6.
  That's fine and even a nice bonus proof — just worth noting the Step 2 red does not
  yet exercise the trip path, so don't read a Step 6 failure as "wiring is done."

---

# Anti-pattern audit (vs `docs/dev/anti-patterns.md`)

First, what the structural linter (Task 7 Step 4) will and won't catch. `lint:structure`
is `eslint lib/`, and its only Agency rules are: no dynamic imports, `max-depth` 5,
`max-lines-per-function` 150, `max-lines` 1250. It does **not** enforce nested
ternaries, single-char names, or magic numbers. So the judgment-call items below will
pass the lint step green — they need a human. (None of the plan's code trips the four
enforced rules: `guard.ts` is 962 lines and the added helper is tiny.)

## Declarative "what" vs imperative "how" — the plan gets this right

This was the headline question, and the answer is: the core split is on the *good* side
of the "imperative code everywhere" anti-pattern. The `Clock` type is a declarative
"what" — `now()`, `wallTime()`, `setTimer`, `clearTimer`. The imperative "how" (real
`setTimeout`/`performance.now` vs. the fake timer-drain loop) is encapsulated inside
`realClock` and `FakeClock`. Consumers stay declarative: `guard.ts` reads
`this.clock().now()` and never sees a raw timer again. That's exactly "encapsulate the
imperative code in a few places and expose a nice abstraction," and it means a future
change to *how* time is sourced touches only the clock, not the six guard call sites.
The messy `while (true)` drain in `FakeClock.advance` is fine precisely because it's
sealed inside the abstraction.

## The one place "how" leaks into the caller — `_advanceTimeImpl` (Task 4)

```ts
if (!(ctx.clock instanceof FakeClock)) { throw new Error(...); }
ctx.clock.advance(ms);
```

This is the single spot that branches on the concrete type in the caller rather than
dispatching through the interface. It exists because the plan (following the spec)
deliberately keeps `advance` **off** the `Clock` type — only `FakeClock` has it.

The more declarative alternative: put `advance(ms): void` on `Clock`, give
`realClock.advance` a body that throws "needs a fake clock," and `_advanceTimeImpl`
collapses to one line — `getRuntimeContext().ctx.clock.advance(ms)` — with no
`instanceof` and no caller-side branch. The "what happens when you advance a real
clock" then lives inside `realClock`, where the rest of the how already lives.

The tradeoff is real and worth a conscious decision: the alternative widens the
*production* `Clock` interface with a test-only verb. My lean is that the current
`instanceof` is acceptable — it's confined to a test-only helper, not a hot path, and
it keeps the production interface honest — but this is the one design choice in the
plan that sits against the anti-pattern the question asked about, so call it out and
decide on purpose rather than by default.

## Reuse: guard's `clock()` should call the canonical accessor, not re-inline it

Task 3's helper is:
```ts
private clock(): Clock {
  return agencyStore.getStore()?.ctx?.clock ?? realClock;
}
```
The lax context reach `agencyStore.getStore()?.ctx` is already the canonical
`agency.ctxMaybe()` (exported at `lib/runtime/agency.ts:442`). Re-inlining it duplicates
that access pattern — the "duplicating existing code" / "inconsistent patterns" entries,
and the exact drift the `lsp-prelude-drift` work was about (two copies of one access list
diverging). Prefer `agency.ctxMaybe()?.clock ?? realClock`.

Caveat to verify: importing the `agency` namespace into `guard.ts` may create an import
cycle (`agency.ts` pulls in guard-adjacent runtime). If it does, inlining is the
pragmatic exception — but then say so in a one-line comment, so the duplication reads as
deliberate, not accidental.

## Nested-ternary / too-much-on-one-line — Task 2 Step 3

```ts
this.clock = args.clock ?? (process.env.AGENCY_FAKE_CLOCK ? new FakeClock() : realClock);
```
A coalesce wrapping a ternary, doing env-read + instantiation + fallback on one line.
The linter won't flag it, but it's on the doc's "nested ternaries" / "too much on a
single line" list. Extracting a small `defaultClock()` (the env-var "how") leaves the
constructor reading declaratively: `this.clock = args.clock ?? defaultClock()`. This is
the same declarative-encapsulation move as the Clock seam itself, applied one level down.

## Minor / judgment calls (not lint-enforced)

- **Single-char names in the new TS tests:** `c` (clock), `h` (handle), `g` (guard) in
  `clock.test.ts` and `guard.clock.test.ts`. The doc bans single-char names; give them
  real names. (The `r` for a `Result` in the `.agency` fixtures is fine — that's the
  established convention in `supervise.agency` itself.)
- **`FakeClock.advance` picks the next timer via `.filter(...).sort(...)[0]`** re-run
  every iteration — O(n²·log n) and an indirect way to say "the minimum due timer." The
  timer list is tiny so it doesn't matter for speed; it's a readability nit. Fine to
  leave, or a single `reduce` to the min reads more plainly.

## Clean — no hits

Dynamic imports (none), try-catch-swallow (the helper throws; nothing is caught and
dropped), useless special cases (`advance` handles the empty timer list without an
`if (length === 0)` guard), the `...(cond ? {x} : {})` ugly-spread, `safeDelete` (Task 6
uses `cp` to back up a file, and never deletes a repo file), and magic numbers (the
firing-cap constant is gone; the remaining numbers are contextual test values).

---

# Test-plan audit — will these tests fail when the code breaks?

Short answer: the *end-to-end* tests are strong and would catch a real break, but one
key *unit* test is too coarse to prove what it claims, and two design invariants have no
test at all. Details below, most important first.

## 🔴 Task 3's unit test can pass on a half-routed guard — assert `spent`, not just non-null

This is the sharpest issue. `TimeGuard.check` (`guard.ts:691`) trips when
`this.tripped || this.currentElapsed() >= this.timeLimit` — it reads the clock
*directly* via `currentElapsed()`, on purpose, so a tight loop that starves the
`setTimeout` macrotask can't escape the guard. The trip is an **OR** of two independent
paths: the routed *timer* (sets `tripped`) and the routed *`now()` reads*
(`currentElapsed()`).

The Task 3 test only asserts `g.check(stack)` is `not.toBeNull()` after `advance(200)`.
After that advance the fake timer fires and sets `tripped = true`, so `check()` returns
a trip **regardless of whether the six `now()` reads were routed**. An implementer who
routes `setTimer` but forgets one of the `performance.now()` reads inside
`currentElapsed()` (lines 596/638/729) would compute a garbage real-time delta — and this
test would still be green, because `tripped` short-circuits the OR.

Fix: assert the **reported `spent`**, which flows from `currentElapsed()` → `now()`:
```ts
const err = g.check(stack)!;
expect(err.spent).toBeCloseTo(200, 0);   // fake time, not a real-clock delta
```
An unrouted `now()` read makes `spent` a huge real-millisecond number, so this assertion
fails exactly when the routing is incomplete. This is also the established pattern — the
existing `guard.test.ts` asserts `.spent` at lines 92/106/121/178/193, so Task 3 is the
odd one out for checking only nullness. Do the same in the under-budget case (confirm
`spent` reflects the 50ms advance, not real time).

## 🟡 The `advance()` re-entrancy invariant is untested

`FakeClock.advance` re-reads `this.timers` on every iteration specifically so a fired
callback that arms a *new* timer is handled correctly — that's the whole reason it isn't
a one-shot snapshot loop. Task 1 tests the no-re-arm case ("terminates when a fired
callback is a no-op") but never the re-arming case. Someone "simplifying" the loop to
snapshot the pending list once would break nothing that's tested.

Add two cases:
- a callback that arms a timer due *within* the same advance → it fires in the same call;
- a callback that arms a timer *beyond* target → it does **not** fire.

This pins the design decision the doc-comment leans on, and it's cheap.

## 🟡 The opt-out assertion is muddy — it passes on *any* error

Task 5 Step 7's `advanceWithoutFakeClockThrows` expects `"tripped-or-errored"`. That
string can't tell "the fake-clock guard correctly refused" from "some unrelated failure
crept in." The test would stay green if `_advanceTime` threw for the wrong reason, or if
a future bug made the block fail elsewhere. Since the point of this case is that a
no-fake-clock run fails *loudly and specifically*, assert on the message:
```ts
if (isFailure(r)) { return r.error }   // and expectedOutput matches /fake clock/
```
so the test proves the `_advanceTimeImpl` guard fired, not just that *something* went
wrong. (The plan already flags the crash-vs-Failure uncertainty here; folding the message
check in resolves both at once.)

## 🟡 No guard-level test for concurrent / nested trips

The plan-review flagged nested/subprocess migration (Task 6 Step 4) as the riskiest part.
Task 1 tests multiple *raw* FakeClock timers firing in due order, but nothing tests two
**TimeGuards** with different limits both metering against one advanced clock — e.g. an
inner `TimeGuard(50)` inside an outer `TimeGuard(100)`, one `advance(200)`, and which
trips (and with what `spent`). Given that this is exactly where the migration can change
behavior, a small unit test at the guard level — not just the clock level — would earn
its keep before Task 6 converts the nested-pause fixtures.

## 🟢 Minor gap: the `dueAt === target` boundary

The filter is `dueAt <= target`. Task 1 tests firing at 110-past-100 and not-yet at 50,
but never a timer due *exactly* at the advance target. A guard armed for 100ms and
advanced by exactly 100 is a realistic fixture; add `setTimer(fn, 100); advance(100)` and
assert it fires, so the boundary is nailed down rather than assumed.

## 🟢 Affirmations — these tests do what they claim

- **Revive-with-no-frame is genuinely covered.** I checked: `guard.test.ts` runs
  frameless (no `runInTestContext`), so after routing, `this.clock()` resolves through
  `getStore() → undefined → realClock`. If the helper threw outside a frame, those tests
  would crash. So Task 3 Step 5 really does exercise the fallback. Worth adding one
  *named* frameless test that reads `clock()` directly, so the coverage is intentional
  and documented rather than a side effect — but the behavior is covered today.
- **Task 6 Step 3 is the strongest test in the plan.** Reverting `grant = overshoot +
  nextInterval` → `grant = nextInterval` and requiring `overshootIsCoveredByTheGrant` to
  FAIL proves the migrated fixture still catches the exact regression it was written for.
  The `grep -n "locals.grant = " stdlib/supervise.js` guard against the incremental
  manifest silently skipping the rebuild is precisely the right defensive step for a
  known gotcha. Keep it.
- **Red-first discipline is consistent.** Every task writes the failing test and runs it
  to confirm the failure before implementing, so the tests are proven to fail on the
  unimplemented state — the one caveat being Task 5 Step 2's red fires for the throw
  reason, not the trip path (already noted above).

## Coverage vs the spec's mandated tests

The spec named six required tests. Mapping: deterministic trip → Task 5 (strong);
reverted-build regression → Task 6 Step 3 (strong); concurrent due timers → Task 1
(clock-level only — see the nested-guard gap); opt-out → Task 5 Step 7 (weak assertion,
see above); revive-with-no-frame → implicit in Task 3 Step 5 (real, but unnamed);
existing fixtures keep passing → Task 3 Step 5 + Task 7. The firing-cap test the spec
once listed is correctly gone with the cap. So all six are *present*; two (opt-out,
revive) are softer than they read, and one (concurrent) is tested a layer below where the
risk actually lives.
