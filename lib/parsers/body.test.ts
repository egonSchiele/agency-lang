import { describe, expect, it } from "vitest";
import { bodyParser } from "./function.js";

describe("functionBodyParser", () => {
  const testCases = [
    {
      input: "foo = 1",
      expected: {
        success: true,
        result: [
          {
            type: "assignment",
            variableName: "foo",
            value: { type: "number", value: "1" },
          },
        ],
      },
    },
    {
      input: 'bar = "hello"',
      expected: {
        success: true,
        result: [
          {
            type: "assignment",
            variableName: "bar",
            value: {
              type: "string",
              segments: [{ type: "text", value: "hello" }],
            },
          },
        ],
      },
    },
    {
      input: "bar = `hello`\nfoo",
      expected: {
        success: true,
        result: [
          {
            type: "assignment",
            variableName: "bar",
            value: {
              type: "prompt",
              segments: [{ type: "text", value: "hello" }],
            },
          },
          {
            type: "newLine",
          },
          {
            type: "variableName",
            value: "foo",
          },
        ],
      },
    },
    {
      input: "x = 5\ny = 10",
      expected: {
        success: true,
        result: [
          {
            type: "assignment",
            variableName: "x",
            value: { type: "number", value: "5" },
          },
          {
            type: "newLine",
          },
          {
            type: "assignment",
            variableName: "y",
            value: { type: "number", value: "10" },
          },
        ],
      },
    },
    {
      input: "42",
      expected: {
        success: true,
        result: [
          {
            type: "number",
            value: "42",
          },
        ],
      },
    },
    {
      input: "",
      expected: {
        success: true,
        result: [],
      },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = bodyParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = bodyParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
