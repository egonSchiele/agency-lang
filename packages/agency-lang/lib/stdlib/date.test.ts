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
      Date.UTC(2026, 0, 1, 0, 0, 0, 0), // midnight UTC
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
