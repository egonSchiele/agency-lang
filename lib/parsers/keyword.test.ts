import { describe, it, expect } from "vitest";
import { keywordParser } from "./keyword.js";

describe("keywordParser", () => {
  const testCases = [
    // Happy path - break
    {
      input: "break",
      expected: {
        success: true,
        result: { type: "keyword", value: "break" },
      },
    },
    // Happy path - continue
    {
      input: "continue",
      expected: {
        success: true,
        result: { type: "keyword", value: "continue" },
      },
    },

    // With semicolons
    {
      input: "break;",
      expected: {
        success: true,
        result: { type: "keyword", value: "break" },
      },
    },
    {
      input: "continue;",
      expected: {
        success: true,
        result: { type: "keyword", value: "continue" },
      },
    },

    // Failure cases
    { input: "", expected: { success: false } },
    { input: "return", expected: { success: false } },
    { input: "brea", expected: { success: false } },
    { input: "cont", expected: { success: false } },
    { input: "42", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = keywordParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = keywordParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
