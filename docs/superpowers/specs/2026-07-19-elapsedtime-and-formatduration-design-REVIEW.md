# Review — elapsedTime and formatDuration (PR 2 of #609)

Reviewed against the merged #618 (fake clock) and #620 (date-as-numbers) code in
this worktree, not just on the spec's own terms.

The design is sound and the two-function split is a genuinely good call: `elapsedTime`
as the millisecond math primitive that composes (`elapsedTime(start) > 5m`), and
`formatDuration` as the separate legibility layer. The epistemic honesty in piece 4 —
flagging the zero-unbound-partial path as unverified, with three escalating checks and
a named fallback — is exactly how an unknown should be handled in a spec.

Things I checked and can confirm the spec got right:
- **`wallTime()` is the correct seam, and the determinism math holds.** `realClock.wallTime()`
  is `Date.now()`; `FakeClock.wallTime()` is `wallBaseMs + monotonicMs`; and
  `_advanceTime` moves `monotonicMs` (clock.ts:81), so `wallTime()` tracks it. In
  `elapsedTime = now() - since`, the base cancels, so `elapsedTime(start) == 500`
  after `_advanceTime(500)` is exact regardless of the seed. Good.
- **The lax `__ctx()` + `?? realClock` fallback preserves frameless behavior** — the
  same proven pattern the time guard uses, so the existing frameless date unit tests
  keep reading `Date.now()`.
- **The routing scope is right.** Only the four current-time reads (`now`, `today`,
  `tomorrow`, `nextDayOfWeek`) need the seam; `startOfDay`/`atTime` take explicit
  instants and compose deterministically once `now()` is faked.
- **The `formatDuration` table is internally consistent** (I checked the arithmetic —
  90061000 ms = 1d 1h 1m 1s, etc.).

Findings below, most consequential first.

---

## 🔴 Seeding `wallBaseMs` breaks #618's `clock.test.ts`, and the spec doesn't mention it

Piece 3 says seed `FakeClock.wallBaseMs` to `Date.UTC(2026, 0, 1)`. That's the right
call for sane faked absolute dates (and the #618 author's own comment at clock.ts:28
anticipated exactly this). But it changes what `wallTime()` returns at construction,
and `clock.test.ts` pins that:

```
clock.test.ts:8    expect(clock.wallTime()).toBe(0);
clock.test.ts:11   expect(clock.wallTime()).toBe(200);   // after advance(200)
```

With the seed, those become `Date.UTC(2026,0,1)` and `Date.UTC(2026,0,1) + 200`, so
both assertions fail. The spec's testing section says only "Confirm the existing
`date.test.ts` still passes untouched" — it omits `clock.test.ts`, which will fail
and whose `wallTime()` assertions must be updated (to `wallBaseMs` and
`wallBaseMs + 200`, ideally referencing the same named constant the seed uses).

This is a required, currently-unlisted change. Two asks:
- Add `clock.test.ts` to the spec's "files touched / tests to update" and state the
  new expected values.
- Note that once date.ts reads `wallTime()`, those assertions become load-bearing
  (the #618 comment "nothing calls wallTime() in this feature" stops being true), so
  the seed should be a single shared constant, not a literal duplicated between
  `clock.ts` and the test.

## 🟡 The motivating example hands the model the *less* legible surface

The spec's headline call is `tools: [elapsedTime.partial(since: start)]`, which gives
the model a tool returning a raw millisecond count like `332000`. But the design's own
principle (quoting PR 1) is "the surface an agent calls should be legible," and the
research motivation is to give the model a *sense* of time — which `"5m 32s"` serves
far better than `332000`. The spec even says a legible answer means wrapping in
`formatDuration` (line 38), then defaults the primary example to the unwrapped form.

`formatDuration` exists but there's no partial-applicable *formatted* tool — every
agent caller has to compose `formatDuration(elapsedTime(since))` themselves, and
`.partial` doesn't obviously compose across two functions. Given the whole PR is
motivated by agent legibility, the spec should decide what the *recommended agent
tool* returns, and probably provide the composed, partial-able formatted duration as
the blessed agent surface — leaving raw `elapsedTime` as the code-path primitive.
Right now the artifact the motivation cares most about is the one the design leaves
to the caller.

## 🟡 Prove piece 4 first — it can change `elapsedTime`'s signature

The spec says prove the zero-unbound-partial path "early," and the fallback if it's
unsupported is "an agent-facing wrapper takes a dummy or keeps one nominal parameter."
That fallback changes the *public signature* of the agent surface — so it can't be a
late discovery. Make the sequencing explicit: the plan should run the three piece-4
checks before finalizing pieces 1–2, because a negative result reshapes the API, not
just the plumbing. (Worth noting the "keep a nominal parameter" fallback is awkward
for this exact use case — the model doesn't know `start`, so a nominal param it must
fill is close to unusable; if the direct path fails, the composed-formatted-tool
question above and this one probably want solving together.)

## 🟢 `formatDuration` negative-zero edge is unspecified

A negative sub-second duration — say `-500` — has `floor(|ms|/1000) == 0`, so all
units are zero. The rules say "if every unit is zero, emit `0s`" and separately "a
negative duration gets a leading `-`." Which wins: `"0s"` or `"-0s"`? Specify it (it
should be `"0s"` — no negative zero), and add `-500 → "0s"` to the test boundaries so
it can't regress.

## 🟢 Name `clockNow()` so an implementer can't reach for `.now()`

The helper is `clockNow()` but it reads the clock's `wallTime()`, not its `now()`
(which is the monotonic guard clock). The names are close enough that an implementer
routing date reads could plausibly call `.now()` and silently meter date math against
the monotonic clock. Rename to something like `wallClockNow()`, or add a one-line
comment saying "wall time, not the monotonic `now()`," so the distinction is loud.

## 🟢 Confirm no import cycle from date.ts → runtime

`date.ts` will import `__ctx` and `realClock` from `lib/runtime/*`. The guard already
does this so the pattern is fine, but `date.ts` is stdlib and hasn't depended on the
runtime clock before — the plan should confirm `lib/runtime` doesn't import
`lib/stdlib/date` back (low risk, quick grep).

---

## Out-of-scope calls look right

Leaving `today`/`tomorrow`/`nextDayOfWeek` as calendar strings (gaining only
fake-clock awareness), dropping `subtract` in favor of `-`, and deferring per-test
seed control are all reasonable. The one I'd double-check against the agent-legibility
point above: "weeks/months out of scope" is fine, but make sure the day cap in
`formatDuration` is documented in the tool docstring, since a multi-day agent session
reading `"40d"` is the exact scenario this feature targets.
