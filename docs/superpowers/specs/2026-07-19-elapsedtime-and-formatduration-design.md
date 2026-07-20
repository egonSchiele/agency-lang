# elapsedTime and formatDuration (PR 2 of #609)

## Background

PR 1 (#620, merged) changed `std::date` so an instant is a number — epoch
milliseconds. That was the groundwork for the thing #609 actually asked for: a
way for an agent to ask "how long have I been working."

The motivation is agent-facing, and the research behind it is one-sided. Giving a
model a sense of elapsed time materially changes its behavior — it stops earlier
when it is not converging, and it scales its effort to the budget. The single
most-validated mechanism is a tool the agent pulls: `get_duration()`, called
whenever the model wants to check the clock. So the shape we want is a function an
agent can call, partially applied with the moment work began:

```
const start = now()
const res = llm(prompt, tools: [elapsedTime.partial(since: start)])
```

This PR adds that function, a companion that renders a duration for humans, and
the plumbing that makes both testable.

### The decision this design rests on

`elapsedTime` exists to be handed to a model, so it returns a **readable string**,
not a number. A model reads `"5m 32s"` immediately; `332000` is an opaque integer.
This is PR 1's rule applied directly: the surface an agent calls is legible.

Two functions, one built on the other:

- `elapsedTime(since): string` is the agent-facing function. It returns a
  human-readable duration like `"5m 32s"` — literally `formatDuration(now() - since)`.
- `formatDuration(ms): string` is the general renderer underneath it. It turns any
  millisecond duration into that same human string, so it is useful on its own for
  rendering a computed duration (`formatDuration(deadline - start)`), not only "time
  since now".

The raw number is still available with no function at all: `now() - since` is the
milliseconds, and `elapsedTime(start) > 5m` becomes `now() - start > 5m` when a
program needs to compare rather than display. So nothing is lost by making
`elapsedTime` return a string — the number was always one subtraction away.

## The four pieces

### 1. `elapsedTime`

```
export def elapsedTime(since: number): string {
  return formatDuration(now() - since)
}
```

`since` is an instant (a number, post-#620). The result is a readable duration
from `since` to now, e.g. `"5m 32s"`. If `since` is in the future the string is
negative, e.g. `"-5m 32s"`. It lives in `stdlib/date.agency` beside `now`/`format`.

The docstring is the tool description a model sees, so it says what the string
means: "Returns how long has elapsed since the given instant, as a readable
duration like \"5m 32s\"." A program that needs the raw milliseconds writes
`now() - since` instead.

### 2. `formatDuration`

```
export def formatDuration(ms: number): string
```

Renders a millisecond duration as a compact human string. The exact format:

- Work in whole seconds: `totalSeconds = floor(|ms| / 1000)`.
- Split into days, hours, minutes, seconds.
- Emit each unit whose value is greater than zero, largest to smallest, joined by
  a single space, with a one-letter suffix: `d`, `h`, `m`, `s`.
- If every unit is zero (the duration is under one second), emit `"0s"`.
- A negative duration gets a leading `-` on the whole string — EXCEPT there is no
  negative zero: if the magnitude rounds to `"0s"` (a sub-second negative like
  `-500`), the result is `"0s"`, not `"-0s"`. The `-` is only added when there is a
  non-zero unit to sign.

Worked examples:

| ms | result |
| --- | --- |
| 332000 | `"5m 32s"` |
| 3661000 | `"1h 1m 1s"` |
| 3600000 | `"1h"` |
| 45000 | `"45s"` |
| 500 | `"0s"` |
| 90061000 | `"1d 1h 1m 1s"` |
| -332000 | `"-5m 32s"` |
| -500 | `"0s"` |

Deliberate limits, stated so they are decisions and not accidents:

- **Granularity stops at seconds.** Sub-second durations round down to `"0s"`.
  For "how long have I been working" that is the right resolution; a millisecond
  count is what `elapsedTime` is for.
- **Units stop at weeks.** A week is a fixed 7 days, so it is unambiguous; months
  are not (a month is not a fixed number of days), so the largest unit is `w` and
  there are no months. A 40-day duration reads `"5w 5d"`. (Owner's call on review:
  weeks, not days.)
- **Zero intermediate units are dropped, not shown.** `3600000 + 1000` is
  `"1h 1s"`, not `"1h 0m 1s"`. Compact over aligned.

`formatDuration` is a pure function of its input — no clock, no timezone — so it
lives in the TypeScript layer as `_formatDuration(ms)` with a thin wrapper, and
it unit-tests trivially.

### 3. Route `now()` through the fake-clock seam

Today `_now` calls `Date.now()`, and `_today`/`_tomorrow`/`_nextDayOfWeek` call
`new Date()`. None of them are affected by the fake clock #575 added, so a fixture
that sets `fakeClock: true` and advances time would still see the real wall clock
from `now()` — and an `elapsedTime` test could not be deterministic.

Route every current-time read in `lib/stdlib/date.ts` through the clock on the
runtime context, exactly as the time guard does. Add one helper — named to make
loud that it reads WALL time, not the monotonic guard clock:

```ts
// The current WALL-CLOCK instant (epoch ms), through the runtime clock so a
// fake clock can drive it. NOT clock.now() — that is the monotonic guard clock;
// date math must meter against wall time.
function wallClockNow(): number {
  return (__ctx()?.clock ?? realClock).wallTime();
}
```

`__ctx()` (from `lib/runtime/asyncContext.ts`) is the lax context accessor,
returning `undefined` outside an execution frame; the `?? realClock` fallback then
reads `Date.now()`, so anything running frameless (including the existing date
unit tests, which call `_now()` with no frame) behaves exactly as before.

Then:
- `_now()` returns `wallClockNow()` instead of `Date.now()`.
- The three `new Date()` current-time reads become `new Date(wallClockNow())`.

Under `fakeClock: true`, `now()` reads the `FakeClock`'s `wallTime()`, so
`_advanceTime(ms)` moves it and `elapsedTime` is exact.

**Seed the fake clock's wall base — and update #618's clock test.** `FakeClock.wallBaseMs`
is `0` today, so a faked `now()` reads as 1 January 1970 — fine for a difference
like `elapsedTime` (the base cancels), but a fixture that reads `today()` or
`format(now())` under a fake clock would get 1970. Seed `wallBaseMs` to a fixed,
realistic epoch so a faked absolute date is sane.

There is a consequence the plan MUST handle: `lib/runtime/clock.test.ts` (from
#618) pins `wallTime()` at construction and after an advance:

```
clock.test.ts:8    expect(clock.wallTime()).toBe(0);
clock.test.ts:11   expect(clock.wallTime()).toBe(200);   // after advance(200)
```

Seeding makes those `wallBaseMs` and `wallBaseMs + 200`, so both assertions fail
and must be updated. And once `date.ts` reads `wallTime()`, those assertions stop
being incidental (the #618 comment "nothing calls wallTime() in this feature" is
no longer true), so the seed must be a **single shared constant** — export it from
`clock.ts` (e.g. `FAKE_CLOCK_WALL_BASE_MS = Date.UTC(2026, 0, 1)`), have `wallBaseMs`
initialize from it, and reference the same constant in `clock.test.ts` rather than
duplicating a literal. This only affects `wallTime()` readers; guards meter against
the monotonic clock and are untouched. Per-test control of the seed is out of scope.

### 4. The agent pull, and partial application with zero unbound parameters

The motivating call is `elapsedTime.partial(since: start)`, which binds the only
parameter and leaves a function with **zero** unbound parameters, handed to
`llm(...)` as a tool the model calls with no arguments. Because `elapsedTime` now
returns a readable string, that tool hands the model `"5m 32s"` directly — the
legible agent surface, no separate formatted wrapper needed. This is the whole
point of the string return type: the blessed agent tool IS `elapsedTime.partial`.

This is the one part of the design whose end-to-end behavior is unverified, and it
is unverified in a way that can change the public API, so **the plan must run these
checks FIRST — before finalizing pieces 1 and 2.** The runtime's `.partial()` does
not forbid binding every parameter (checked in an earlier investigation), but
whether a zero-parameter tool survives tool-schema generation and an actual model
tool call was never confirmed. If it fails, the fallback ("keep one nominal
parameter") reshapes `elapsedTime`'s signature and its whole ergonomics — and that
fallback is especially bad here, because the model does not know `start`, so a
nominal parameter it must fill is close to unusable. A negative result is not a
plumbing detail to discover late; it forces an API decision. Prove:

- A zero-argument partial is callable and returns the right value:
  `elapsedTime.partial(since: start)()` equals `elapsedTime(start)` — the readable
  duration string.
- The tool definition generated for that partial is well-formed with an empty
  parameter set — the JSON schema a model would be given.
- A model can invoke it end to end: an execution test using the deterministic LLM
  provider, with a mock that issues a tool call to the zero-argument tool, and an
  assertion that the call returns the duration string.

If any of these fails — most likely the schema or the tool-call path rejecting a
zero-parameter tool — that is a real fix, and it lives in the tool-registration or
schema code, not in `std::date`. The plan should treat that as a branch to handle,
not assume away. If it turns out zero-unbound tools are genuinely unsupported and
the fix is large, the fallback is to document that an agent-facing wrapper takes a
dummy or keeps one nominal parameter — but only if the direct path proves
infeasible.

## Testing

- `_formatDuration`: the table above, plus the exact boundaries — 999 ms → `"0s"`,
  1000 ms → `"1s"`, 59_999 ms → `"59s"`, 86_400_000 ms → `"1d"`, `-332000` →
  `"-5m 32s"`, and the negative-zero case `-500` → `"0s"` (not `"-0s"`).
- `elapsedTime` determinism under the fake clock: an agency execution test with
  `fakeClock: true` that captures `const start = now()`, calls
  `_advanceTime(65000)`, and asserts `elapsedTime(start) == "1m 5s"`. (65 seconds,
  not a sub-second amount, so the readable string is meaningful rather than
  `"0s"`.) This is the test PR 1 could not write. Also assert the raw math is exact
  with a second capture: `now() - start == 65000`.
- `now()` through the seam: under `fakeClock: true`, `now()` reflects
  `_advanceTime`; frameless (the existing date unit tests) it still reads the real
  clock. Confirm the existing `__tests__/date.test.ts` still passes untouched.
- The wall-base seed: under a fake clock, `formatDate(now())` reads the seeded 2026
  date, not 1970. And `clock.test.ts`'s two `wallTime()` assertions are updated to
  the shared constant and still pass.
- The agent pull: the three checks in piece 4.
- No import cycle: a quick grep confirming `lib/runtime` does not import
  `lib/stdlib/date` back (checked — it does not today, but the plan reconfirms it,
  since `date.ts` newly depends on `lib/runtime`).

## Out of scope

- Changing how `today`/`tomorrow`/`nextDayOfWeek` present (they stay calendar-date
  strings; they only gain fake-clock awareness via `wallClockNow()`).
- A `subtract` function — with numbers, subtraction is the `-` operator (#609's
  original question, resolved by PR 1).
- Per-test seeding of the fake clock's wall base; a fixed constant is enough.
- Months in `formatDuration` (ambiguous; weeks are the largest unit), and
  sub-second granularity.
