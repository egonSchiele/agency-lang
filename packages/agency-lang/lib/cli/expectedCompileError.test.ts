import { describe, expect, test } from "vitest";
import {
  findIncompatibleField,
  judgeCompileAttempt,
} from "./expectedCompileError.js";

describe("judgeCompileAttempt", () => {
  test("nonzero exit whose output contains the substring passes", () => {
    const verdict = judgeCompileAttempt("AG2001", {
      exitCode: 1,
      output: "main.agency:3:5 - error AG2001: Type 'string' is not assignable",
    });
    expect(verdict.ok).toBe(true);
  });

  test("nonzero exit without the substring fails and shows both sides", () => {
    const verdict = judgeCompileAttempt("AG2001", {
      exitCode: 1,
      output: "Failed to parse Agency program: unexpected {",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("AG2001");
    expect(verdict.reason).toContain("Failed to parse");
  });

  test("a clean compile fails, naming what was expected", () => {
    const verdict = judgeCompileAttempt("AG8001", {
      exitCode: 0,
      output: "main.agency → main.js (in 12.00ms)",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("compiled");
    expect(verdict.reason).toContain("AG8001");
  });

  test("a timed-out compile fails as a timeout, not as a mismatch", () => {
    const verdict = judgeCompileAttempt("AG8001", {
      exitCode: null,
      output: "",
      killedBy: "timeout",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("timed out");
  });

  test("a suite-aborted compile fails as an abort", () => {
    const verdict = judgeCompileAttempt("AG8001", {
      exitCode: null,
      output: "",
      killedBy: "abort",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("aborted");
  });

  test("a killed compile that printed the substring still fails", () => {
    // Output produced before the kill says nothing about the exit path;
    // treating it as a pass would let a hung compile masquerade as a
    // clean refusal.
    const verdict = judgeCompileAttempt("AG8001", {
      exitCode: null,
      output: "error AG8001: unfilled holes",
      killedBy: "timeout",
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("findIncompatibleField", () => {
  test("a non-empty tests array is incompatible", () => {
    expect(findIncompatibleField({ tests: [{}] })).toBe("tests");
  });

  test("file-level fetchMocks are incompatible", () => {
    expect(findIncompatibleField({ fetchMocks: [] })).toBe("fetchMocks");
  });

  test("file-level llmMocks are incompatible", () => {
    expect(findIncompatibleField({ llmMocks: [] })).toBe("llmMocks");
  });

  test("an absent or empty tests array is fine", () => {
    expect(findIncompatibleField({})).toBe(null);
    expect(findIncompatibleField({ tests: [] })).toBe(null);
  });
});
