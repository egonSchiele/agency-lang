import { describe, expect, it } from "vitest";
import { multiLineCommentParser } from "./parsers.js";

describe("multiLineCommentParser", () => {
  const testCases = [
    {
      input: "/* this is a comment */",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: " this is a comment ", isDoc: false, isModuleDoc: false },
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
          isModuleDoc: false,
        },
      },
    },
    {
      input: "/*no spaces*/",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: "no spaces", isDoc: false, isModuleDoc: false },
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
          isModuleDoc: false,
        },
      },
    },
    {
      input: "/**/",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: "", isDoc: false, isModuleDoc: false },
      },
    },
    // Doc comment cases
    {
      input: "/** this is a doc comment */",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: " this is a doc comment ", isDoc: true, isModuleDoc: false },
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
          isModuleDoc: false,
        },
      },
    },
    {
      input: "/***/",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: "", isDoc: true, isModuleDoc: false },
      },
    },
    // @module doc comment cases
    {
      input: "/** @module This is a module doc comment. */",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: " This is a module doc comment. ", isDoc: true, isModuleDoc: true },
      },
    },
    {
      input: "/** @module\n  Multi-line module doc.\n*/",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: "\n  Multi-line module doc.\n", isDoc: true, isModuleDoc: true },
      },
    },
    {
      input: "/** Not a module doc */",
      expected: {
        success: true,
        result: { type: "multiLineComment", content: " Not a module doc ", isDoc: true, isModuleDoc: false },
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
