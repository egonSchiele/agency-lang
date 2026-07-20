# std::date: instants as numbers (PR 1 of the elapsedTime work)

## Background

`std::date` is Agency's date-and-time library. Today it has fifteen functions,
and every one of them takes and returns ISO 8601 strings. `now()` gives you
`"2026-05-05T10:30:00-07:00"`. `today()` gives you `"2026-05-05"`. `add(dt, ms)`
takes a datetime string and a number of milliseconds and hands back another
string.

This came up because we want an `elapsedTime` function (issue #609) so an agent
can ask "how long have I been working." The natural shape is `now() - since`.
But `now()` returns a string, and you cannot subtract two strings. So before
`elapsedTime` can exist, the library needs a representation you can do math on.

This spec is the first of two. It changes how `std::date` represents time. A
second spec adds `elapsedTime` and the agent-facing wiring on top. Keeping them
separate means each pull request is one coherent thing: this one is a
foundational refactor of an existing library; the next is a small new feature.

### The insight that shapes the whole design

When you sort the fifteen functions by what they actually mean, `std::date` is
mixing two different concepts, and only one of them wants to be a number.

An **instant** is a specific moment in time. "Now." "The start of today." "9am
on this date." A moment is a point on an absolute timeline, and the honest
representation is a count from a fixed origin — epoch milliseconds, the number of
milliseconds since 1 January 1970 UTC. This is what `Date.now()` returns, and it
is the same unit `add(dt, ms)` already accepts. You can subtract two instants to
get a duration. You can add a duration to an instant to get another instant.
Numbers are exactly right for this.

A **calendar date** is a day with no moment attached. "Today." "Next Monday."
A calendar date is not a point on the timeline — it is a whole day, and *which*
day depends on where you are standing. It is 5 May in New York for five hours
while it is already 6 May in Tokyo. The honest representation is a string like
`"2026-05-05"`. Forcing a calendar date into a number means answering a question
the date does not contain: which instant stands for this day? Midnight in which
timezone? Any answer is arbitrary.

So the design is not "move everything to numbers." It is: **instants become
numbers, calendar dates stay strings, the arithmetic helpers dissolve into
operators, and two small bridge functions connect the two worlds.**

### The trade this makes, stated plainly

The design leans on the instant-versus-duration distinction as its motivation,
but the type system will not preserve it. An instant (epoch ms) and a duration
(the value `2h` evaluates to, 7200000) are both `number`, and the compiler cannot
tell them apart. So all of these typecheck and run to silent nonsense:

```
now() + now()          // adding two instants — meaningless, but green
startOfDay(30m, tz)    // a duration where an instant is expected — green
deadline - 2h - now()  // easy to write, wrong, and green
```

This is a real and deliberate trade. We buy the arithmetic ergonomics —
`now() + 2h` reading like plain math — at the cost of compile-time
instant/duration safety. It is exactly how `Date.now() + ms` works in JavaScript,
so it will feel familiar, and it is the reason the whole simplification is
possible. If Agency had a nominal or branded number type we could keep both the
ergonomics and the safety, but it does not, so the collapse is structural and
we accept it with eyes open. It is worth knowing this is the one place the design
does not fully honor its own founding distinction.

## The taxonomy

| Function today | Returns today | Concept | After this change |
| --- | --- | --- | --- |
| `now(tz)` | datetime string | instant | **number** (epoch ms), `tz` dropped |
| `startOfDay` / `endOfDay` | datetime string | instant | **number** |
| `startOfWeek` / `endOfWeek` | datetime string | instant | **number** |
| `startOfMonth` / `endOfMonth` | datetime string | instant | **number** |
| `atTime(date, time, tz)` | datetime string | instant | **number** |
| `today(tz)` | `"YYYY-MM-DD"` | calendar date | **unchanged** (still a string) |
| `tomorrow(tz)` | `"YYYY-MM-DD"` | calendar date | **unchanged** (still a string) |
| `nextDayOfWeek(day, tz)` | `"YYYY-MM-DD"` | calendar date | **unchanged** (still a string) |
| `add` / `addMinutes` / `addHours` / `addDays` | datetime string | arithmetic | **removed** (use `+`) |
| — | — | bridge | **new:** `format(ms, tz)` → string |
| — | — | bridge | **new:** `formatDate(ms, tz)` → string |
| — | — | bridge | **new:** `parse(iso)` → number |

### Why the arithmetic helpers can just disappear

Agency already has duration literals, and they are ordinary numbers in an
expression. `2h` parses to `7200000`. `30m` parses to `1800000`. `7d` parses to
`604800000`. (Confirmed by running `agency ast` on `let x = 2h`, which yields a
number literal with `canonicalValue: 7200000`.)

Once an instant is a number, that means arithmetic on instants is just
arithmetic:

```
now() + 2h                  // two hours from now
now() - 30m                 // thirty minutes ago
deadline - now()            // milliseconds remaining
startOfDay(now(), tz) + 9h  // 9am today
```

So `add(dt, ms)` is `dt + ms`, `addHours(dt, n)` is `dt + n * 1h`, and there is
nothing left for those four functions to do. They are removed. The `subtract`
function issue #609 wondered about is likewise unnecessary — subtraction is `-`.

### How the two worlds compose

Calendar-date functions produce day strings. The instant world consumes them
through `atTime`, which takes a calendar date and a wall-clock time and pins them
to a moment:

```
atTime(nextDayOfWeek("monday", tz), "09:00", tz)   // the INSTANT of 9am next Monday
now() - startOfDay(now(), tz)                        // ms elapsed since midnight
format(startOfMonth(now(), tz), tz)                  // display the month boundary
formatDate(now(), tz)                                // which calendar date is it, in tz
```

`atTime` turns a date into an instant. `formatDate` turns an instant back into a
date. `format` turns an instant into a full display string. `parse` turns an
external ISO string into an instant. These four are the only places the two
representations meet, and each does exactly one conversion.

## The new API, function by function

Instants (return `number`, epoch milliseconds):

```
now(): number
  The current instant. No timezone parameter — an instant is absolute; a
  timezone only matters when you format it for a human.

atTime(date: string, time: string, timezone: string = ""): number
  The instant of a wall-clock time on a calendar date, in a timezone.
  atTime("2026-05-05", "09:00", "America/New_York") -> that morning's 9am.

startOfDay(instant?: number, timezone: string = ""): number
endOfDay(instant?: number, timezone: string = ""): number
startOfWeek(instant?: number, timezone: string = ""): number
endOfWeek(instant?: number, timezone: string = ""): number
startOfMonth(instant?: number, timezone: string = ""): number
endOfMonth(instant?: number, timezone: string = ""): number
  The boundary instant of the day/week/month CONTAINING the given instant, in
  the given timezone. The instant is optional and defaults to now().
  startOfDay(now(), tz) is midnight tonight where you are.
```

A note on how the "defaults to now()" is expressed. Agency does NOT support a
function call as a default parameter value — `def f(x: number = now())` fails to
parse ("expected `,` between parameters"), verified against the compiler. So the
instant is an **optional** parameter, resolved in the body:

```
def startOfDay(instant?: number, timezone: string = ""): number {
  const at = instant ?? now()
  // ... boundary of the day containing `at`, in `timezone`
}
```

`instant ?? now()` typechecks and runs (verified). Calling `startOfDay()` uses
now(); `startOfDay(now(), tz)` passes it explicitly; and because Agency has named
arguments, `startOfDay(timezone: "America/New_York")` sets the timezone while the
instant still defaults — so the optional-first parameter order does not block
setting only the timezone.

Calendar dates (return `string`, `"YYYY-MM-DD"`, unchanged):

```
today(timezone: string = ""): string
tomorrow(timezone: string = ""): string
nextDayOfWeek(day: DayOfWeek, timezone: string = ""): string
```

`DayOfWeek` is the existing exported string-literal union
(`"sunday" | "monday" | ... | "saturday"`), so the `"monday"` in the examples is
a value of that type, not a loose string. This type is unchanged.

Bridges (new):

```
format(ms: number, timezone: string = ""): string
  An instant as a full ISO 8601 string with milliseconds and offset, e.g.
  "2026-05-05T10:30:00.123-07:00". The inverse of parse for display.

formatDate(ms: number, timezone: string = ""): string
  An instant as the "YYYY-MM-DD" calendar date it falls on in the timezone.
  This is how an instant re-enters the calendar-date world.

parse(iso: string): number
  An ISO 8601 string as an instant. How external data and user input become
  numbers. Throws on input it cannot parse (see below).
```

**format carries milliseconds, so format/parse round-trips exactly.** `now()` is
`Date.now()`, which has millisecond precision, so `format` emits the `.SSS`
fraction and `parse(format(x, tz))` returns `x` exactly. This is a change from
the old string functions, which emitted whole seconds only. Emitting milliseconds
avoids a lossy round-trip — an `elapsedTime` value captured, formatted into a log,
and parsed back must not drift by up to a second. `parse` also accepts ISO strings
with no fractional part (treating them as `.000`), so external data without
milliseconds still works.

**parse fails loudly on bad input.** `parse` is the untrusted-input door, so a
malformed string must not silently become `NaN` and poison every downstream `+`,
`-`, and comparison with no error at the point of the mistake. `parse` throws on
input it cannot interpret as an ISO 8601 datetime. A throw is converted to an
Agency `Failure` by the runtime (the same path `_advanceTime`'s throw takes), so a
caller can handle it with `isFailure`, and an unhandled one surfaces at the parse
site rather than as a mysterious `NaN` three operations later.

Removed: `add`, `addMinutes`, `addHours`, `addDays`.

## Decisions, with the reasoning

These are settled unless the review says otherwise. Each is called out so a
reviewer can push back on the specific choice rather than the whole design.

**Boundary functions take an instant, not a calendar date.** `startOfDay` and
its siblings take a `number` (an instant, defaulting to `now()`) and return a
`number`. The common call is `startOfDay(now(), tz)`, and instant-in / instant-out
reads consistently. Someone holding a calendar-date string instead would convert
it with `atTime(dateString, "00:00", tz)` first. The alternative — having these
take a calendar-date string — was rejected because it would make the everyday
`startOfDay(now(), tz)` the awkward path.

**`format` has no pattern language; `formatDate` covers the common date-only
case.** Rather than a strftime-style `format(ms, tz, pattern)`, there are two
fixed functions: `format` for a full ISO datetime and `formatDate` for
`"YYYY-MM-DD"`. These match the two output shapes the old library already
produced. A pattern mini-language is real surface to design, document, and test,
and nothing here needs it yet (YAGNI). If a caller genuinely needs custom
formatting later, that is its own small addition.

**This PR does not depend on #575.** `elapsedTime` wants `now()` routed through
the fake-clock seam (the `wallTime()` method on the runtime clock) so time can be
faked in tests. That routing belongs to PR 2, which depends on #575 being merged.
This PR keeps `now()` reading `Date.now()` directly, so it can ship without
waiting on the fake-clock work. PR 2 will change that one line.

**Timezone parameters keep their existing default.** Every timezone-sensitive
function keeps `timezone: string = ""`, and an empty string means the local
timezone, exactly as today. `now()` is the one function that loses its timezone
parameter, because an instant does not have one.

**The names `format` and `parse` are kept, with the collision risk noted.** They
are generic, and a future `std::string` `format` or a JSON `parse` could clash if
someone imports unqualified. `std::date` is normally imported by explicit name
(`import { format } from "std::date"`), which scopes it, so this is an accepted
risk rather than a blocker. If the owner would rather avoid it entirely, the
alternative is `formatTime`/`parseTime`; flagging it here so the choice is
deliberate. Defaulting to `format`/`parse` for brevity.

## The TypeScript layer

The helpers live in `lib/stdlib/date.ts` and are called by the thin Agency
wrappers in `stdlib/date.agency`.

Change these to return `number` (epoch ms) instead of a string: `_now`,
`_atTime`, `_startOfDay`, `_endOfDay`, `_startOfWeek`, `_endOfWeek`,
`_startOfMonth`, `_endOfMonth`.

Add: `_format(ms, tz)`, `_formatDate(ms, tz)`, `_parse(iso)`.

Remove: `_add`, `_addMinutes`, `_addHours`, `_addDays`.

Leave unchanged (still return `"YYYY-MM-DD"` strings): `_today`, `_tomorrow`,
`_nextDayOfWeek`.

Note the internal coupling to preserve: `_startOfDay` today is implemented as
`_atTime(dateStr, "00:00:00", tz)`. After the change, `_startOfDay(instant, tz)`
must first find the calendar date the instant falls on in `tz` (that is
`_formatDate(instant, tz)`), then take midnight of that date
(`_atTime(that, "00:00:00", tz)`), and return the resulting number. The same
day-of pattern applies to the week and month boundaries. Implement `_formatDate`
first; the boundary helpers build on it.

## Consumers to migrate

The in-repo blast radius is small, because the most-used function internally is
`today()`, which stays a string.

- `lib/agents/agency-agent/agent.agency`, `.../lib/coordinator.agency`,
  `.../lib/repl.agency` — all import and use only `today()`. **No change needed**;
  `today()` still returns `"YYYY-MM-DD"`. Confirm during implementation that none
  of them also do date math.
- `tests/agency/memory/basic.agency` — uses `today()` as a string stamp. **No
  change needed.**
- `stdlib/calendar.agency` — references `tomorrow`/`atTime` only in a doc comment
  (line 32). Confirm it makes no code calls to changed functions; if it does,
  migrate them.
- `tests/integration/stdlib-sandbox/date.agency` — this is the one that breaks.
  It calls `now()` (expecting a string), `addDays`/`addHours`/`addMinutes`
  (removed), and `startOfDay`/`endOfDay` (now numbers). **Rewrite it** to exercise
  the new API: `now()` as a number, arithmetic via `+`/`-` with duration
  literals, boundary functions returning numbers, and the new `format`/
  `formatDate`/`parse` bridges. Its `.expected` output changes accordingly.

## Breaking change and changelog

This changes the public return types of a stdlib module, so it is a breaking
change for any Agency program that uses `std::date` instants. Ship a changelog
entry and a short migration note:

- `now()`, `atTime`, and the `startOf*`/`endOf*` functions now return a number
  (epoch milliseconds) instead of an ISO string. To display one, wrap it in
  `format(x, tz)`; to get its calendar date, `formatDate(x, tz)`.
- `now()` no longer takes a timezone parameter. `now("America/New_York")` will
  fail to typecheck — an instant is absolute; move the timezone to where you
  format it, e.g. `format(now(), "America/New_York")`.
- `add`, `addMinutes`, `addHours`, `addDays` are removed. Use `+` with duration
  literals: `add(t, ms)` becomes `t + ms`, `addHours(t, 2)` becomes `t + 2h`,
  `addDays(t, 3)` becomes `t + 3d`. This is behavior-preserving: the old `add*`
  helpers did pure fixed-millisecond arithmetic, never calendar-aware shifting,
  so `t + 3d` is exactly what `addDays(t, 3)` did. If anything the new form is
  more correct across a DST boundary, because `format` re-derives the right
  offset for the instant rather than carrying a source string's stale offset.
- To turn an ISO string from outside Agency into an instant, use `parse(iso)`.
  `parse` throws on input it cannot read.
- `today`, `tomorrow`, and `nextDayOfWeek` are unchanged.

The reference docs under `docs/site/stdlib/date.md` regenerate from the `.agency`
docstrings via `agency doc`; update the docstrings, not the generated page.

## Testing

- TypeScript unit tests in `lib/stdlib/date.test.ts` (or the existing date test
  file) for each changed and new helper: `_now` returns a number near
  `Date.now()`; `_parse(_format(x, tz))` returns `x` EXACTLY (millisecond
  round-trip, per the precision decision above); `_parse` throws on a malformed
  string; `_parse` accepts an ISO string with no fractional seconds; `_formatDate`
  returns the right calendar date across a timezone that shifts the day (an
  instant that is 5 May in New York but already 6 May in Tokyo); the removed
  helpers are gone.
- Timezone and DST are the real risk surface, so test them directly:
  - **A DST spring-forward day.** `_startOfDay` and `_endOfDay` on the day a
    timezone springs forward (where local midnight-to-midnight is 23 hours, not
    24) must return the correct local boundaries, not a fixed-24h offset. Pick a
    concrete zone and date (e.g. `America/New_York`, 8 March 2026) so the test is
    deterministic.
  - **The week-start convention.** `_startOfWeek`/`_endOfWeek` embed a silent
    choice of which day a week begins on (Sunday vs Monday). Assert it explicitly
    so it cannot drift, and state the chosen convention in the docstring.
- An Agency execution test exercising the composition examples: `now() - startOfDay(now(), tz)`
  is a non-negative number under a day of milliseconds; `atTime(nextDayOfWeek("monday", tz), "09:00", tz)`
  is a number; `format`/`parse` round-trip; `startOfDay()` with no argument equals
  `startOfDay(now())`.
- Rewrite the integration sandbox fixture and regenerate its expected output.

## A constraint PR 2 must honor: the LLM-facing surface returns strings, not instants

This is out of scope to build here, but it belongs in the design now because it
shapes PR 2 and is cheap to state. `std::date` docstrings become tool
descriptions, and the whole motivation is agent-facing. A number is the right
representation for *math*, but a terrible *tool result*: a model handed
`1746451800000` sees an opaque integer it cannot read as a time, where
`"2026-05-05T10:30:00-07:00"` is immediately legible.

So the rule for PR 2: the surface an agent calls hands back **formatted strings**
(`format(x, tz)`), and a raw instant number is a math primitive that stays inside
the program. `elapsedTime` for a model should return a formatted duration or a
number the docstring explains in a unit, not a bare millisecond count presented
as a timestamp. PR 1 breaks nothing here today — every in-repo agent file imports
only `today()`, which stays a string — but the natural PR 2 move of exposing
`now()` to the model directly would quietly regress legibility, so we rule it out
up front.

## Out of scope (PR 2)

- `elapsedTime(since)` and the `subtract`-is-just-`-` story.
- Routing `now()` through the `wallTime()` fake-clock seam from #575 so date
  reads are deterministic in tests.
- The agent-facing pull: `now()` captured at the start, `elapsedTime.partial(since:)`
  handed to an `llm()` call as a tool, and confirming partial application with
  zero remaining unbound parameters works end to end.
