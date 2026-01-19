import { describe, it, expect } from "vitest";
import { optionalSemicolon } from "./parserUtils.js";

describe("parserUtils", () => {
  describe("optionalSemicolon", () => {
    const testCases = [
      // Happy path - semicolon present
      {
        input: ";",
        expected: { success: true, result: ";" },
      },
      {
        input: ";rest",
        expected: { success: true, result: ";", rest: "rest" },
      },

      // Happy path - no semicolon (optional means success even without match)
      {
        input: "",
        expected: { success: true, result: null },
      },
      {
        input: "other",
        expected: { success: true, result: null, rest: "other" },
      },
      {
        input: " ;",
        expected: { success: true, result: null, rest: " ;" },
      },
      {
        input: ";;",
        expected: { success: true, result: ";", rest: ";" },
      },
    ];

    testCases.forEach(({ input, expected }) => {
      it(`should parse "${input}" successfully`, () => {
        const result = optionalSemicolon(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
          if (expected.rest !== undefined) {
            expect(result.rest).toEqual(expected.rest);
          }
        }
      });
    });
  });
});
