import { describe, it, expect } from "vitest";
import { resolveSpendWindow } from "./spendWindow.js";

const NOW = 1_800_000_000_000; // fixed for determinism

describe("resolveSpendWindow", () => {
  it("--since sets [now-Δ, now] and a label", () => {
    const resolved = resolveSpendWindow({ since: "7d" }, NOW);
    expect(resolved.to).toBe(NOW);
    expect(resolved.from).toBe(NOW - 7 * 24 * 3600 * 1000);
    expect(resolved.description).toBe("last 7d");
  });
  it("throws when --since combines with --from/--to", () => {
    expect(() => resolveSpendWindow({ since: "1d", from: "1000" }, NOW)).toThrow(
      /cannot be combined/,
    );
  });
  it.each(["-1h", "0h", "0.1ms"])("throws on a non-positive/fractional --since %s", (duration) => {
    expect(() => resolveSpendWindow({ since: duration }, NOW)).toThrow();
  });
  it("throws when --since reaches before the epoch", () => {
    expect(() => resolveSpendWindow({ since: "9999d" }, 1000)).toThrow();
  });
  it("throws on a malformed --since string (parseDurationMs)", () => {
    expect(() => resolveSpendWindow({ since: "banana" }, NOW)).toThrow();
  });
  it("accepts --since 0.5s as 500ms", () => {
    expect(resolveSpendWindow({ since: "0.5s" }, NOW).from).toBe(NOW - 500);
  });
  it("trims --since before parsing and displaying it", () => {
    expect(resolveSpendWindow({ since: " 7d " }, NOW).description).toBe("last 7d");
  });
  it("rejects an invalid injected current time before using it", () => {
    expect(() => resolveSpendWindow({ since: "1s" }, 1000.5)).toThrow(/current time/);
  });
  it("parses --from epoch-ms and YYYY-MM-DD (UTC midnight)", () => {
    expect(resolveSpendWindow({ from: "1000" }, NOW).from).toBe(1000);
    expect(resolveSpendWindow({ from: "2026-07-01" }, NOW).from).toBe(
      Date.parse("2026-07-01T00:00:00Z"),
    );
  });
  it("requires a Z/offset on a datetime, rejects bare local + junk + out-of-range", () => {
    expect(() => resolveSpendWindow({ from: "2026-07-01T12:00:00" }, NOW)).toThrow();
    expect(() => resolveSpendWindow({ from: "not-a-date" }, NOW)).toThrow();
    expect(() => resolveSpendWindow({ from: "99999999999999999" }, NOW)).toThrow();
    expect(resolveSpendWindow({ from: "2026-07-01T12:00:00Z" }, NOW).from).toBe(
      Date.parse("2026-07-01T12:00:00Z"),
    );
  });
  it("rejects nonexistent calendar dates instead of normalizing them", () => {
    expect(() => resolveSpendWindow({ from: "2026-02-30" }, NOW)).toThrow(/valid date/);
    expect(() => resolveSpendWindow({ from: "2026-13-01" }, NOW)).toThrow(/valid date/);
    expect(() => resolveSpendWindow({ from: "2026-02-30T12:00:00Z" }, NOW)).toThrow(/valid date/);
  });
  it("rejects from >= to", () => {
    expect(() => resolveSpendWindow({ from: "2000", to: "1000" }, NOW)).toThrow(/before/);
  });
  it("resolves one-sided windows", () => {
    expect(resolveSpendWindow({ from: "1000" }, NOW)).toMatchObject({ from: 1000, to: null });
    expect(resolveSpendWindow({ to: "2000" }, NOW)).toMatchObject({ from: null, to: 2000 });
  });
  it("no flags → all time", () => {
    expect(resolveSpendWindow({}, NOW)).toEqual({ from: null, to: null, description: "all time" });
  });
});
