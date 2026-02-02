import { describe, it, expect } from "vitest";
import { specialVarNameParser, specialVarParser } from "./specialVar.js";

describe("specialVar parsers", () => {
  describe("specialVarParser", () => {
    const testCases = [
      // Happy path - assigning literals to special vars
      {
        input: '@model = "gpt-4"',
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: { type: "string", segments: [{ type: "text", value: "gpt-4" }] },
          },
        },
      },
      {
        input: "@model = 42",
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: { type: "number", value: "42" },
          },
        },
      },
      {
        input: "@model = `the best model`",
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: {
              type: "prompt",
              segments: [{ type: "text", value: "the best model" }],
            },
          },
        },
      },
      {
        input: "@model = myVariable",
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: { type: "variableName", value: "myVariable" },
          },
        },
      },

      // With optional semicolon
      {
        input: '@model = "gpt-4";',
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: { type: "string", segments: [{ type: "text", value: "gpt-4" }] },
          },
        },
      },
      {
        input: '@model="gpt-4"',
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: { type: "string", segments: [{ type: "text", value: "gpt-4" }] },
          },
        },
      },

      // Assigning arrays to special vars
      {
        input: "@model = []",
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: {
              type: "agencyArray",
              items: [],
            },
          },
        },
      },
      {
        input: '@model = ["gpt-4", "claude"]',
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: {
              type: "agencyArray",
              items: [
                { type: "string", segments: [{ type: "text", value: "gpt-4" }] },
                { type: "string", segments: [{ type: "text", value: "claude" }] },
              ],
            },
          },
        },
      },

      // Assigning objects to special vars
      {
        input: "@model = {}",
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: {
              type: "agencyObject",
              entries: [],
            },
          },
        },
      },
      {
        input: '@model = { name: "gpt-4" }',
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: {
              type: "agencyObject",
              entries: [
                {
                  key: "name",
                  value: { type: "string", segments: [{ type: "text", value: "gpt-4" }] },
                },
              ],
            },
          },
        },
      },
      {
        input: '@model = { name: "gpt-4", version: 4 }',
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: {
              type: "agencyObject",
              entries: [
                {
                  key: "name",
                  value: { type: "string", segments: [{ type: "text", value: "gpt-4" }] },
                },
                {
                  key: "version",
                  value: { type: "number", value: "4" },
                },
              ],
            },
          },
        },
      },

      // Negative numbers
      {
        input: "@model = -100",
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: { type: "number", value: "-100" },
          },
        },
      },

      // Decimal numbers
      {
        input: "@model = 3.14",
        expected: {
          success: true,
          result: {
            type: "specialVar",
            name: "model",
            value: { type: "number", value: "3.14" },
          },
        },
      },

      // Failure cases
      { input: "@model =", expected: { success: false } },
      { input: '@notSpecial = "value"', expected: { success: false } },
      { input: 'model = "value"', expected: { success: false } }, // missing @
      { input: '@Model = "value"', expected: { success: false } }, // wrong case
      { input: '@ model = "value"', expected: { success: false } }, // space after @
      { input: "", expected: { success: false } },
      { input: "@", expected: { success: false } },
      { input: "@model", expected: { success: false } },
      { input: '@"model" = "value"', expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = specialVarParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = specialVarParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });
});
