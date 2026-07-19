# Fake clock for time-guard tests (#575)

## Background

Agency has a feature called a time guard. You write `guard(time: 100ms) { ... }`,
and if the block runs longer than 100 milliseconds, the guard trips: it aborts
the block and hands back whatever draft the block saved. There is also
`supervise(every:, maxTime:, check:)`, which trips on a schedule so a check
function can look in and decide whether to continue, redirect, or stop.

Both of these read the real clock. The guard notes the wall-clock time when the
block starts, and it arms a real timer that fires when the limit is up.

That makes the guards hard to test. A test cannot ask for "exactly 200
milliseconds of block time" without actually spending 200 milliseconds. So the
existing test fixtures burn real time instead. They call a helper named `spin`,
which counts in a loop to run down the clock:

```agency
def spin(rounds: number): string {
  let i = 0
  while (i < rounds) {
    i = i + 1
  }
  return "spun"
}
```

To make a block overshoot its limit, a fixture counts to three million.

This is the whole problem. Counting to three million takes a different amount
of time on a fast machine than on a slow one, so these fixtures are tuned to the
hardware. The tuning is fragile. One fixture,
`tests/agency/supervise/supervise.agency`, spends 70 seconds counting, which is
a quarter of all the time the Agency test suite added over one recent week. And
the tuning can silently stop working: a fixture that counts too few rounds still
passes, it just stops catching the bug it was written for. A faster CI machine
makes this worse, not better, because a quicker loop produces less overshoot.

The fix is a fake clock. A test turns it on, and then instead of counting to
three million, the test simply says "pretend 200 milliseconds passed." The guard
trips because its clock moved, not because real time elapsed. The result does
not depend on the machine, and the fixture drops from 70 seconds to about 3.

The original filed issue proposed advancing time through entries in the LLM mock
list. That does not work here, because the slowest fixtures make no LLM calls at
all. The clock has to move on a plain function call from inside the fixture.

## What this ships

A fixture opts in, imports the test seam, then advances time with a function
call:

```agency
import test { _advanceTime } from "std::date"

node tripsWhenTheBudgetRunsOut(): string {
  const r = guard(time: 100ms) {
    _advanceTime(200)
    return "never reached"
  }
  if (isFailure(r)) { return "tripped" }
  return r.value
}
```

`_advanceTime(200)` moves the fake clock forward 200 milliseconds and fires any
guard timer that comes due along the way. The guard's timer was set for 100
milliseconds, so it fires, and the block trips. No real time is spent.

The 70-second fixture becomes this:

```agency
def slowCheck(elapsed: number): SuperviseDecision {
  checks.push("checked")
  slowChecks = slowChecks + 1
  if (slowChecks == 1) {
    _advanceTime(500)      // was: spin(3000000)
  }
  return { action: "continue", message: "" }
}

node overshootIsCoveredByTheGrant(): string {
  const r = supervise(every: 100ms, maxTime: 600000, check: slowCheck) {
    _advanceTime(500)      // was: spin(3000000)
    return "done:spun"
  }
  if (isFailure(r)) { return "failed:${r.error}" }
  return r.value
}
```

The overshoot is now stated outright: 500 milliseconds against a 100-millisecond
interval. Nothing is tuned to the machine.

It is worth tracing this fixture, because its correctness rests on the exact
order of events, not on the clock loop firing many times.

1. `_advanceTime(500)` in the block body fires the guard's timer once. The timer
   was due at 100 milliseconds, the clock lands at 500, and the guard aborts.
2. At the next runner step the guard raises the trip. The supervise handler runs
   `slowCheck`, which itself calls `_advanceTime(500)`. No timer is armed at this
   moment, because the one that fired was not re-armed, so this second call only
   moves the clock. That is intended, not a mistake in the fixture.
3. `approve(...)` re-arms the interval and the block resumes to `return`.

The net effect is one real trip with `spent = 500` and `overshoot = 400`, which
is exactly what catches the `grant = nextInterval` regression. The plan carries
this trace and turns it into the early test named under Testing, because the
design leans on this interleaving.

## The pieces

### The clock seam

A new file, `lib/runtime/clock.ts`, defines what a clock is:

```ts
export type TimerHandle = { id: number };

export type Clock = {
  /** Monotonic milliseconds. What a time guard meters against. */
  now(): number;
  /** Milliseconds since the Unix epoch. What std::date reads. */
  wallTime(): number;
  setTimer(fn: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
};
```

Two of these fields matter for this feature and two are here for the future.

The guard uses monotonic time, which is a counter that only ever moves forward,
read today through `performance.now()`. That is `now()`. The guard also arms and
cancels a timer. Those are `setTimer` and `clearTimer`. This feature exercises
those three.

`wallTime()` is here on purpose, though nothing in this feature calls it.
`std::date` reads calendar time through `new Date()`, which is a different clock
from the guard's monotonic counter. A future `elapsedTime` function
([issue #609](https://github.com/egonSchiele/agency-lang/issues/609)) will want
to read calendar time through the same seam, so that turning on the fake clock
also freezes the calendar in a test. Putting `wallTime()` in the type now means
that later work reroutes one function instead of widening this interface. This
feature leaves `wallTime()` implemented but unused.

One follow-up to record for that later work, not to fix here: `FakeClock` starts
`wallBaseMs` at zero, so a frozen calendar reads as 1 January 1970. Nothing calls
`wallTime()` yet, so it does not matter now. When #609 wires `std::date` through
the seam, a test that reads "today" would get 1970 unless the base is seeded from
a realistic epoch at construction. That is a cheap change to make then.

The real clock is the default and changes no behavior:

```ts
export const realClock: Clock = {
  now: () => performance.now(),
  wallTime: () => Date.now(),
  setTimer: (fn, delayMs) => ({ id: setTimeout(fn, delayMs) as unknown as number }),
  clearTimer: (handle) => clearTimeout(handle.id),
};
```

The fake clock keeps a number and a list of pending timers:

```ts
export class FakeClock implements Clock {
  private monotonicMs = 0;
  private wallBaseMs = 0;   // wall time = base + monotonic, so the two move together
  private timers: { dueAt: number; fn: () => void; id: number }[] = [];
  private nextId = 1;

  now(): number { return this.monotonicMs; }
  wallTime(): number { return this.wallBaseMs + this.monotonicMs; }

  setTimer(fn: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ dueAt: this.monotonicMs + delayMs, fn, id });
    return { id };
  }

  clearTimer(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== handle.id);
  }

  advance(ms: number): void {
    const target = this.monotonicMs + ms;
    while (true) {
      const due = this.timers
        .filter((t) => t.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.monotonicMs = due.dueAt;   // move the clock TO the timer, then fire it
      due.fn();
    }
    this.monotonicMs = target;
  }
}
```

Only `monotonicMs` moves. `wallTime()` reads it plus a fixed base, so the two
clocks always advance together and there is no separate bookkeeping to get wrong.
After `advance(ms)`, both `now()` and `wallTime()` have moved forward by `ms`.

The loop fires every timer that is due within the span. A guard's abort callback
does one thing, `controller.abort(...)`; it does not arm a new timer. Re-arming a
supervisor's next interval happens later, in `startWindow()`, reached from the
`approve(...)` path at an async runner step, which is outside `advance()`. So a
single guard's timer fires at most once per `advance()` call.

The loop still fires more than one timer when several distinct guards are due at
once: nested guards, or the separate branches of a `fork`/`race`, each hold their
own timer. The clock steps to each timer's due time before firing it, so a
callback that reads `now()` sees the time its own timer was due for.

The loop is guaranteed to end. Nothing inside `advance()` calls `setTimer`, and
each iteration removes one timer from the pending list, so the list strictly
shrinks and the loop stops after firing every currently-due timer. There is no
runaway to guard against, which is why this design has no firing cap. If the
timer model ever changes so a callback re-arms itself synchronously, revisit
this — but today it cannot.

### Where the clock lives

The clock lives on the `RuntimeContext`, which is the object the runtime builds
once per run and threads through execution. Code reaches it through
`getRuntimeContext()`, the same accessor that stdlib TypeScript helpers already
use. This keeps the clock out of any module-level variable, so two tests running
in one process cannot disturb each other's clock.

The `RuntimeContext` constructor takes a new optional `clock`, defaulting to
`realClock`. Nothing else about the constructor changes.

### How the guard reads it

Every clock read in `lib/runtime/guard.ts` goes through a small helper instead of
calling the global functions. That file has six reads of the current time, one
`setTimeout`, and one `clearTimeout`. Those are the reads the fake clock needs to
control, because they are what a time guard meters and trips on.

Other parts of the runtime read time too and this seam does not touch them: the
per-branch working-time budgets from the cost and time CLI guards (#549, #550),
and statelog event timestamps, among others. That is fine for a fixture that only
asserts on a guard trip, because the trip runs entirely through `guard.ts`. It is
a trap for a fixture that asserts on anything else time-derived, such as a logged
duration, which would still read real time inside a fake-clock test and diverge.

So the plan must grep `performance.now` and `Date.now` across the whole runtime
and state directories, then for each surviving read decide one of two things: it
cannot affect a fixture's observable result, or it can and must be listed as a
known divergence. The `sleep()` carve-out below is one entry on that list, not
the whole list.

The helper reads the clock through the lax store accessor and falls back to the
real clock. `agencyStore.getStore()` returns `undefined` outside a frame rather
than throwing:

```ts
private clock(): Clock {
  return agencyStore.getStore()?.ctx?.clock ?? realClock;
}
```

The fallback is not decoration. A time guard can revive from a checkpoint outside
an execution frame, and the strict `getRuntimeContext()` throws there. A revived
guard with no frame meters against real time, exactly as it does today. So this
resolves cleanly rather than crashing.

The call sites change shape but not behavior. A read like

```ts
this.windowStart = performance.now();
```

becomes

```ts
this.windowStart = this.clock().now();
```

The arming site keeps its whole callback body and only changes what schedules it:

```ts
this.timerHandle = this.clock().setTimer(() => {
  const spent = this.elapsedMs +
    (this.windowStart !== undefined ? this.clock().now() - this.windowStart : 0);
  this.controller?.abort(new AgencyCancelledError(/* unchanged */));
}, delay);
```

And cancellation:

```ts
this.clock().clearTimer(this.timerHandle);   // was: clearTimeout(this.timerHandle)
```

### Turning it on per fixture

A fixture asks for the fake clock in its `.test.json`, on the individual test
case, next to where `llmMocks` already lives:

```json
{
  "nodeName": "overshootIsCoveredByTheGrant",
  "fakeClock": true,
  "expectedOutput": "\"done:spun\"",
  "evaluationCriteria": [{ "type": "exact" }]
}
```

This mirrors how `llmMocks` already flows. The test runner reads `fakeClock` from
the test case and passes it to the run the same way it passes the mock list. When
the flag is set, the run constructs the `RuntimeContext` with a `FakeClock`
instead of the default `realClock`.

The flag is per test case, not per file, so one file can hold both fake-clock and
real-clock tests. Fixtures that do not set it keep the real clock and keep
passing without any change. The flag is permanent: a fixture that genuinely wants
to measure real elapsed time simply never sets it.

### The _advanceTime function

`_advanceTime` lives in `stdlib/date.agency`, and it follows the test-seam
pattern already set by `_installSlowInput` in `stdlib/thread.agency`. That
existing seam lets guard fixtures simulate a slow human without touching stdin,
and it is imported the same way this one is. The shared shape:

- a plain `def`, not `export def`, so a normal `import` cannot see it
- a leading underscore, matching `_installSlowInput`
- reached only through `import test { _advanceTime } from "std::date"`
- a docstring that opens with "Test-only:"
- a thin Agency wrapper over a TypeScript helper

The choice of `std::date` is deliberate. It is not useful there yet, because you
cannot fast-forward a real clock, so `_advanceTime` is test-only for now. But it
sits next to where the production-useful reads, `now` and `elapsedTime`, will
land when [issue #609](https://github.com/egonSchiele/agency-lang/issues/609)
adds them. Promoting `_advanceTime` later, if that ever makes sense, is a rename
to `export def advanceTime`, not a move to another module.

Two things keep it out of production. The `import test` gate means a production
file, which uses a plain `import`, cannot see the symbol at all. And the
TypeScript helper behind it reads the clock from the runtime context and throws
if that clock is not a `FakeClock`:

```
_advanceTime() needs a fake clock. Set "fakeClock": true on this test case.
```

So a production run fails loudly rather than doing nothing, and a production file
cannot even reach the call. The helper, when the clock is fake, calls `advance`.

`_advanceTime(ms)` takes only the number of milliseconds. There is no firing cap,
because `advance()` cannot run away: it never arms a timer, and it removes one
timer per iteration, so it always ends after firing the currently-due timers.
The plan does not need to thread a cap value from the call site.

## What is deliberately out of scope

`_advanceTime` moves the guard's clock and fires guard timers. It does not
fast-forward `sleep()` or any other real awaited timer, because those do not go
through the guard clock. A fixture that calls `sleep(1000)` still waits a real
second. Routing `sleep` and other timers through the seam is a larger change and
is not needed to fix the time-guard fixtures.

Because of that scoping, `_advanceTime` is synchronous, and this follows directly
from how a guard timer fires. Firing one only calls `controller.abort(...)`,
which sets a flag; it starts no promise and re-arms nothing. The runtime reads
that abort at its next synchronization point, and the re-arm and the guard's
`check()` both run later at a runner step, outside `_advanceTime`. So `advance()`
has nothing to await. The plan should confirm this with a test early: if a
fixture ever needs fake time to interact with awaited work, an async variant
would be the follow-up, the way vitest ships both `advanceTimersByTime` and
`advanceTimersByTimeAsync`.

This feature does not expose any clock reads to Agency programs or to the public
`agency.*` TypeScript helper namespace. Those belong to the `elapsedTime` work in
[issue #609](https://github.com/egonSchiele/agency-lang/issues/609). This spec
only lays the seam that work will reuse.

## Testing

Every claim above needs a test that fails before the change and passes after.

Deterministic trip. A `guard(time: 100ms)` block that calls `_advanceTime(200)`
trips, and one that calls `_advanceTime(50)` does not. Neither spends real time.

The bug the slow fixture guards. The reduced `overshootIsCoveredByTheGrant`
fixture must still fail when the fix in `stdlib/supervise.agency` is reverted to
`grant = nextInterval`. This is the load-bearing check: the whole point is a
faster test that still catches the same regression. The test plan must run the
fixture against a deliberately reverted build and confirm it fails. Because the
design's correctness rests on the exact interleaving traced above, not on the
firing loop, this test is not optional.

Concurrent due timers. Two nested guards, or two `fork` branches each with a time
guard, both past their limits when `_advanceTime` runs: both trip in the one call.
This is the case the firing loop exists for, now that a single guard fires once.

The opt-out. A fixture with no `fakeClock` flag keeps the real clock: a guard in
it trips on real elapsed time, and `_advanceTime` in it throws the clear error.

Revive with no frame. A guard revived from a checkpoint outside an execution
frame falls back to the real clock instead of throwing.

Existing fixtures. Every current time-guard and supervise fixture keeps passing
untouched, since none of them set the flag.

## Migration

Convert the slow fixtures to the fake clock, starting with the ones this
investigation flagged, largest first:

- `tests/agency/supervise/supervise.agency` (70s today)
- the `tests/agency/subprocess/nested-pause-*` fixtures
- the `tests/agency/guards/*` time fixtures

Each conversion swaps a `spin(...)` for an `_advanceTime(...)` and adds
`fakeClock: true` to the affected test cases. Convert only fixtures whose slowness
comes from spinning down a guard clock. Leave the rest alone.

## Files touched

- `lib/runtime/clock.ts` — new: `Clock` type, `realClock`, `FakeClock`.
- `lib/runtime/state/context.ts` — `RuntimeContext` gains an optional `clock`,
  defaulting to `realClock`.
- `lib/runtime/guard.ts` — the six time reads, one `setTimeout`, and one
  `clearTimeout` route through a `clock()` helper.
- `stdlib/date.agency` — the `_advanceTime` test seam and its TypeScript backing.
- `lib/cli/test.ts` — read `fakeClock` off the test case and install a
  `FakeClock` on the run.
- The migrated fixtures.
```
