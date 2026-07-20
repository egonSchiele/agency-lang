import { describe, it, expect } from "vitest";
import {
  _now,
  _today,
  _tomorrow,
  _nextDayOfWeek,
  _atTime,
  _format,
  _formatDate,
  _parse,
  _startOfDay,
  _endOfDay,
  _startOfWeek,
  _endOfWeek,
  _startOfMonth,
  _endOfMonth,
} from "../date.js";

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
      Date.UTC(2026, 0, 1, 0, 0, 0, 0), // midnight UTC
      Date.UTC(2026, 5, 15, 6, 30, 0, 500),
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

describe("_now", () => {
  it("returns a number close to Date.now()", () => {
    const before = Date.now();
    const value = _now();
    expect(typeof value).toBe("number");
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThan(before + 5000);
  });
});

describe("_today / _tomorrow", () => {
  it("today returns a YYYY-MM-DD string", () => {
    expect(_today("UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("tomorrow returns the day after today", () => {
    const todayDate = _today("UTC");
    const [y, m, d] = todayDate.split("-").map(Number);
    const expected = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    expect(_tomorrow("UTC")).toBe(expected);
  });
});

describe("_nextDayOfWeek", () => {
  it("returns a YYYY-MM-DD string", () => {
    expect(_nextDayOfWeek("monday", "UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a future date", () => {
    const now = new Date();
    const dayName = [
      "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
    ][now.getDay()];
    const result = _nextDayOfWeek(dayName, "UTC");
    expect(new Date(result + "T12:00:00Z").getTime()).toBeGreaterThan(now.getTime());
  });

  it("throws on invalid day name", () => {
    expect(() => _nextDayOfWeek("foo")).toThrow("Invalid day of week");
  });
});

describe("_atTime", () => {
  it("returns the instant of a wall-clock time on a date, in a timezone", () => {
    // 09:00 on 2026-05-05 in New York (UTC-4 in May) is 13:00 UTC.
    const ms = _atTime("2026-05-05", "09:00", "America/New_York");
    expect(_format(ms, "America/New_York")).toBe("2026-05-05T09:00:00.000-04:00");
  });

  it("handles UTC and seconds", () => {
    const ms = _atTime("2026-05-10", "09:30:45", "UTC");
    expect(_format(ms, "UTC")).toBe("2026-05-10T09:30:45.000+00:00");
  });

  it("resolves a time whose UTC offset crosses midnight", () => {
    // Midnight May 5 in New York is 04:00 UTC May 5 — the case the old
    // string-building code masked (it returned the input date verbatim).
    const ms = _atTime("2026-05-05", "00:00:00", "America/New_York");
    expect(_format(ms, "America/New_York")).toBe("2026-05-05T00:00:00.000-04:00");
    expect(_format(ms, "UTC")).toBe("2026-05-05T04:00:00.000+00:00");
  });

  it("throws on an unparseable date rather than returning NaN", () => {
    // A NaN instant would silently poison downstream arithmetic; fail loudly.
    expect(() => _atTime("not-a-date", "09:00", "UTC")).toThrow(/Invalid date/);
  });
});

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
