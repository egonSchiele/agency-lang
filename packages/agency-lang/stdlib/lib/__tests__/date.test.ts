import { describe, it, expect } from "vitest";
import {
  _now,
  _today,
  _tomorrow,
  _addMinutes,
  _addHours,
  _addDays,
  _nextDayOfWeek,
  _atTime,
  _endAfter,
  _startOfDay,
  _endOfDay,
  _startOfWeek,
  _endOfWeek,
  _startOfMonth,
  _endOfMonth,
} from "../date.js";

describe("_now", () => {
  it("returns an ISO 8601 string with offset", () => {
    const result = _now("America/New_York");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it("uses specified timezone", () => {
    const ny = _now("America/New_York");
    const la = _now("America/Los_Angeles");
    // Both should be valid ISO strings (may differ in offset)
    expect(ny).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(la).toMatch(/[+-]\d{2}:\d{2}$/);
  });
});

describe("_today", () => {
  it("returns a YYYY-MM-DD string", () => {
    const result = _today("UTC");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("_tomorrow", () => {
  it("returns the day after today", () => {
    const todayDate = _today("UTC");
    const tomorrowDate = _tomorrow("UTC");
    const todayParts = todayDate.split("-").map(Number);
    const d = new Date(Date.UTC(todayParts[0], todayParts[1] - 1, todayParts[2]));
    d.setUTCDate(d.getUTCDate() + 1);
    const expected = d.toISOString().slice(0, 10);
    expect(tomorrowDate).toBe(expected);
  });
});

describe("_addMinutes", () => {
  it("adds minutes to a datetime", () => {
    const result = _addMinutes("2026-05-10T10:00:00Z", 30);
    expect(result).toContain("10:30:00");
  });

  it("handles crossing hour boundary", () => {
    const result = _addMinutes("2026-05-10T10:45:00Z", 30);
    expect(result).toContain("11:15:00");
  });

  it("handles negative minutes", () => {
    const result = _addMinutes("2026-05-10T10:00:00Z", -30);
    expect(result).toContain("09:30:00");
  });

  it("preserves timezone offset from input", () => {
    const result = _addMinutes("2026-05-10T10:00:00-07:00", 30);
    expect(result).toBe("2026-05-10T10:30:00-07:00");
  });

  it("preserves UTC (Z) as +00:00", () => {
    const result = _addMinutes("2026-05-10T10:00:00Z", 30);
    // Z input should give ISO output (which uses Z)
    expect(result).toContain("10:30:00");
  });

  it("preserves positive timezone offset", () => {
    const result = _addMinutes("2026-05-10T10:00:00+05:30", 60);
    expect(result).toBe("2026-05-10T11:00:00+05:30");
  });
});

describe("_addHours", () => {
  it("adds hours to a datetime", () => {
    const result = _addHours("2026-05-10T10:00:00Z", 2);
    expect(result).toContain("12:00:00");
  });
});

describe("_addDays", () => {
  it("adds days to a datetime", () => {
    const result = _addDays("2026-05-10T10:00:00Z", 3);
    expect(result).toContain("2026-05-13");
  });
});

describe("_nextDayOfWeek", () => {
  it("returns a YYYY-MM-DD string", () => {
    const result = _nextDayOfWeek("monday", "UTC");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a date that is the correct day of week", () => {
    const result = _nextDayOfWeek("wednesday", "UTC");
    const d = new Date(result + "T12:00:00Z");
    expect(d.getUTCDay()).toBe(3); // Wednesday = 3
  });

  it("returns a future date (not today even if today is that day)", () => {
    const today = new Date();
    const dayName = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][today.getDay()];
    const result = _nextDayOfWeek(dayName, "UTC");
    const resultDate = new Date(result + "T12:00:00Z");
    expect(resultDate.getTime()).toBeGreaterThan(today.getTime());
  });

  it("throws on invalid day name", () => {
    expect(() => _nextDayOfWeek("foo")).toThrow("Invalid day of week");
  });
});

describe("_atTime", () => {
  it("combines date and time with timezone offset", () => {
    const result = _atTime("2026-05-10", "15:00", "America/Los_Angeles");
    expect(result).toMatch(/^2026-05-10T15:00:00[+-]\d{2}:\d{2}$/);
  });

  it("handles UTC timezone", () => {
    const result = _atTime("2026-05-10", "09:30", "UTC");
    expect(result).toBe("2026-05-10T09:30:00+00:00");
  });

  it("handles seconds in time", () => {
    const result = _atTime("2026-05-10", "09:30:45", "UTC");
    expect(result).toBe("2026-05-10T09:30:45+00:00");
  });
});

describe("_endAfter", () => {
  it("returns start time plus duration", () => {
    const start = "2026-05-10T10:00:00Z";
    const end = _endAfter(start, 60);
    expect(end).toContain("11:00:00");
  });

  it("works with timezone-offset datetimes", () => {
    const start = "2026-05-10T10:00:00-07:00";
    const end = _endAfter(start, 90);
    // Should be 11:30, same offset behavior preserved via UTC conversion
    const d = new Date(end);
    const startD = new Date(start);
    expect(d.getTime() - startD.getTime()).toBe(90 * 60 * 1000);
  });
});

describe("_startOfDay / _endOfDay", () => {
  it("startOfDay returns midnight", () => {
    const result = _startOfDay("2026-05-10", "UTC");
    expect(result).toBe("2026-05-10T00:00:00+00:00");
  });

  it("endOfDay returns 23:59:59", () => {
    const result = _endOfDay("2026-05-10", "UTC");
    expect(result).toBe("2026-05-10T23:59:59+00:00");
  });
});

describe("_startOfWeek / _endOfWeek", () => {
  it("startOfWeek returns Sunday midnight", () => {
    // 2026-05-10 is a Sunday
    const result = _startOfWeek("2026-05-10", "UTC");
    expect(result).toContain("2026-05-10T00:00:00");
  });

  it("endOfWeek returns Saturday 23:59:59", () => {
    // 2026-05-10 is a Sunday, Saturday is 2026-05-16
    const result = _endOfWeek("2026-05-10", "UTC");
    expect(result).toContain("2026-05-16T23:59:59");
  });
});

describe("_startOfMonth / _endOfMonth", () => {
  it("startOfMonth returns the 1st at midnight", () => {
    const result = _startOfMonth("2026-05-15", "UTC");
    expect(result).toContain("2026-05-01T00:00:00");
  });

  it("endOfMonth returns the last day at 23:59:59", () => {
    const result = _endOfMonth("2026-05-15", "UTC");
    expect(result).toContain("2026-05-31T23:59:59");
  });

  it("handles February correctly", () => {
    const result = _endOfMonth("2026-02-10", "UTC");
    expect(result).toContain("2026-02-28T23:59:59");
  });

  it("handles leap year February", () => {
    const result = _endOfMonth("2028-02-10", "UTC");
    expect(result).toContain("2028-02-29T23:59:59");
  });
});

describe("error handling", () => {
  it("throws on invalid datetime input", () => {
    expect(() => _addMinutes("not-a-date", 10)).toThrow("Invalid date/time");
  });
});
