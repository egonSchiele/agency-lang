# std::date: instants as numbers — Implementation Plan (PR 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change `std::date` so instants (`now`, `atTime`, `startOf*`/`endOf*`) are epoch-millisecond numbers, calendar dates (`today`, `tomorrow`, `nextDayOfWeek`) stay strings, the `add*` helpers are removed in favor of `+`/`-` with duration literals, and three bridges (`format`, `formatDate`, `parse`) connect the two worlds.

**Architecture:** The TypeScript helpers in `lib/stdlib/date.ts` do the work; the thin Agency wrappers in `stdlib/date.agency` expose them. The wrappers own the optional-instant default (`instant ?? now()`); the helpers take concrete values so they unit-test without an Agency frame. Inside `date.ts`, the six boundary helpers share one `boundary` combinator so the four-step "instant → date → transform → re-pin" pipeline lives once.

**Tech Stack:** TypeScript (`Intl.DateTimeFormat` for timezone math), Agency stdlib, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-19-std-date-instants-as-numbers-design.md`. Read it first.
- Instants are epoch milliseconds (a plain `number`). Calendar dates are `"YYYY-MM-DD"` strings. These are the two representations; nothing else.
- Agency does NOT support a function-call default parameter (`def f(x = now())` fails to parse). The optional instant is `instant?: number`, resolved in the wrapper body with `const at = instant ?? now()`.
- `format` emits milliseconds (`.SSS`), so `parse(format(x))` round-trips exactly.
- `parse` throws on input `new Date` rejects (never a silent `NaN`). It is `new Date`-strict, not RFC-3339-strict — document that.
- `endOf*` returns the LAST millisecond of the span (`23:59:59.999`), so `startOfDay(x) <= x <= endOfDay(x)` holds. This is a deliberate choice for the exact-number world.
- Weekday math uses `getUTCDay()` on a noon-UTC date string, never `getDay()` — `getDay()` reads the runner's local timezone and is off by one on far-east zones.
- `now()` has NO timezone parameter — an instant is absolute.
- Names `format`/`parse` are used as-is (the owner may prefer `formatTime`/`parseTime`; if so, rename before Task 4).
- Never use the `{ ...(cond ? {x} : {}) }` ugly-spread (`docs/dev/anti-patterns.md`). Build option objects plainly.
- Use types not interfaces, arrays not sets, objects not maps. No dynamic imports. No single-char names.
- After any stdlib change, build with `make` (not `pnpm run build`). For a single stdlib file mid-iteration, `pnpm run compile stdlib/date.agency --force` (the `--force` is mandatory; the incremental manifest silently skips an unchanged-mtime recompile).
- Commit messages / PR bodies go in a file passed to git, never inline. End commit messages with the `Co-Authored-By` trailer.
- Save test output to a file; do not re-run the slow agency suite to see failures.

## File Structure

- `lib/stdlib/date.ts` — **modify**. Add `resolveTz`, `_format`/`_formatDate`/`_parse`, the `boundary` combinator and named date transforms; change `_now`/`_atTime`/`_startOf*`/`_endOf*` to numbers; remove `_add*`; give `formatWithTimezone` a millisecond mode.
- `lib/stdlib/date.test.ts` — **new**. Unit tests for the helpers.
- `stdlib/date.agency` — **modify**. Wrapper signatures, docstrings, remove `add*`, add `format`/`formatDate`/`parse`.
- `tests/integration/stdlib-sandbox/date.agency` + `.test.json` — **rewrite**.
- `CHANGELOG.md` — **modify**. The breaking-change entry and migration note.

---

## Task 1: The bridge helpers and `resolveTz`

The boundary functions in Task 3 depend on `_formatDate`, so build the bridges first.

**Files:**
- Modify: `lib/stdlib/date.ts`
- Test: `lib/stdlib/date.test.ts` (new)

**Interfaces:**
- Produces:
  - `resolveTz(timezone?: string): string` — the `timezone || getLocalTimezone()` default, in one place.
  - `_format(ms: number, timezone?: string): string` — ISO 8601 with `.SSS` and offset.
  - `_formatDate(ms: number, timezone?: string): string` — `"YYYY-MM-DD"` in the timezone.
  - `_parse(iso: string): number` — epoch ms; throws on input `new Date` rejects.

- [ ] **Step 1: Write the failing test**

Create `lib/stdlib/date.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { _format, _formatDate, _parse } from "./date.js";

describe("date bridges", () => {
  const LA = "America/Los_Angeles";

  it("format emits milliseconds and offset", () => {
    // 2026-05-05T17:30:00.123Z is 10:30 in Los Angeles (UTC-7 in May)
    const ms = Date.UTC(2026, 4, 5, 17, 30, 0, 123);
    expect(_format(ms, LA)).toBe("2026-05-05T10:30:00.123-07:00");
  });

  it("format at UTC ends in +00:00", () => {
    const ms = Date.UTC(2026, 4, 5, 17, 30, 0, 0);
    expect(_format(ms, "UTC")).toBe("2026-05-05T17:30:00.000+00:00");
  });

  it("parse(format(x)) round-trips exactly at several instants", () => {
    for (const x of [
      Date.UTC(2026, 4, 5, 17, 30, 0, 123), // afternoon, ms present
      Date.UTC(2026, 0, 1, 0, 0, 0, 0),     // midnight UTC
      Date.UTC(2026, 5, 15, 6, 30, 0, 500), // a + offset zone below
    ]) {
      expect(_parse(_format(x, LA))).toBe(x);
      expect(_parse(_format(x, "Asia/Kolkata"))).toBe(x); // +05:30
      expect(_parse(_format(x, "UTC"))).toBe(x);
    }
  });

  it("parse accepts an ISO string with no fractional seconds", () => {
    expect(_parse("2026-05-05T10:30:00-07:00")).toBe(
      Date.UTC(2026, 4, 5, 17, 30, 0, 0),
    );
  });

  it("parse throws on input new Date cannot read", () => {
    expect(() => _parse("not a date")).toThrow();
  });

  it("formatDate returns the calendar date in the given timezone", () => {
    // An instant that is 5 May in New York but already 6 May in Tokyo.
    const ms = Date.UTC(2026, 4, 5, 20, 0, 0);
    expect(_formatDate(ms, "America/New_York")).toBe("2026-05-05");
    expect(_formatDate(ms, "Asia/Tokyo")).toBe("2026-05-06");
    expect(_formatDate(ms, "UTC")).toBe("2026-05-05");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run lib/stdlib/date.test.ts`
Expected: FAIL — `_format`, `_formatDate`, `_parse` are not exported.

- [ ] **Step 3: Implement `resolveTz`, the millisecond mode, and the three bridges**

In `lib/stdlib/date.ts`, add the timezone-default helper near the top (used everywhere a timezone defaults):
```ts
function resolveTz(timezone?: string): string {
  return timezone || getLocalTimezone();
}
```
Give `formatWithTimezone` a millisecond mode, building the Intl options object PLAINLY (no ugly-spread):
```ts
function formatWithTimezone(
  date: Date,
  timezone: string,
  includeMillis: boolean = false,
): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  };
  if (includeMillis) {
    options.fractionalSecondDigits = 3;
  }
  const formatter = new Intl.DateTimeFormat("en-US", options);
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour") === "24" ? "00" : get("hour");
  const minute = get("minute");
  const second = get("second");
  const tzName = get("timeZoneName");
  let offset: string;
  if (tzName === "GMT" || tzName === "UTC") {
    offset = "+00:00";
  } else {
    const match = tzName.match(/GMT([+-]\d{2}:\d{2})/);
    offset = match ? match[1] : "+00:00";
  }
  const frac = includeMillis
    ? `.${(get("fractionalSecond") || "000").padEnd(3, "0")}`
    : "";
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${frac}${offset}`;
}
```
Add the three bridges (a clearly-marked "Bridges" section):
```ts
export function _format(ms: number, timezone?: string): string {
  return formatWithTimezone(new Date(ms), resolveTz(timezone), true);
}

export function _formatDate(ms: number, timezone?: string): string {
  return formatWithTimezone(new Date(ms), resolveTz(timezone)).slice(0, 10);
}

export function _parse(iso: string): number {
  // parseToDate throws when new Date(iso) is NaN.
  return parseToDate(iso).getTime();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run lib/stdlib/date.test.ts`
Expected: PASS. If Intl's `fractionalSecond` part is shaped differently than the literal `.123`, correct the exact-string expectations to what the runtime produces and keep the `parse(format(x)) === x` round-trip as the load-bearing invariant — never weaken the round-trip to make a formatting-shape surprise pass.

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/date.ts lib/stdlib/date.test.ts
git commit -F <message-file>
```
Message subject: `std::date: add resolveTz and the format/formatDate/parse bridges`

---

## Task 2: `_now` and `_atTime` return numbers

**Files:**
- Modify: `lib/stdlib/date.ts`
- Test: `lib/stdlib/date.test.ts`

**Interfaces:**
- Consumes: Task 1's `_format`.
- Produces: `_now(): number`; `_atTime(date: string, time: string, timezone?: string): number`.

- [ ] **Step 1: Write the failing test**

Add to `lib/stdlib/date.test.ts`:
```ts
import { _now, _atTime } from "./date.js";

describe("now and atTime as numbers", () => {
  it("now returns a number close to Date.now()", () => {
    const before = Date.now();
    const value = _now();
    expect(typeof value).toBe("number");
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThan(before + 5000);
  });

  it("atTime returns the instant of a wall-clock time on a date, in a timezone", () => {
    // 09:00 on 2026-05-05 in New York (UTC-4 in May) is 13:00 UTC.
    const ms = _atTime("2026-05-05", "09:00", "America/New_York");
    expect(_format(ms, "America/New_York")).toBe("2026-05-05T09:00:00.000-04:00");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run lib/stdlib/date.test.ts`
Expected: FAIL — `_now` still returns a string; the `typeof` and `_atTime` assertions fail.

- [ ] **Step 3: Change `_now` and `_atTime`**

Replace `_now` (it no longer takes a timezone):
```ts
export function _now(): number {
  return Date.now();
}
```
In `_atTime`, keep the whole offset-adjustment computation exactly as it is, and change ONLY the return: instead of building and returning the string, return the adjusted instant:
```ts
  const adjusted = new Date(guess.getTime() + totalDiffMs);
  return adjusted.getTime();
```
Delete the now-dead tail of `_atTime` that built `adjustedFormatted`, `finalParts`, `finalTime`, and `offset`. Verify with the test that `_format(_atTime(...))` shows the intended wall-clock time.

- [ ] **Step 4: Confirm no internal caller still passes `_now` a timezone**

`_now` dropped its parameter, so a stale `_now(tz)` inside `date.ts` would silently ignore the argument. Confirm there are none:
```bash
grep -n "_now(" lib/stdlib/date.ts
```
Expected: only zero-argument `_now()` calls (or none). If any pass an argument, they were relying on the old behavior — resolve them.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run lib/stdlib/date.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/stdlib/date.ts lib/stdlib/date.test.ts
git commit -F <message-file>
```
Message subject: `std::date: now() and atTime() return epoch millis`

---

## Task 3: Boundary functions via one combinator

**Files:**
- Modify: `lib/stdlib/date.ts`
- Test: `lib/stdlib/date.test.ts`

**Interfaces:**
- Consumes: `resolveTz`, `_formatDate`, `_format` (Task 1), `_atTime` (Task 2).
- Produces: `_startOfDay`/`_endOfDay`/`_startOfWeek`/`_endOfWeek`/`_startOfMonth`/`_endOfMonth`, each `(instant: number, timezone?: string): number`. The helpers take a required instant; the wrapper (Task 4) supplies `now()` when omitted.

**Background:** every boundary function is the same pipeline — resolve the timezone, turn the instant into its calendar date (`_formatDate`), transform that date string (identity / that week's Sunday or Saturday / first or last of the month), then re-pin to an instant with `_atTime`. Only the date transform and the start-vs-end edge vary, so that pipeline lives once in a `boundary` combinator and each of the six declares only its transform and edge. `endOf*` returns the LAST millisecond of the span (`23:59:59.999`), so an instant is always within `[startOf, endOf]` of its own span.

- [ ] **Step 1: Write the failing test**

Add to `lib/stdlib/date.test.ts`:
```ts
import {
  _startOfDay, _endOfDay, _startOfWeek, _endOfWeek, _startOfMonth, _endOfMonth,
} from "./date.js";

describe("boundary functions as numbers", () => {
  const NY = "America/New_York";

  it("startOfDay is midnight and endOfDay is the last millisecond", () => {
    const noon = _atTime("2026-05-05", "12:00", NY);
    expect(_format(_startOfDay(noon, NY), NY)).toBe("2026-05-05T00:00:00.000-04:00");
    expect(_format(_endOfDay(noon, NY), NY)).toBe("2026-05-05T23:59:59.999-04:00");
  });

  it("an instant is always within [startOfDay, endOfDay] of its own day", () => {
    // Late in the day: this FAILS if endOfDay is 23:59:59.000 instead of .999.
    const late = _atTime("2026-05-05", "23:59:59", NY) + 500;
    expect(_startOfDay(late, NY)).toBeLessThanOrEqual(late);
    expect(late).toBeLessThanOrEqual(_endOfDay(late, NY));
  });

  it("handles the DST spring-forward day (23-hour day)", () => {
    // New York springs forward at 02:00 on 2026-03-08 (EST -> EDT).
    const noon = _atTime("2026-03-08", "12:00", NY);
    expect(_format(_startOfDay(noon, NY), NY)).toBe("2026-03-08T00:00:00.000-05:00");
    expect(_format(_endOfDay(noon, NY), NY)).toBe("2026-03-08T23:59:59.999-04:00");
  });

  it("handles the DST fall-back day (25-hour day)", () => {
    // New York falls back at 02:00 on 2026-11-01 (EDT -> EST).
    const noon = _atTime("2026-11-01", "12:00", NY);
    expect(_format(_startOfDay(noon, NY), NY)).toBe("2026-11-01T00:00:00.000-04:00");
    expect(_format(_endOfDay(noon, NY), NY)).toBe("2026-11-01T23:59:59.999-05:00");
  });

  it("startOfWeek begins on Sunday; endOfWeek is Saturday (the chosen convention)", () => {
    const noon = _atTime("2026-05-05", "12:00", NY); // Tuesday
    expect(_formatDate(_startOfWeek(noon, NY), NY)).toBe("2026-05-03");
    expect(_formatDate(_endOfWeek(noon, NY), NY)).toBe("2026-05-09");
  });

  it("a week that straddles a month boundary rolls correctly", () => {
    const noon = _atTime("2026-05-01", "12:00", NY); // Friday; its Sunday is Apr 26
    expect(_formatDate(_startOfWeek(noon, NY), NY)).toBe("2026-04-26");
    expect(_formatDate(_endOfWeek(noon, NY), NY)).toBe("2026-05-02");
  });

  it("startOfMonth and endOfMonth handle 31-, 30-, and February months", () => {
    const may = _atTime("2026-05-15", "12:00", NY);
    expect(_formatDate(_startOfMonth(may, NY), NY)).toBe("2026-05-01");
    expect(_formatDate(_endOfMonth(may, NY), NY)).toBe("2026-05-31");
    const apr = _atTime("2026-04-15", "12:00", NY);
    expect(_formatDate(_endOfMonth(apr, NY), NY)).toBe("2026-04-30");
    const febCommon = _atTime("2026-02-15", "12:00", NY);
    expect(_formatDate(_endOfMonth(febCommon, NY), NY)).toBe("2026-02-28");
    const febLeap = _atTime("2024-02-15", "12:00", NY);
    expect(_formatDate(_endOfMonth(febLeap, NY), NY)).toBe("2024-02-29");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run lib/stdlib/date.test.ts`
Expected: FAIL — the boundary helpers still take a date string and return a string, and the `.999` / ordering assertions cannot pass.

- [ ] **Step 3: Implement the combinator, the named transforms, and the six helpers**

Replace the six boundary helpers in `lib/stdlib/date.ts` with:
```ts
// --- Range boundaries ---

// Weekday of a calendar-date string, machine-independent: getUTCDay() on a
// noon-UTC instant. Never getDay(), which reads the runner's local timezone
// and is off by one on far-east zones. 0 = Sunday.
function weekdayOf(dateStr: string): number {
  return new Date(dateStr + "T12:00:00Z").getUTCDay();
}

// Date-string transforms: "YYYY-MM-DD" -> "YYYY-MM-DD", timezone-independent
// because the input is already the tz-local calendar date.
function sundayOf(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - weekdayOf(dateStr));
  return d.toISOString().slice(0, 10);
}
function saturdayOf(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + (6 - weekdayOf(dateStr)));
  return d.toISOString().slice(0, 10);
}
function firstOfMonth(dateStr: string): string {
  return dateStr.slice(0, 8) + "01";
}
function lastOfMonth(dateStr: string): string {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(5, 7), 10); // 1-indexed
  // Date.UTC(y, month, 0) is day 0 of the NEXT month = the last day of this one.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${dateStr.slice(0, 8)}${String(lastDay).padStart(2, "0")}`;
}

// The one place the four-step "instant -> date -> transform -> re-pin" pipeline
// lives. `edge` picks midnight (start) or the last millisecond of the day (end).
function boundary(
  instant: number,
  timezone: string | undefined,
  toDate: (dateStr: string) => string,
  edge: "start" | "end",
): number {
  const tz = resolveTz(timezone);
  const dateStr = toDate(_formatDate(instant, tz));
  return edge === "start"
    ? _atTime(dateStr, "00:00:00", tz)
    : _atTime(dateStr, "23:59:59", tz) + 999; // last ms of the day
}

export function _startOfDay(instant: number, timezone?: string): number {
  return boundary(instant, timezone, (d) => d, "start");
}
export function _endOfDay(instant: number, timezone?: string): number {
  return boundary(instant, timezone, (d) => d, "end");
}
export function _startOfWeek(instant: number, timezone?: string): number {
  return boundary(instant, timezone, sundayOf, "start");
}
export function _endOfWeek(instant: number, timezone?: string): number {
  return boundary(instant, timezone, saturdayOf, "end");
}
export function _startOfMonth(instant: number, timezone?: string): number {
  return boundary(instant, timezone, firstOfMonth, "start");
}
export function _endOfMonth(instant: number, timezone?: string): number {
  return boundary(instant, timezone, lastOfMonth, "end");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run lib/stdlib/date.test.ts`
Expected: PASS, including the ordering-invariant, DST spring/fall, cross-month week, and leap-February cases. If a DST offset literal differs from what the runtime produces for that real transition date, correct the literal — do not weaken the assertion; the DST and ordering checks are the load-bearing ones.

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/date.ts lib/stdlib/date.test.ts
git commit -F <message-file>
```
Message subject: `std::date: boundary functions via a shared combinator, endOf = last ms`

---

## Task 4: Rewrite the Agency wrappers and remove the arithmetic helpers

Done in one task so every commit builds: the `add*` TS helpers and their `.agency` wrappers are removed together, and the module compiles at the end.

**Files:**
- Modify: `stdlib/date.agency`, `lib/stdlib/date.ts`

**Interfaces:**
- Consumes: every helper from Tasks 1–3.
- Produces the public `std::date` API.

- [ ] **Step 1: Remove the four `add*` TS helpers**

Delete `_add`, `_addMinutes`, `_addHours`, `_addDays` from `lib/stdlib/date.ts` (and the "Date arithmetic" section comment if it is now empty). Confirm nothing else in the file references them:
```bash
grep -n "_add\b\|_addMinutes\|_addHours\|_addDays" lib/stdlib/date.ts
```
Expected: no output.

- [ ] **Step 2: Update the `.agency` import line**

In `stdlib/date.agency`, change the `agency-lang/stdlib-lib/date.js` import to add `_format`, `_formatDate`, `_parse` and drop `_add`, `_addMinutes`, `_addHours`, `_addDays`:
```agency
import { _now, _today, _tomorrow, _nextDayOfWeek, _atTime, _startOfDay, _endOfDay, _startOfWeek, _endOfWeek, _startOfMonth, _endOfMonth, _format, _formatDate, _parse } from "agency-lang/stdlib-lib/date.js"
```

- [ ] **Step 3: Rewrite `now`, delete the `add*` wrappers**

```agency
export def now(): number {
  """
  Get the current instant as epoch milliseconds (a number). To display it as a
  string, use format(now(), timezone). An instant is absolute and has no
  timezone of its own.
  """
  return _now()
}
```
Delete the `add`, `addMinutes`, `addHours`, `addDays` wrappers entirely, and update the module doc comment if it lists them.

- [ ] **Step 4: Rewrite `atTime` and the six boundary wrappers**

`atTime` returns a number:
```agency
export def atTime(date: string, time: string, timezone: string = ""): number {
  """
  Get the instant (epoch milliseconds) of a wall-clock time on a calendar date,
  in a timezone. Example: atTime("2026-05-05", "09:00", "America/New_York").

  @param date - The calendar date, "YYYY-MM-DD"
  @param time - The wall-clock time, "HH:MM" or "HH:MM:SS"
  @param timezone - IANA timezone name (defaults to local)
  """
  return _atTime(date, time, timezone)
}
```
Each boundary wrapper takes an optional instant and resolves it with `?? now()`:
```agency
export def startOfDay(instant?: number, timezone: string = ""): number {
  """
  Get midnight (00:00:00) of the day containing `instant`, in a timezone, as
  epoch milliseconds. Defaults to now(). Display it with format(...).

  @param instant - The instant whose day to use (defaults to now())
  @param timezone - IANA timezone name (defaults to local)
  """
  const at = instant ?? now()
  return _startOfDay(at, timezone)
}
```
Do the same shape for `endOfDay`, `startOfWeek`, `endOfWeek`, `startOfMonth`, `endOfMonth` — each `(instant?: number, timezone: string = ""): number`, body `const at = instant ?? now()` then `return _<name>(at, timezone)`. Each docstring says it returns epoch milliseconds and defaults to now(); the `endOf*` docstrings say they return the last millisecond of the span.

- [ ] **Step 5: Add the three bridge wrappers**

```agency
export def format(ms: number, timezone: string = ""): string {
  """
  Format an instant (epoch milliseconds) as an ISO 8601 string with
  milliseconds and offset, e.g. "2026-05-05T10:30:00.123-07:00".

  @param ms - The instant to format
  @param timezone - IANA timezone name (defaults to local)
  """
  return _format(ms, timezone)
}

export def formatDate(ms: number, timezone: string = ""): string {
  """
  Format an instant as the "YYYY-MM-DD" calendar date it falls on in a timezone.

  @param ms - The instant to format
  @param timezone - IANA timezone name (defaults to local)
  """
  return _formatDate(ms, timezone)
}

export def parse(iso: string): number {
  """
  Parse an ISO 8601 datetime string into an instant (epoch milliseconds). Throws
  if the string cannot be parsed, so bad input fails loudly instead of becoming
  a silent NaN. Strictness matches JavaScript's Date, not RFC 3339: loosely
  valid strings like "2026" or "2026-05" are accepted.

  @param iso - The ISO 8601 datetime string
  """
  return _parse(iso)
}
```
Leave `today`, `tomorrow`, `nextDayOfWeek` unchanged.

- [ ] **Step 6: Build, compile, and typecheck**

Run:
```bash
pnpm run compile stdlib/date.agency --force
pnpm run agency typecheck stdlib/date.agency
```
Expected: compiles to `stdlib/date.js`; typecheck reports no errors. If `instant ?? now()` or the optional param errors, stop — the fallback shape was verified in isolation during spec review, so an error here is a real signal.

- [ ] **Step 7: Commit**

```bash
git add lib/stdlib/date.ts stdlib/date.agency
git commit -F <message-file>
```
Message subject: `std::date: numbers-based public API, remove add* (breaking)`

---

## Task 5: Rewrite the integration sandbox fixture

**Files:**
- Modify: `tests/integration/stdlib-sandbox/date.agency`, `tests/integration/stdlib-sandbox/date.test.json`

**Interfaces:**
- Consumes: the new public API.

**Note on determinism:** this fixture uses the real clock (`now()`/`today()`), so it has hairline midnight-rollover dependencies by nature. That is inherent to PR 1; PR 2's fake-clock routing (#575) is what makes date fixtures deterministic. Do not "fix" a rollover flake here by weakening an assertion — the `endOf* = .999` choice already removes the one real flake (an instant in the final second is still `<= endOfDay`).

- [ ] **Step 1: Rewrite the fixture**

Replace `tests/integration/stdlib-sandbox/date.agency` with a version using numbers, operators, and the bridges. It returns `"date ok"` when every check passes:
```agency
import { now, today, tomorrow, startOfDay, endOfDay, format, formatDate, parse } from "std::date"

node main(): string {
  // now() is a number (epoch millis)
  const current = now()
  if (current <= 0) { return "now failed" }

  // today() and tomorrow() are still date strings
  const todayStr = today()
  if (todayStr == "") { return "today failed" }
  if (tomorrow() == todayStr) { return "tomorrow failed: same as today" }

  // arithmetic replaces the old add* helpers
  if (current + 2h <= current) { return "add failed" }
  if (current - 30m >= current) { return "subtract failed" }

  // boundaries return numbers; the current instant is inside its own day
  if (startOfDay(current) > current) { return "startOfDay failed" }
  if (endOfDay(current) < current) { return "endOfDay failed" }

  // format / parse round-trip exactly
  if (parse(format(current)) != current) { return "round-trip failed" }

  // formatDate agrees with today() for the current instant
  if (formatDate(current) != todayStr) { return "formatDate failed" }

  return "date ok"
}
```
Verify every line's Agency syntax against `docs/site/guide/basic-syntax.md` and existing fixtures — especially `2h`/`30m` in an expression, which `agency ast` confirms parse to numbers.

- [ ] **Step 2: Update the `.test.json` description**

`tests/integration/stdlib-sandbox/date.test.json` keeps `"expectedOutput": "\"date ok\""`; update its `description` to name the new operations (now/today/tomorrow, `+`/`-` arithmetic, startOfDay/endOfDay, format/parse round-trip, formatDate).

- [ ] **Step 3: Run the sandbox fixture**

Run:
```bash
pnpm run agency test tests/integration/stdlib-sandbox/date.agency 2>&1 | tee /tmp/date-sandbox.txt
```
Expected: 1/1 passes, returning `"date ok"`.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/stdlib-sandbox/date.agency tests/integration/stdlib-sandbox/date.test.json
git commit -F <message-file>
```
Message subject: `std::date: rewrite the sandbox fixture for the numbers API`

---

## Task 6: Consumers, changelog, docs, and final checks

**Files:**
- Modify: `CHANGELOG.md`
- Verify (likely no change): the agency-agent files, `stdlib/calendar.agency`, `tests/agency/memory/basic.agency`

- [ ] **Step 1: Confirm the `today()`-only consumers are untouched**

The agency-agent (`lib/agents/agency-agent/agent.agency`, `.../lib/coordinator.agency`, `.../lib/repl.agency`) and `tests/agency/memory/basic.agency` use only `today()`, which is unchanged. Confirm none of them also call a changed function:
```bash
grep -rn "std::date\|now(\|atTime\|startOf\|endOf\|add(\|addMinutes\|addHours\|addDays\|format(\|parse(" lib/agents/agency-agent/*.agency lib/agents/agency-agent/lib/*.agency tests/agency/memory/basic.agency
```
Expected: only `today()` and its imports. If any file uses a changed function, migrate it: displays become `format(x, tz)`, math becomes `+`/`-`.

- [ ] **Step 2: Confirm calendar.agency only references the changed functions in docs**

Run:
```bash
grep -n "now(\|atTime\|startOf\|endOf\|add(\|addMinutes\|addHours\|addDays" stdlib/calendar.agency
```
Expected: only the doc-comment mention (around line 32), no code calls. If there are code calls, migrate them and rebuild.

- [ ] **Step 3: Write the changelog entry**

Add to `CHANGELOG.md`, matching the file's existing format:
```markdown
### Breaking

- **std::date now represents instants as numbers.** `now()`, `atTime`, and the
  `startOf*`/`endOf*` functions return epoch milliseconds (a number) instead of
  an ISO string. Display one with `format(x, timezone)`; get its calendar date
  with `formatDate(x, timezone)`.
- `now()` no longer takes a timezone parameter — an instant is absolute. Move the
  timezone to `format(now(), timezone)`.
- `add`, `addMinutes`, `addHours`, `addDays` are removed. Use `+` with duration
  literals: `add(t, ms)` -> `t + ms`, `addHours(t, 2)` -> `t + 2h`,
  `addDays(t, 3)` -> `t + 3d`. This is behavior-preserving; the old helpers did
  fixed-millisecond arithmetic.
- `endOf*` now returns the last millisecond of the span (`23:59:59.999`), so an
  instant is always within `[startOf, endOf]` of its own span.
- New: `parse(iso)` turns an ISO string into an instant (throws on bad input;
  `new Date`-strict).
- `today`, `tomorrow`, and `nextDayOfWeek` are unchanged (still "YYYY-MM-DD").
```

- [ ] **Step 4: Full build and regenerate docs**

Run:
```bash
make
```
Expected: builds clean. `make` regenerates `docs/site/stdlib/date.md` from the new docstrings; include the regenerated file in the commit.

- [ ] **Step 5: Typecheck, lint, and the date unit tests once, saved to a file**

Run:
```bash
pnpm run typecheck 2>&1 | tee /tmp/date-tc.txt
pnpm run lint:structure 2>&1 | tee /tmp/date-lint.txt
pnpm exec vitest run lib/stdlib/date.test.ts 2>&1 | tee /tmp/date-unit.txt
```
Expected: typecheck clean, lint clean, all date unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md docs/site/stdlib/date.md
git commit -F <message-file>
```
Message subject: `std::date: changelog and regenerated reference docs`

- [ ] **Step 7: Push and open the PR (only when asked)**

Do not push or open a PR until the owner asks. When asked, put the description in a file; call out the breaking change and the migration note prominently, and note this is PR 1 of the elapsedTime work (#609) with PR 2 to follow.

---

## Self-Review

**Spec coverage.** Bridges → Task 1; `now`/`atTime` to numbers → Task 2; boundary functions to instants → Task 3; the public Agency API (optional-instant `?? now()`, dropped `now()` tz, new docstrings) and the `add*` removal → Task 4 (folded so every commit builds); the sandbox rewrite → Task 5; consumers, changelog, and regenerated docs → Task 6. The spec's required tests are covered — exact millisecond round-trip (Task 1), `parse` throws (Task 1), `formatDate` across a day-shifting timezone (Task 1), DST spring-forward (Task 3), the week-start convention (Task 3), and the composition examples (Task 5) — plus the review's added cases: the ordering invariant, DST fall-back, cross-month weeks, leap-February, and UTC formatting.

**Folded in from the plan review.** Task 4's broken-build commit is gone — the `add*` helpers and their wrappers are removed in the same commit as the wrapper rewrite. `endOf*` returns `.999` so `startOf <= x <= endOf` holds, with a deterministic unit test that is red before the fix. The ugly-spread in `formatWithTimezone` is replaced by a plain option-object build. The six boundary helpers share one `boundary` combinator with named date transforms, so the four-step pipeline and the `timezone || getLocalTimezone()` default each live once (`resolveTz`), and the week helpers route through `_formatDate`. Weekday math uses `getUTCDay()` (verified machine-independent: `getDay()` returns 3 on a UTC+14 runner where `getUTCDay()` returns 2). `parse`'s `new Date`-strictness is documented. The sandbox's inherent time-dependence is noted so nobody weakens an assertion to chase a rollover.

**Type consistency.** `resolveTz`/`_format`/`_formatDate` return `string`; `_parse`, `_now`, `_atTime`, and the six boundary helpers return `number`. The boundary helpers take a required `instant: number`; their wrappers take `instant?: number` and pass `instant ?? now()` — the one place the optional lives. The Agency wrappers' return types match their helpers.

**Verified, not assumed.** The function-call-default failure and the `instant?: number` + `?? now()` fallback were checked against the compiler during spec review; `2h`-as-a-number and `getUTCDay()` machine-independence were checked during this plan review; `parseToDate` throwing and `new Date(year, month, 0)` leap correctness were confirmed by the reviewer. The `_atTime` return change reuses the existing offset math and only swaps the string build for `adjusted.getTime()`, verified by a `_format(_atTime(...))` assertion.
