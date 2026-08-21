import { describe, test, expect } from "vitest";
import { exactVerdict, exactVerdictValue } from "./verdict.js";

describe("exactVerdictValue", () => {
  test("nested object key order is ignored", () => {
    expect(
      exactVerdictValue({ b: { d: 4, c: 3 }, a: 1 }, { a: 1, b: { c: 3, d: 4 } }).pass,
    ).toBe(true);
  });

  test("arrays, booleans, null, negative and exponent numbers compare correctly", () => {
    expect(exactVerdictValue([1, 2, 3], [1, 2, 3]).pass).toBe(true);
    expect(exactVerdictValue([1, 2, 3], [3, 2, 1]).pass).toBe(false);
    expect(exactVerdictValue(true, true).pass).toBe(true);
    expect(exactVerdictValue(null, null).pass).toBe(true);
    expect(exactVerdictValue(-5, -5).pass).toBe(true);
    expect(exactVerdictValue(1e5, 100000).pass).toBe(true);
    expect(exactVerdictValue(5, "5").pass).toBe(false);
  });

  test("a mismatch carries a useful diff in feedback", () => {
    const verdict = exactVerdictValue({ a: 1 }, { a: 2 });
    expect(verdict.pass).toBe(false);
    if (!verdict.pass) {
      expect(verdict.feedback).toContain('"a":2');
      expect(verdict.feedback).toContain('"a":1');
    }
  });
});

describe("exactVerdict (wire form)", () => {
  test("parses expectedOutput and compares structurally", () => {
    expect(exactVerdict({ a: 1, b: 2 }, '{"b":2,"a":1}', { rawStringFallback: true }).pass).toBe(
      true,
    );
  });

  test("rawStringFallback=true: unparseable expectedOutput falls back to the legacy raw comparison", () => {
    // JSON.stringify("ok") is '"ok"', so a bare `ok` only matches via the
    // fallback when the actual stringifies to exactly that text.
    expect(exactVerdict("ok", '"ok"', { rawStringFallback: true }).pass).toBe(true);
    const bare = exactVerdict("ok", "ok", { rawStringFallback: true });
    expect(bare.pass).toBe(false);
  });

  test("rawStringFallback=false: unparseable expectedOutput throws with quoting guidance", () => {
    expect(() => exactVerdict("ok", "ok", { rawStringFallback: false })).toThrow(/quoted/i);
  });
});
