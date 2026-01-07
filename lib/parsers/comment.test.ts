import { describe, expect, it } from "vitest";
import { commentParser } from "./comment.js";

describe("commentParser", () => {
  const testCases = [
    // Happy path - basic comments
    {
      input: "// this is a comment\n",
      expected: {
        success: true,
        result: { type: "comment", content: " this is a comment" },
      },
    },
    {
      input: "// hello world\n",
      expected: {
        success: true,
        result: { type: "comment", content: " hello world" },
      },
    },
    {
      input: "//no space after slashes\n",
      expected: {
        success: true,
        result: { type: "comment", content: "no space after slashes" },
      },
    },

    // Comments with special characters
    {
      input: "// comment with numbers 123\n",
      expected: {
        success: true,
        result: { type: "comment", content: " comment with numbers 123" },
      },
    },
    {
      input: "// special chars !@#$%^&*()\n",
      expected: {
        success: true,
        result: { type: "comment", content: " special chars !@#$%^&*()" },
      },
    },
    {
      input: "// code comment: x = 5\n",
      expected: {
        success: true,
        result: { type: "comment", content: " code comment: x = 5" },
      },
    },

    // Empty comment (fails because many1Till requires at least one char)
    {
      input: "//\n",
      expected: { success: false },
    },

    // Comments with tabs and spaces
    {
      input: "//   multiple   spaces   \n",
      expected: {
        success: true,
        result: { type: "comment", content: "   multiple   spaces   " },
      },
    },
    {
      input: "//\ttab character\n",
      expected: {
        success: true,
        result: { type: "comment", content: "\ttab character" },
      },
    },

    // Comments without newline (succeeds, consumes until EOF)
    {
      input: "// comment without newline",
      expected: {
        success: true,
        result: { type: "comment", content: " comment without newline" },
      },
    },

    // Failure cases
    { input: "/ single slash\n", expected: { success: false } },
    { input: "# not a comment\n", expected: { success: false } },
    { input: "", expected: { success: false } },
    { input: "text // comment\n", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = commentParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = commentParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
