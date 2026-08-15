import { describe, it, expect } from "vitest";
import { parseDurationMs } from "@/duration.js";

describe("parseDurationMs", () => {
  it("parses each unit to milliseconds", () => {
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("2d")).toBe(172_800_000);
    expect(parseDurationMs("1w")).toBe(604_800_000);
  });

  it("accepts a leading-minus disable value", () => {
    expect(parseDurationMs("-1s")).toBe(-1_000);
  });

  it("throws on a unitless number, with the default label", () => {
    expect(() => parseDurationMs("300")).toThrow(/duration: expected/);
  });

  it("uses the supplied label in the error message", () => {
    expect(() => parseDurationMs("nope", "budget.maxTime")).toThrow(/budget\.maxTime: expected/);
  });

  it("rejects an absurdly long value as too large (fail closed)", () => {
    expect(() => parseDurationMs("9".repeat(320) + "s")).toThrow(/too large/);
  });
});
