import { describe, test, expect } from "vitest";
import { resolveBudget, parseDurationMs } from "@/cli/budget.js";

describe("parseDurationMs", () => {
  test("parses unit-suffixed durations", () => {
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
  });
  test("accepts a leading minus (disable value)", () => {
    expect(parseDurationMs("-1s")).toBe(-1_000);
  });
  test("accepts days and weeks (documented units)", () => {
    expect(parseDurationMs("2d")).toBe(172_800_000);
    expect(parseDurationMs("1w")).toBe(604_800_000);
  });
  test("rejects a duration that overflows to Infinity", () => {
    expect(() => parseDurationMs("9".repeat(320) + "s")).toThrow(/too large/);
  });
  test("rejects a bare unitless number", () => {
    expect(() => parseDurationMs("300")).toThrow(/duration/i);
  });
  test("rejects garbage", () => {
    expect(() => parseDurationMs("soon")).toThrow(/duration/i);
  });
});

describe("resolveBudget", () => {
  test("cost: passes through numeric dollars, incl. 0 and negative", () => {
    expect(resolveBudget({ maxCost: "0.50" }).maxCost).toBe("0.5");
    expect(resolveBudget({ maxCost: "0" }).maxCost).toBe("0");
    expect(resolveBudget({ maxCost: "-1" }).maxCost).toBe("-1");
  });
  test("cost: rejects non-numeric", () => {
    expect(() => resolveBudget({ maxCost: "abc" })).toThrow(/max-cost/i);
  });
  test("time: converts to ms string", () => {
    expect(resolveBudget({ maxTime: "5m" }).maxTime).toBe("300000");
    expect(resolveBudget({ maxTime: "-1s" }).maxTime).toBe("-1000");
  });
  test("time: rejects a bare number", () => {
    expect(() => resolveBudget({ maxTime: "300" })).toThrow(/max-time/i);
  });
  test("omitted flags produce no env values", () => {
    expect(resolveBudget({})).toEqual({});
  });
});
