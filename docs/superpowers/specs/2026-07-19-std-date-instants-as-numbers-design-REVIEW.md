# Review — std::date: instants as numbers (PR 1 of the elapsedTime work)

Reviewed against the current `lib/stdlib/date.ts`, `stdlib/date.agency`, the
functions guide, and the in-repo consumers — not just on the spec's own terms.

The core idea is sound and well-argued: an instant is a point on the timeline and
wants to be a number; a calendar date is a whole day whose identity depends on
where you stand and honestly wants to stay a string. Splitting the fifteen
functions along that line, dissolving the `add*` helpers into operators, and
bridging the two worlds with `format`/`formatDate`/`parse` is a clean shape. The
PR1/PR2 split, the independence from #575, and the YAGNI call on a pattern
mini-language are all good judgment.

Two things I checked and can confirm the spec got right:
- **The `t + Nd` migration is behavior-preserving.** `_addDays` is
  `_addMinutes(dt, days*24*60)` → `_add` → `d.setTime(d.getTime() + ms)`: pure
  fixed-millisecond arithmetic, never calendar-aware. So `addDays(t, 3)` really is
  `t + 3d` with no DST discrepancy. In fact the new world is arguably *more*
  correct across a DST boundary: today `_add` carries the source string's stale
  offset via `extractOffset`, whereas `format(x, tz)` re-derives the right offset
  for that instant. Worth stating this in the migration note as reassurance.
- **The duration-literal claim holds.** `2h` is a plain number literal
  (`canonicalValue: 7200000`), so `now() + 2h` is ordinary arithmetic once `now()`
  is a number.

The findings below are ordered most-consequential first. The first two are the
ones I'd want resolved before this goes to a plan.

---

## 🔴 The `instant: number = now()` default may not be implementable

Every one of the six boundary functions is specified with a **function call as a
default parameter value**:

```
startOfDay(instant: number = now(), timezone: string = ""): number
```

I could not find a single stdlib function that uses a function-call default — a
grep across `stdlib/*.agency` turns up only literal defaults (`= ""`, `= 2`,
`= true`), and the functions guide (`docs/site/guide/functions.md:45`) shows only
literal defaults. That's strong evidence the language supports constant defaults
only, not arbitrary call expressions evaluated per call.

This is load-bearing: the spec leans on `= now()` for all six boundary functions,
and it's sold as the ergonomic win ("defaults to now()"). If call-defaults aren't
supported, the design needs a different shape — e.g. an optional `instant?: number`
resolved in the body (`const at = instant ?? _now()`), or a required instant with
`startOfDay(now(), tz)` always spelled out. Each has ergonomic and typing
consequences worth deciding on purpose.

Please verify this against the compiler early (write `def f(x: number = now()) {}`
and run `agency ast` / typecheck) and, if it's unsupported, pick the fallback shape
in the spec rather than leaving it for the plan to discover mid-implementation.

## 🟡 Instants and durations both become `number`, which erases the very distinction the design is built on

The "insight that shapes the whole design" is that an instant and a duration are
different concepts. But in the type system after this change, both are `number`.
The compiler cannot tell an instant from a duration, so all of these typecheck and
run to silent nonsense:

```
now() + now()            // adding two instants — meaningless
startOfDay(30m, tz)      // a duration where an instant is expected
deadline - 2h - now()    // easy to write, wrong, and green
```

This is a real and defensible trade — it's exactly how `Date.now() + ms` works in
JS, and it's what makes `now() + 2h` read well — but the spec currently presents
the instant/duration distinction as its foundation while the implementation
collapses it. Name the trade explicitly: "instants and durations are both `number`;
we buy arithmetic ergonomics at the cost of compile-time instant/duration safety."
If Agency had a nominal/branded number type this could be recovered, but it's
structural, so the collapse is pragmatic — just say so, so a reviewer weighs it
with eyes open rather than discovering it from an example.

## 🟡 An instant is a worse tool result for an LLM than a string — decide what the LLM-facing surface returns

`std::date` docstrings become tool descriptions (per CLAUDE.md), and the whole
motivation here is agent-facing: PR2 hands `now()`/`elapsedTime` to an `llm()`
call. A tool that returns `1746451800000` gives the model an opaque integer it
can't read as a time, where `"2026-05-05T10:30:00-07:00"` is immediately legible.

In-repo this is currently safe — every agent file (`agent.agency`,
`coordinator.agency`, `repl.agency`) imports only `today()`, which stays a string —
so PR1 breaks nothing. But the design should state, now, that the LLM-callable
surface should hand back **formatted strings** (`format(x, tz)`), not raw instants,
and that `now()`-as-a-number is a math primitive, not a tool result. This shapes
PR2 and is cheap to note here. Otherwise the natural PR2 move — expose `now()` to
the model — quietly regresses agent legibility.

## 🟡 `parse` has no specified failure mode

`parse(iso): number` is described as "how external data and user input become
numbers" — i.e. it consumes untrusted input — but the spec never says what happens
on malformed input. If it returns `NaN`, that silently poisons every downstream
`+`/`-`/comparison with no error at the point of the mistake. Specify the contract:
throw (so the guard/failure machinery converts it to a `Failure` the caller can
handle), or return a `Result<number>`. Given this is the untrusted-input door, a
loud failure is the safe default. This belongs in the spec, not the plan, because
it's a public-API contract.

## 🟢 format/parse sub-second round-trip — recommend emitting milliseconds

The spec already flags that `format` emits no sub-second digits, so
`parse(format(now()))` truncates to the whole second, and defers the decision to
the plan. Lean toward `format` emitting `.SSS`: `now()` is `Date.now()` with
millisecond precision, and a lossy format→parse round-trip is a surprise waiting to
bite an `elapsedTime` test that captures `now()`, formats it into a log, parses it
back, and finds a sub-second drift. If you deliberately keep second precision,
truncate `now()` to the second too, so the two are consistent rather than
"now() has ms but its round-trip doesn't."

## 🟢 The dropped `now()` timezone parameter isn't in the migration note

The changelog covers the return-type change but not that `now()` loses its
`timezone` parameter. `now("America/New_York")` in existing code will fail to
typecheck after this. Add one line to the migration note.

## 🟢 Test-plan gaps around the actual risk (timezones and DST)

Date math's whole risk surface is timezones and DST, and the test plan is light
there:
- No DST-transition case. `startOfDay`/`endOfDay` on a spring-forward day (where
  midnight-to-midnight is 23 hours) is exactly where a fixed-ms assumption would
  show. Add one.
- `startOfWeek`/`endOfWeek` never pin which day the week starts on (Sunday vs
  Monday). That's a silent convention; assert it so it can't drift.

---

## Smaller notes

- **`nextDayOfWeek(day: DayOfWeek, ...)`** in the API table vs
  `nextDayOfWeek("monday", tz)` in the examples — confirm `DayOfWeek` is the real
  parameter type (a string-literal union?) and that the string examples match it.
- **`format`/`parse` are very generic names** for a module that may be used
  unqualified. Not a blocker if callers import qualified, but worth a moment's
  thought about collisions with a future string-`format`.
- **`startOfDay` internal coupling** (spec's TS-layer note) is described correctly:
  `_formatDate` first, then `_atTime(thatDate, "00:00:00", tz)`. Good that the spec
  calls out implementing `_formatDate` first — the boundary helpers genuinely
  depend on it.
