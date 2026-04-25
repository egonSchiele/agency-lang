import { describe, expect, it } from "vitest";
import { multiLineCommentParser } from "./parsers.js";

describe("multiLineCommentParser", () => {
  const testCases = [
    {
      input: "/* this is a comment */",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: " this is a comment ", isDoc: false },
      },
    },
    {
      input: "/* multi\nline\ncomment */",
      expected: {
        success: true,
        result: {
          type: "multiLineComment",
          content: " multi\nline\ncomment ",
          isDoc: false,
        },
      },
    },
    {
      input: "/*no spaces*/",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: "no spaces", isDoc: false },
      },
    },
    {
      input: "/* comment with special chars !@# */",
      expected: {
        success: true,
        result: {
          type: "multiLineComment",
          content: " comment with special chars !@# ",
          isDoc: false,
        },
      },
    },
    {
      input: "/**/",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: "", isDoc: false },
      },
    },
    // Doc comment cases
    {
      input: "/** this is a doc comment */",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: " this is a doc comment ", isDoc: true },
      },
    },
    {
      input: "/** multi\nline\ndoc comment */",
      expected: {
        success: true,
        result: {
          type: "multiLineComment",
          content: " multi\nline\ndoc comment ",
          isDoc: true,
        },
      },
    },
    {
      input: "/***/",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: "", isDoc: true },
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
          expect(result.result).toEqualWithoutLoc(expected.result);
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
