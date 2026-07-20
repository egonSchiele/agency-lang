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

`elapsedTime(since)` is just `now() - since`, so the function has to earn its
place. The choice (made in brainstorming) is that it earns it two ways, split
across two functions:

- `elapsedTime(since): number` is the math primitive. It returns milliseconds, so
  it composes: `elapsedTime(start) > 5m` is a plain comparison.
- `formatDuration(ms): string` is the legibility layer. It turns a millisecond
  duration into a human string like `"5m 32s"`.

That split honors PR 1's rule — the surface an agent calls should be legible, a
raw instant is a math primitive — without forcing every caller through a
formatter. A code path that wants the number uses `elapsedTime` directly; an
agent tool that wants a readable answer wraps it in `formatDuration`, or hands the
model `elapsedTime` with a docstring that states the unit plainly.

## The four pieces

### 1. `elapsedTime`

```
export def elapsedTime(since: number): number {
  return now() - since
}
```

`since` is an instant (a number, post-#620). The result is milliseconds elapsed
from `since` to now. Positive when `since` is in the past; negative if `since` is
in the future. It lives in `stdlib/date.agency` beside `now`/`format`.

The docstring must state the unit, because this function is meant to be handed to
a model as a tool and the docstring becomes the tool description: "Returns the
number of milliseconds elapsed since the given instant."

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
- A negative duration gets a leading `-` on the whole string.

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

Deliberate limits, stated so they are decisions and not accidents:

- **Granularity stops at seconds.** Sub-second durations round down to `"0s"`.
  For "how long have I been working" that is the right resolution; a millisecond
  count is what `elapsedTime` is for.
- **Units stop at days.** Weeks and months are ambiguous (a month is not a fixed
  number of days), so the largest unit is `d`. A 40-day duration reads `"40d"`.
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
runtime context, exactly as the time guard does. Add one helper:

```ts
function clockNow(): number {
  return (__ctx()?.clock ?? realClock).wallTime();
}
```

`__ctx()` (from `lib/runtime/asyncContext.ts`) is the lax context accessor,
returning `undefined` outside an execution frame; the `?? realClock` fallback then
reads `Date.now()`, so anything running frameless (including the existing date
unit tests, which call `_now()` with no frame) behaves exactly as before.

Then:
- `_now()` returns `clockNow()` instead of `Date.now()`.
- The three `new Date()` current-time reads become `new Date(clockNow())`.

Under `fakeClock: true`, `now()` reads the `FakeClock`'s `wallTime()`, so
`_advanceTime(ms)` moves it and `elapsedTime` is exact.

**Seed the fake clock's wall base.** `FakeClock.wallBaseMs` is `0` today, so a
faked `now()` reads as 1 January 1970 — fine for a difference like `elapsedTime`
(the base cancels), but a fixture that reads `today()` or `format(now())` under a
fake clock would get 1970. Seed `wallBaseMs` to a fixed, realistic epoch (e.g.
`Date.UTC(2026, 0, 1)`) so a faked absolute date is sane. This only affects
`wallTime()` readers; guards meter against the monotonic clock and are untouched.
Per-test control of the seed is out of scope — a fixed constant is enough here.

### 4. The agent pull, and partial application with zero unbound parameters

The motivating call is `elapsedTime.partial(since: start)`, which binds the only
parameter and leaves a function with **zero** unbound parameters, handed to
`llm(...)` as a tool the model calls with no arguments.

This is the one part of the design whose end-to-end behavior is unverified. The
runtime's `.partial()` does not forbid binding every parameter (checked in an
earlier investigation), but whether a zero-parameter tool survives tool-schema
generation and an actual model tool call was never confirmed. So the plan must
prove it early:

- A zero-argument partial is callable and returns the right value:
  `elapsedTime.partial(since: start)()` equals `now() - start`.
- The tool definition generated for that partial is well-formed with an empty
  parameter set — the JSON schema a model would be given.
- A model can invoke it end to end: an execution test using the deterministic LLM
  provider, with a mock that issues a tool call to the zero-argument tool, and an
  assertion that the call returns the elapsed milliseconds.

If any of these fails — most likely the schema or the tool-call path rejecting a
zero-parameter tool — that is a real fix, and it lives in the tool-registration or
schema code, not in `std::date`. The plan should treat that as a branch to handle,
not assume away. If it turns out zero-unbound tools are genuinely unsupported and
the fix is large, the fallback is to document that an agent-facing wrapper takes a
dummy or keeps one nominal parameter — but only if the direct path proves
infeasible.

## Testing

- `_formatDuration`: the table above, plus the exact boundaries — 999 ms → `"0s"`,
  1000 ms → `"1s"`, 59_999 ms → `"59s"`, 86_400_000 ms → `"1d"`, and a negative.
- `elapsedTime` determinism under the fake clock: an agency execution test with
  `fakeClock: true` that captures `const start = now()`, calls `_advanceTime(500)`,
  and asserts `elapsedTime(start) == 500`. This is the test PR 1 could not write.
- `now()` through the seam: under `fakeClock: true`, `now()` reflects
  `_advanceTime`; frameless (the existing date unit tests) it still reads the real
  clock. Confirm the existing `__tests__/date.test.ts` still passes untouched.
- The wall-base seed: under a fake clock, `formatDate(now())` reads a 2026 date,
  not 1970.
- The agent pull: the three checks in piece 4.

## Out of scope

- Changing how `today`/`tomorrow`/`nextDayOfWeek` present (they stay calendar-date
  strings; they only gain fake-clock awareness via `clockNow()`).
- A `subtract` function — with numbers, subtraction is the `-` operator (#609's
  original question, resolved by PR 1).
- Per-test seeding of the fake clock's wall base; a fixed constant is enough.
- Weeks/months in `formatDuration`, and sub-second granularity.
