import { describe, it, expect } from "vitest";
import { forLoopParser } from "./parsers.js";

describe("forLoopParser", () => {
  const testCases = [
    // Basic for-in
    {
      input: "for (user in users) {\n  process(user)\n}",
      expected: {
        success: true,
        result: {
          type: "forLoop",
          itemVar: "user",
          iterable: { type: "variableName", value: "users" },
          body: [
            {
              type: "functionCall",
              functionName: "process",
              arguments: [{ type: "variableName", value: "user" }],
            },
            { type: "newLine" },
          ],
        },
      },
    },

    // Range call as iterable
    {
      input: "for (i in range(0, 10)) {\n  x = i\n}",
      expected: {
        success: true,
        result: {
          type: "forLoop",
          itemVar: "i",
          iterable: {
            type: "functionCall",
            functionName: "range",
            arguments: [
              { type: "number", value: "0" },
              { type: "number", value: "10" },
            ],
          },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "variableName", value: "i" },
            },
            { type: "newLine" },
          ],
        },
      },
    },

    // With index variable
    {
      input: "for (item, index in items) {\n  x = index\n}",
      expected: {
        success: true,
        result: {
          type: "forLoop",
          itemVar: "item",
          indexVar: "index",
          iterable: { type: "variableName", value: "items" },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "variableName", value: "index" },
            },
            { type: "newLine" },
          ],
        },
      },
    },

    // Value access as iterable
    {
      input: "for (item in obj.items) {\n  x = 1\n}",
      expected: {
        success: true,
        result: {
          type: "forLoop",
          itemVar: "item",
          iterable: {
            type: "valueAccess",
            base: { type: "variableName", value: "obj" },
            chain: [{ kind: "property", name: "items" }],
          },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
            { type: "newLine" },
          ],
        },
      },
    },

    // Empty body
    {
      input: "for (x in xs) {\n}",
      expected: {
        success: true,
        result: {
          type: "forLoop",
          itemVar: "x",
          iterable: { type: "variableName", value: "xs" },
          body: [],
        },
      },
    },

    // Minimal spacing
    {
      input: "for(i in items){\nx=1\n}",
      expected: {
        success: true,
        result: {
          type: "forLoop",
          itemVar: "i",
          iterable: { type: "variableName", value: "items" },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
            { type: "newLine" },
          ],
        },
      },
    },

    // Extra spacing
    {
      input: "for  (  item  ,  idx  in  list  )  {\n  x = 1\n}",
      expected: {
        success: true,
        result: {
          type: "forLoop",
          itemVar: "item",
          indexVar: "idx",
          iterable: { type: "variableName", value: "list" },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
            { type: "newLine" },
          ],
        },
      },
    },

    // Same variable name for item and index
    {
      input: "for (x, x in xs) {\n  foo = 1\n}",
      expected: {
        success: true,
        result: {
          type: "forLoop",
          itemVar: "x",
          indexVar: "x",
          iterable: { type: "variableName", value: "xs" },
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
            { type: "newLine" },
          ],
        },
      },
    },

    // Failure cases
    {
      input: "for x in xs {\n  foo = 1\n}",
      expected: { success: false },
    },
    {
      input: "for (x xs) {\n  foo = 1\n}",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
    {
      input: "for",
      expected: { success: false },
    },
    {
      input: "for (x in xs)",
      expected: { success: false },
      throws: true,
    },
  ];

  testCases.forEach(({ input, expected, throws }: any) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = forLoopParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqualWithoutLoc(expected.result);
        }
      });
    } else if (throws) {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        expect(() => forLoopParser(input)).toThrow();
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = forLoopParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
