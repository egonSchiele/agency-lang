# Review — std::date: instants as numbers — Implementation Plan (PR 1)

Reviewed against the current `lib/stdlib/date.ts`, not just on its own terms. This
is a strong plan: it folded in essentially every finding from the spec review —
function-call defaults ruled out and replaced with `instant?: number` + `?? now()`,
`format` emits milliseconds, `parse` throws, the DST spring-forward and week-start
cases are tested, and the changelog covers the dropped `now()` timezone param and
notes the `add*` removal is behavior-preserving. The task order (bridges first,
because the boundary helpers depend on `_formatDate`) is right, and the TDD
red-first discipline is consistent.

Two things I verified rather than took on trust:
- **`parseToDate` genuinely throws** — `if (isNaN(d.getTime())) throw new Error(...)`
  — so `_parse`'s "fails loudly, never a silent NaN" contract holds and the
  Task 1 "throws on malformed" test will really fire.
- **The `_endOfMonth` date math is correct.** `new Date(year, month, 0)` with a
  1-indexed `month` (e.g. `5` for May) lands on May 31 via the 0-indexed-June /
  day-0 rollback, and `.getDate()` reads it stably. Good.

Findings below, most consequential first. The first three are worth resolving
before execution.

---

## 🟡 Task 4 commits a broken build

Task 4 removes `_add`/`_addMinutes`/`_addHours`/`_addDays` from `date.ts` and
commits, while `stdlib/date.agency` still imports those names until Task 5. At the
Task 4 commit, the compiled `stdlib/date.js` has a dangling import of `_add` from a
module that no longer exports it — a runtime-broken state.

Task 4 Step 3's "typecheck clean" is technically true but misleading: `tsc` doesn't
cover the `.agency → .js` runtime import, so the breakage isn't visible there. The
plan half-acknowledges this ("must land before any build"), but each task still
ends in its own commit, so the broken state is a real commit in the history.

Task 4 is four deletions. Fold it into Task 5 (remove the helpers and their wrappers
in the same commit) so every commit builds and is bisectable. If you keep it
separate for narrative reasons, at least drop the "typecheck clean" framing and say
plainly that this commit is intentionally non-building and only Task 5 restores it.

## 🟡 `endOfDay` returns `.000`, so `startOfDay ≤ now ≤ endOfDay` breaks in the last second — and the sandbox check is flaky

`endOfDay` is `_atTime(dateStr, "23:59:59", tz)` = 23:59:59**.000**, and Task 3's
test codifies exactly that. In the old string world an off-by-a-second end-of-day
was invisible. Now that instants are exact numbers and comparisons are exact, it
bites:

- Conceptually `endOfDay` is no longer the end of the day — it's up to 999 ms short
  of it. Anything doing `instant <= endOfDay(instant)` fails for any instant in the
  final second (23:59:59.001–.999).
- Concretely, Task 6's sandbox has `if (eod < n) { return "endOfDay failed" }` with
  `n = now()`. Run in the last second before midnight, `eod` (…59.000) < `n`
  (…59.500) and the fixture fails. Since PR1 uses the *real* clock (the fake-clock
  seam is PR2/#575), this is a genuine, if rare, flake.

Decide the intended semantics and make it consistent: either `endOfDay` returns
23:59:59.**999** (or next-day `startOfDay` minus 1 ms) so it truly bounds the day —
update the Task 3 literal to match — or, if `.000` is deliberate, loosen the sandbox
invariant so it can't flake at midnight. The same `.000` issue applies to
`endOfWeek` and `endOfMonth`; whatever you choose, apply it to all three.

## 🟡 Task 1 Step 3 uses the exact "ugly code" pattern anti-patterns.md bans

The `formatWithTimezone` change includes:
```ts
...(includeMillis ? { fractionalSecondDigits: 3 } : {}),
```
That is verbatim the `{ ...(cond ? {x} : {}) }` spread that
`docs/dev/anti-patterns.md` calls out under "Ugly code" with "Please never use this
pattern." `lint:structure` (just `eslint lib/`) won't catch it, so it needs a human
to catch it now. Build the Intl options object plainly instead — e.g. construct the
options object, then `if (includeMillis) options.fractionalSecondDigits = 3;` before
passing it to `Intl.DateTimeFormat`.

## 🟢 The week computation (and its new test) depend on the runner's local timezone

`_startOfWeek`/`_endOfWeek` do `new Date(dateStr + "T12:00:00Z").getDay()`, and
`getDay()` returns the weekday in the **runner's** local timezone, not `tz` and not
UTC. Noon UTC rolls into the next calendar day for far-east zones (UTC+13/+14), so
on such a machine `getDay()` is off by one and the week boundary is wrong. This is
**pre-existing** — the plan faithfully preserves it — but Task 3's new exact
assertion (`startOfWeek` → `2026-05-03`) makes the latent fragility observable: it
passes in CI (UTC) but could fail for a developer running locally in the Pacific.

Not PR1's job to fix the underlying computation, but the plan shouldn't present
"preserved from existing code" as if it settles correctness. Either note the CI-UTC
assumption next to the test, or compute the weekday in `tz` (the honest fix) so the
boundary is timezone-correct and the test is machine-independent.

## 🟢 `parse` is exactly as strict as `new Date`, not stricter

`_parse` = `parseToDate(iso).getTime()`, and `parseToDate` throws only when
`new Date(iso)` is NaN. `new Date` is lenient — `new Date("2026")` is a valid Jan 1,
`new Date("2026-05")` parses, etc. So `parse` "throws on bad input" is true for what
`new Date` rejects, but it will silently accept some loosely-valid, non-strict-ISO
strings. Fine for the stated contract; worth one line in the `parse` docstring so a
caller feeding user input knows it's `new Date`-strict, not RFC-3339-strict.

## 🟢 The sandbox fixture is inherently time-dependent (PR2 fixes this)

Beyond the `endOfDay` flake above, Task 6 leans on real `now()`/`today()`
(`formatDate(n) != t`, `tomorrow() == today()`), so it has hairline midnight-rollover
dependencies. They're negligible in practice, but worth a sentence noting the fixture
is non-deterministic by nature and that PR2's fake-clock routing (#575) is what makes
it deterministic — so nobody "fixes" the flake by weakening an assertion here.

---

## Smaller notes

- **Task 5 Step 5** runs `pnpm run a typecheck stdlib/date.agency` — confirm `a` is
  the intended alias (CLAUDE.md uses `pnpm run agency`). Trivial, implementer will
  know, but the command should be copy-pasteable.
- **Internal `_now` callers:** the old `_now(timezone?)` took a tz; the new `_now()`
  takes none. Add a one-line grep in Task 2 or Task 4 to confirm nothing inside
  `date.ts` still calls `_now(tz)` with an argument, so the signature change can't
  leave a stale internal call.
- **Affirm:** the "if Intl's `fractionalSecond` shape differs, correct the literal
  but keep the round-trip/DST assertion as the invariant" guidance (Task 1 Step 4,
  Task 3 Step 4) is exactly the right instinct — it adjusts to a formatting surprise
  without weakening the load-bearing check.

---

# Anti-pattern audit (vs `docs/dev/anti-patterns.md`)

Note on enforcement first: `lint:structure` is `eslint lib/` and enforces only
no-dynamic-imports, `max-depth`, `max-lines-per-function`, and `max-lines`. None of
the items below are auto-caught, so Task 7's lint step passes green regardless — they
need a human.

## Declarative "what" vs imperative "how" — the boundary helpers are the weak spot

You asked specifically about this, and it's the one real hit. The module-level split
is good: the imperative TypeScript "how" lives in `date.ts`, the Agency wrappers are
the declarative "what," and the wrapper owning `instant ?? now()` while the helpers
take concrete values is a clean boundary (it's what lets the helpers unit-test
without an Agency frame). That part is the anti-pattern's *good* side.

But inside `date.ts`, the six boundary helpers (Task 3) are "imperative code
everywhere." Each one re-spells the identical pipeline:

```ts
const tz = timezone || getLocalTimezone();   // 1. resolve the timezone
const dateStr = _formatDate(instant, tz);    // 2. instant -> calendar date
// 3. transform the date string (identity / back to Sunday / first of month / ...)
return _atTime(<transformed>, "<time>", tz); // 4. re-pin to an instant
```

The only thing that actually varies across the six is (a) the date transform and
(b) the time-of-day string. Everything else is copied four-step boilerplate. The
plan itself says "the only change from today's bodies is the first line" — which
means it's preserving a pre-existing repetition rather than taking the moment to fix
it. And the usual "minimal diff" defense is weak here, because the bodies are being
rewritten anyway (new param, new first line, new return type).

The declarative shaping the doc asks for is a single pipeline with the six as
one-liners that declare only their *what*:

```ts
function boundary(
  instant: number,
  timezone: string | undefined,
  toDate: (dateStr: string, tz: string) => string,
  timeOfDay: string,
): number {
  const tz = timezone || getLocalTimezone();
  return _atTime(toDate(_formatDate(instant, tz), tz), timeOfDay, tz);
}

export const _startOfDay   = (i, tz) => boundary(i, tz, (d) => d, "00:00:00");
export const _endOfDay     = (i, tz) => boundary(i, tz, (d) => d, "23:59:59");
export const _startOfMonth = (i, tz) => boundary(i, tz, firstOfMonth, "00:00:00");
export const _endOfMonth   = (i, tz) => boundary(i, tz, lastOfMonth,  "23:59:59");
export const _startOfWeek  = (i, tz) => boundary(i, tz, sundayOf,     "00:00:00");
export const _endOfWeek    = (i, tz) => boundary(i, tz, saturdayOf,   "23:59:59");
```

Now the four-step "how" lives once, each boundary declares its "what," and the
`endOf* = .000-vs-.999` decision (main-review finding #2) is a single edit to
`timeOfDay` instead of six. `sundayOf`/`saturdayOf`/`lastOfMonth` are named date
transforms — the irreducibly imperative `Date` math, but isolated and testable. If
you'd rather keep the minimal-diff shape, that's a conscious call — but say so,
because as written this is the textbook "imperative everywhere" the doc names.

## Confirmed ban: the ugly-spread (also in the main review)

Task 1 Step 3's `...(includeMillis ? { fractionalSecondDigits: 3 } : {})` is verbatim
the pattern anti-patterns.md flags under "Ugly code" — "Please never use this
pattern." Build the Intl options object plainly instead. (Full note in the main
review above.)

## Duplication / inconsistent patterns

- **`timezone || getLocalTimezone()` is copied ~9 times** across `_format`,
  `_formatDate`, and the six boundary helpers. Extract `resolveTz(timezone)` (or let
  it fall out of the `boundary` combinator above) so the default lives once.
- **The week helpers re-inline `formatWithTimezone(d, tz).slice(0, 10)`** instead of
  reusing `_formatDate`, which is *exactly* the "instant → date string" abstraction
  that already exists two functions up. Two ways to do one thing — route the week
  helpers through `_formatDate(d.getTime(), tz)` for consistency.

## Minor / judgment calls (not lint-enforced)

- **Magic date offsets:** `dateStr.slice(5, 7)` ("the month"), `slice(0, 8) + "01"`,
  `6 - d.getDay()` (6 = Saturday). Unlabeled numbers doing date-field surgery — the
  "magic numbers" entry. Low stakes for date-string slicing, but a named
  `firstOfMonth`/`lastOfMonth`/`saturdayOf` (which the combinator refactor gives you
  anyway) removes most of them.
- **Single-char names:** `d` in the week/month helpers; `n`/`t`/`s`/`tm` in the
  Task 6 sandbox fixture. The doc bans single-char names. Test/fixture code is
  lower-stakes, but they're easy to name.

## Clean — no hits

No dynamic imports, no unlogged catch (the only throw is `parseToDate`, which throws
loudly by design), no `safeDelete` concern (Task 4 deletes code, not files), no
nested ternaries, and no catastrophic-failure tests. Order-dependent mutable state is
absent — the helpers use `const` derived from inputs, and `formatWithTimezone`'s
`let offset` + if/else is the doc's *preferred* shape over a ternary, not a
violation.

---

# Test-plan audit — will these tests fail when the code breaks?

Short answer: the *invariant* tests are well-chosen and would catch real breaks, but
the boundary tests pick the easy cases and skip exactly the ones where date math goes
wrong, and the one correctness bug from the main review (`endOf* = .000`) is not
caught by any unit test — only by a sandbox check that flakes at a specific second.

Verified, not assumed: `parseToDate` throws on NaN (so the parse-throws test really
fires), and `new Date(year, month, 0)` is leap-year-correct in JS (so endOfMonth is
*right* — it's just under-tested, below).

## 🟡 `endOfMonth` is only tested on a 31-day month — February/leap year is where it breaks

Task 3 tests `endOfMonth` for May (always 31 days). The last-day-of-month
computation is *the* risk area for off-by-one and leap bugs, and the test picks the
one month where nothing can go wrong. Add:
- February of a leap year (`_endOfMonth` of an instant in Feb 2024 → `2024-02-29`),
- February of a common year (Feb 2026 → `2026-02-28`),
- a 30-day month (April → `-04-30`).

The code is actually correct here (I checked the `new Date(year, month, 0)` math),
so these pass today — but without them, a future "optimization" of `_endOfMonth`
regresses leap handling with nothing red.

## 🟡 The week helpers are only tested where the boundary stays inside the month

Task 3's week test uses 2026-05-05 (Tuesday), whose Sunday is 2026-05-03 — same
month, no roll. The interesting cases are where `d.setDate(d.getDate() - day)` goes
negative or past a month/year end: e.g. an instant on 2026-05-01 (Friday) whose week
Sunday is 2026-04-26, or a week straddling New Year. `setDate` handles these, but
"handles these" is exactly what a test should prove. Add one cross-month week case.

## 🟡 No unit test asserts the boundary-ordering invariant — and that's what would catch the `.000` bug

Nothing in the unit tests checks `startOfDay(x) <= x <= endOfDay(x)`. That invariant
is only in the Task 6 sandbox, as `if (eod < n) return "endOfDay failed"`, against
the *real* clock — so the `.000`-not-`.999` bug (main-review finding #2) surfaces
only as a rare wall-clock flake in the final second before midnight, which is the
worst possible way to "catch" a bug.

Add a deterministic unit test: pick an instant late in the day (e.g.
`_atTime("2026-05-05", "23:59:59", NY)` plus 500 ms) and assert
`_startOfDay(x, NY) <= x && x <= _endOfDay(x, NY)`. As the plan stands that test
*fails* — which is the point: it turns finding #2 from a flake into a red test that
forces the `.000`-vs-`.999` decision before merge.

## 🟢 `format`/`formatDate` are never tested at UTC

`formatWithTimezone` has a dedicated branch mapping Intl's `GMT`/`UTC` name to
`+00:00`. No test exercises it — `_format(x, "UTC")` should end in `+00:00`, and
`_formatDate(x, "UTC")` should give the UTC calendar date. If someone breaks that
branch, every test still passes (they all use offset timezones). Add one UTC case.

## 🟢 Only DST spring-forward is tested; fall-back (the 25-hour day) is not

Task 3 tests the spring-forward day (23-hour day). The autumn fall-back day, where
01:00–02:00 happens twice and the offset shifts the other way, has its own edge
behavior in `_atTime`/`formatWithTimezone`. Lower priority than the above, but it's
the other half of the DST story and cheap to add alongside the spring case.

## 🟢 Smaller test-quality notes

- **Round-trip is proven at a single instant.** `parse(format(x)) === x` is the right
  load-bearing invariant, but it's checked at one point (LA, .123 ms). Add a `+`
  offset timezone and a midnight instant so the round-trip isn't pinned to one shape.
- **Assertions verify *through* `format`.** Task 2's `atTime` and most of Task 3
  check `_format(_helper(...))` rather than the raw number. That's acceptable because
  `format` is independently tested in Task 1 — and it means a `format` regression
  cascades loudly across suites (more signal, not less). Worth being aware of, not
  fixing.
- **The sandbox's type protection is weak.** The `typeof now() === "number"` guard
  lives only in the Task 2 unit test. In the sandbox, if `now()` regressed to a
  string, `n + 2h` would become string concatenation and the checks could pass or
  fail by coercion accident. The unit test covers the type, so this is just a note
  that the sandbox isn't a second line of defense for the type change.

## Affirmations — these tests do what they claim

- **The DST spring-forward test is genuine and correctly reasoned** (`startOfDay`
  −05:00 EST, `endOfDay` −04:00 EDT on 2026-03-08). This is the single most valuable
  test in the plan and it's right.
- **`parse(format(x)) === x` is the correct invariant**, and it's enforced twice —
  as a unit test (Task 1) and end-to-end through the wrappers in the sandbox (Task 6),
  so a "format silently drops milliseconds" regression fails at both layers.
- **The `formatDate` NY/Tokyo day-shift** tests exactly why `formatDate` exists — an
  instant that is two different calendar dates depending on where you stand.
- **`now()`-returns-a-number** is a proper red-first proof of the string→number change
  (the `typeof` check fails before the change, passes after).
- **Red-first discipline is consistent**, and the "correct the literal to the
  runtime's real output, keep the round-trip/DST assertion as the invariant" guidance
  protects against Intl formatting surprises without weakening coverage.

## Coverage vs the spec's mandated tests

The spec named: millisecond round-trip (Task 1 ✓), parse throws (Task 1 ✓),
formatDate across a day-shifting timezone (Task 1 ✓), DST spring-forward (Task 3 ✓,
spring only), week-start convention (Task 3 ✓, but machine-timezone-fragile per the
main review), boundaries land correctly (Task 3 ✓ for the easy months), and the
composition examples (Task 6 ✓). So every mandated test is present — the gaps are the
*unmandated but obvious* ones (leap-February, cross-month weeks, UTC, the ordering
invariant) that separate "passes on the happy path" from "fails when the math is
wrong."
