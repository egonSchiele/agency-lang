import { describe, it, expect } from "vitest";
import {
  presetToCron,
  validateCron,
  formatSchedule,
  nextRun,
  resolveCron,
  cronToOnCalendar,
} from "./cron.js";

describe("presetToCron", () => {
  it("maps hourly", () => expect(presetToCron("hourly")).toBe("0 * * * *"));
  it("maps daily", () => expect(presetToCron("daily")).toBe("0 9 * * *"));
  it("maps weekdays", () => expect(presetToCron("weekdays")).toBe("0 9 * * 1-5"));
  it("maps weekly", () => expect(presetToCron("weekly")).toBe("0 9 * * 1"));
  it("throws on unknown preset", () => {
    expect(() => presetToCron("biweekly")).toThrow("Unknown preset");
  });
});

describe("validateCron", () => {
  it("accepts valid 5-field expressions", () => {
    expect(validateCron("0 9 * * *")).toBe(true);
    expect(validateCron("*/15 * * * *")).toBe(true);
    expect(validateCron("0 9 * * 1-5")).toBe(true);
    expect(validateCron("30 14 1 * *")).toBe(true);
  });
  it("rejects invalid expressions", () => {
    expect(validateCron("not a cron")).toBe(false);
    expect(validateCron("* * *")).toBe(false);
    expect(validateCron("")).toBe(false);
    expect(validateCron("* * * * * *")).toBe(false);
  });
});

describe("resolveCron", () => {
  it("resolves a preset", () => {
    expect(resolveCron({ every: "daily" })).toEqual({
      cron: "0 9 * * *",
      preset: "daily",
    });
  });
  it("resolves a raw cron expression", () => {
    expect(resolveCron({ cron: "*/15 * * * *" })).toEqual({
      cron: "*/15 * * * *",
      preset: "",
    });
  });
  it("throws if neither provided", () => {
    expect(() => resolveCron({})).toThrow("--every or --cron");
  });
  it("throws on invalid cron", () => {
    expect(() => resolveCron({ cron: "bad" })).toThrow("Invalid cron expression");
  });
});

describe("formatSchedule", () => {
  it("shows preset name when available", () => {
    expect(formatSchedule("0 9 * * 1-5", "weekdays")).toBe("weekdays");
  });
  it("shows raw cron when no preset", () => {
    expect(formatSchedule("*/15 * * * *", "")).toBe("*/15 * * * *");
  });
});

describe("nextRun", () => {
  it("returns a Date in the future", () => {
    const next = nextRun("* * * * *");
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });
  it("returns within 60s for minutely cron", () => {
    const next = nextRun("* * * * *");
    const diffMs = next.getTime() - Date.now();
    expect(diffMs).toBeLessThanOrEqual(60_000);
    expect(diffMs).toBeGreaterThan(0);
  });
});

describe("cronToOnCalendar", () => {
  it("converts daily at 9am", () => {
    expect(cronToOnCalendar("0 9 * * *")).toBe("*-*-* 09:00:00");
  });
  it("converts weekdays at 9am", () => {
    expect(cronToOnCalendar("0 9 * * 1-5")).toBe(
      "Mon,Tue,Wed,Thu,Fri *-*-* 09:00:00",
    );
  });
  it("converts hourly", () => {
    expect(cronToOnCalendar("0 * * * *")).toBe("*-*-* *:00:00");
  });
});
