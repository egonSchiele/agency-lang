import { describe, it, expect } from "vitest";
import { buildIntervals } from "./launchd.js";

// Helper: extract all integer values from the XML
function extractIntegers(xml: string): number[] {
  return [...xml.matchAll(/<integer>(\d+)<\/integer>/g)].map((m) => Number(m[1]));
}

function dictCount(xml: string): number {
  return (xml.match(/<dict>/g) || []).length;
}

describe("buildIntervals edge cases", () => {
  // --- */N step expressions ---
  it("*/15 in minute → [0, 15, 30, 45]", () => {
    const result = buildIntervals("*/15 9 * * *");
    const integers = extractIntegers(result);
    expect(integers).toContain(0);
    expect(integers).toContain(15);
    expect(integers).toContain(30);
    expect(integers).toContain(45);
    // 4 minute values × 1 hour value = 4 dicts
    expect(dictCount(result)).toBe(4);
  });

  it("*/2 in hour → [0, 2, 4, ..., 22]", () => {
    const result = buildIntervals("0 */2 * * *");
    const integers = extractIntegers(result);
    const hours = integers.filter((n) => n !== 0); // 0 is the minute
    expect(hours).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    expect(dictCount(result)).toBe(12); // 12 even hours
  });

  it("*/6 in hour → [0, 6, 12, 18]", () => {
    const result = buildIntervals("30 */6 * * *");
    expect(dictCount(result)).toBe(4);
  });

  // --- Range with step ---
  it("1-5/2 in DOW → [1, 3, 5]", () => {
    const result = buildIntervals("0 9 * * 1-5/2");
    // Should produce 3 dicts (Mon, Wed, Fri)
    expect(dictCount(result)).toBe(3);
    const integers = extractIntegers(result);
    expect(integers).toContain(1);
    expect(integers).toContain(3);
    expect(integers).toContain(5);
  });

  // --- Comma lists ---
  it("0,30 in minute → [0, 30]", () => {
    const result = buildIntervals("0,30 9 * * *");
    expect(dictCount(result)).toBe(2);
  });

  // --- Combinations ---
  it("*/15 with weekdays → 4 minutes × 5 days = 20 dicts", () => {
    const result = buildIntervals("*/15 9 * * 1-5");
    expect(dictCount(result)).toBe(20);
  });

  // --- Simple cases (sanity checks) ---
  it("all wildcards → single empty dict", () => {
    const result = buildIntervals("* * * * *");
    expect(dictCount(result)).toBe(1);
    expect(result).not.toContain("<array>");
  });

  it("single values → single dict", () => {
    const result = buildIntervals("0 9 * * *");
    expect(dictCount(result)).toBe(1);
    expect(result).not.toContain("<array>");
    expect(result).toContain("<key>Minute</key>");
    expect(result).toContain("<key>Hour</key>");
  });
});
