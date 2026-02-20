import { describe, expect, it } from "vitest";
import { multiLineCommentParser } from "./multiLineComment.js";

describe("multiLineCommentParser", () => {
  const testCases = [
    {
      input: "/* this is a comment */",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: " this is a comment " },
      },
    },
    {
      input: "/* multi\nline\ncomment */",
      expected: {
        success: true,
        result: {
          type: "multiLineComment",
          content: " multi\nline\ncomment ",
        },
      },
    },
    {
      input: "/*no spaces*/",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: "no spaces" },
      },
    },
    {
      input: "/* comment with special chars !@# */",
      expected: {
        success: true,
        result: {
          type: "multiLineComment",
          content: " comment with special chars !@# ",
        },
      },
    },
    {
      input: "/**/",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: "" },
      },
    },
    // Failure cases
    { input: "// single line comment\n", expected: { success: false } },
    { input: "/* unclosed comment", expected: { success: false } },
    { input: "", expected: { success: false } },
    { input: "not a comment", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = multiLineCommentParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = multiLineCommentParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
