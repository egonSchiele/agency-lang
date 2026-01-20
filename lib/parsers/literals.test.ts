import { describe, it, expect } from "vitest";
import {
  textSegmentParser,
  interpolationSegmentParser,
  promptParser,
  numberParser,
  stringParser,
  multiLineStringParser,
  variableNameParser,
  literalParser,
} from "./literals.js";

describe("literals parsers", () => {
  describe("textSegmentParser", () => {
    const testCases = [
      // Happy path
      {
        input: "hello`",
        expected: { success: true, result: { type: "text", value: "hello" } },
      },
      {
        input: "hello",
        expected: { success: true, result: { type: "text", value: "hello" } },
      },
      {
        input: "hello world`",
        expected: {
          success: true,
          result: { type: "text", value: "hello world" },
        },
      },
      {
        input: "hello$",
        expected: { success: true, result: { type: "text", value: "hello" } },
      },

      // Edge cases
      {
        input: "a`",
        expected: { success: true, result: { type: "text", value: "a" } },
      },
      {
        input: "spaces   and   tabs\t\t`",
        expected: {
          success: true,
          result: { type: "text", value: "spaces   and   tabs\t\t" },
        },
      },
      {
        input: "123numbers`",
        expected: {
          success: true,
          result: { type: "text", value: "123numbers" },
        },
      },
      {
        input: "special!@#%^&*()chars`",
        expected: {
          success: true,
          result: { type: "text", value: "special!@#%^&*()chars" },
        },
      },

      // Failure cases
      { input: "`", expected: { success: false } },
      { input: "$", expected: { success: false } },
      { input: "", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = textSegmentParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = textSegmentParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("interpolationSegmentParser", () => {
    const testCases = [
      // Happy path
      {
        input: "${foo}",
        expected: {
          success: true,
          result: { type: "interpolation", variableName: "foo" },
        },
      },
      {
        input: "${bar123}",
        expected: {
          success: true,
          result: { type: "interpolation", variableName: "bar123" },
        },
      },
      {
        input: "${x}",
        expected: {
          success: true,
          result: { type: "interpolation", variableName: "x" },
        },
      },

      // Edge cases
      {
        input: "${longVariableNameWithNumbers123}",
        expected: {
          success: true,
          result: {
            type: "interpolation",
            variableName: "longVariableNameWithNumbers123",
          },
        },
      },

      // Failure cases
      { input: "${", expected: { success: false } },
      { input: "${foo", expected: { success: false } },
      { input: "$foo}", expected: { success: false } },
      { input: "{foo}", expected: { success: false } },
      {
        input: "${}",
        expected: {
          success: true,
          result: {
            type: "interpolation",
            variableName: "",
          },
        },
      },
      { input: "", expected: { success: false } },
      { input: "foo", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = interpolationSegmentParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = interpolationSegmentParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("promptParser", () => {
    const testCases = [
      // Simple text prompts
      {
        input: "`hello`",
        expected: {
          success: true,
          result: {
            type: "prompt",
            segments: [{ type: "text", value: "hello" }],
          },
        },
      },
      {
        input: "`the number 1`",
        expected: {
          success: true,
          result: {
            type: "prompt",
            segments: [{ type: "text", value: "the number 1" }],
          },
        },
      },

      // Empty prompt
      {
        input: "``",
        expected: {
          success: true,
          result: {
            type: "prompt",
            segments: [],
          },
        },
      },

      // Prompts with interpolation only
      {
        input: "`${foo}`",
        expected: {
          success: true,
          result: {
            type: "prompt",
            segments: [{ type: "interpolation", variableName: "foo" }],
          },
        },
      },

      // Mixed segments
      {
        input: "`hello ${name}`",
        expected: {
          success: true,
          result: {
            type: "prompt",
            segments: [
              { type: "text", value: "hello " },
              { type: "interpolation", variableName: "name" },
            ],
          },
        },
      },
      {
        input: "`${greeting} world`",
        expected: {
          success: true,
          result: {
            type: "prompt",
            segments: [
              { type: "interpolation", variableName: "greeting" },
              { type: "text", value: " world" },
            ],
          },
        },
      },
      {
        input: "`The value is ${x} and ${y}`",
        expected: {
          success: true,
          result: {
            type: "prompt",
            segments: [
              { type: "text", value: "The value is " },
              { type: "interpolation", variableName: "x" },
              { type: "text", value: " and " },
              { type: "interpolation", variableName: "y" },
            ],
          },
        },
      },

      // Multiple interpolations
      {
        input: "`${a}${b}${c}`",
        expected: {
          success: true,
          result: {
            type: "prompt",
            segments: [
              { type: "interpolation", variableName: "a" },
              { type: "interpolation", variableName: "b" },
              { type: "interpolation", variableName: "c" },
            ],
          },
        },
      },

      // Failure cases
      { input: "`hello", expected: { success: false } },
      { input: "hello`", expected: { success: false } },
      { input: "", expected: { success: false } },
      { input: "hello", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = promptParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = promptParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("numberParser", () => {
    const testCases = [
      // Integers
      {
        input: "42",
        expected: { success: true, result: { type: "number", value: "42" } },
      },
      {
        input: "0",
        expected: { success: true, result: { type: "number", value: "0" } },
      },
      {
        input: "999",
        expected: { success: true, result: { type: "number", value: "999" } },
      },

      // Negative numbers
      {
        input: "-42",
        expected: { success: true, result: { type: "number", value: "-42" } },
      },
      {
        input: "-1",
        expected: { success: true, result: { type: "number", value: "-1" } },
      },

      // Decimals
      {
        input: "3.14",
        expected: { success: true, result: { type: "number", value: "3.14" } },
      },
      {
        input: "0.5",
        expected: { success: true, result: { type: "number", value: "0.5" } },
      },
      {
        input: "100.001",
        expected: {
          success: true,
          result: { type: "number", value: "100.001" },
        },
      },

      // Negative decimals
      {
        input: "-3.14",
        expected: { success: true, result: { type: "number", value: "-3.14" } },
      },
      {
        input: "-0.5",
        expected: { success: true, result: { type: "number", value: "-0.5" } },
      },

      // Edge cases
      {
        input: ".5",
        expected: { success: true, result: { type: "number", value: ".5" } },
      },
      {
        input: "-.5",
        expected: { success: true, result: { type: "number", value: "-.5" } },
      },
      {
        input: "-",
        expected: { success: true, result: { type: "number", value: "-" } },
      },
      {
        input: ".",
        expected: { success: true, result: { type: "number", value: "." } },
      },

      // Failure cases
      { input: "abc", expected: { success: false } },
      { input: "", expected: { success: false } },
      { input: "x123", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = numberParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = numberParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("stringParser", () => {
    const testCases = [
      // Happy path
      {
        input: '"hello"',
        expected: { success: true, result: { type: "string", value: "hello" } },
      },
      {
        input: '"world"',
        expected: { success: true, result: { type: "string", value: "world" } },
      },
      {
        input: '"Hello, World!"',
        expected: {
          success: true,
          result: { type: "string", value: "Hello, World!" },
        },
      },

      // Empty string
      {
        input: '""',
        expected: { success: true, result: { type: "string", value: "" } },
      },

      // Strings with special characters
      {
        input: '"123"',
        expected: { success: true, result: { type: "string", value: "123" } },
      },
      {
        input: '"  spaces  "',
        expected: {
          success: true,
          result: { type: "string", value: "  spaces  " },
        },
      },
      {
        input: '"tab\there"',
        expected: {
          success: true,
          result: { type: "string", value: "tab\there" },
        },
      },
      {
        input: '"special!@#$%^&*()"',
        expected: {
          success: true,
          result: { type: "string", value: "special!@#$%^&*()" },
        },
      },
      {
        input: '"single\'quote"',
        expected: {
          success: true,
          result: { type: "string", value: "single'quote" },
        },
      },
      {
        input: '"`backtick`"',
        expected: {
          success: true,
          result: { type: "string", value: "`backtick`" },
        },
      },

      // Failure cases
      { input: '"hello', expected: { success: false } },
      { input: 'hello"', expected: { success: false } },
      { input: "'hello'", expected: { success: false } },
      { input: "", expected: { success: false } },
      { input: "hello", expected: { success: false } },
      /// use """ for multi-line strings
      {
        input: '"newline\nhere"',
        expected: {
          success: false,
        },
      },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = stringParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = stringParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("multiLineStringParser", () => {
    const testCases = [
      // Happy path - simple strings
      {
        input: '"""hello"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "hello" },
        },
      },
      {
        input: '"""world"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "world" },
        },
      },

      // Empty multi-line string
      {
        input: '""""""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "" },
        },
      },

      // Multi-line strings with actual newlines
      {
        input: '"""line1\nline2"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "line1\nline2" },
        },
      },
      {
        input: '"""line1\nline2\nline3"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "line1\nline2\nline3" },
        },
      },
      {
        input: '"""\nstarts with newline"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "\nstarts with newline" },
        },
      },
      {
        input: '"""ends with newline\n"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "ends with newline\n" },
        },
      },

      // Strings with special characters
      {
        input: '"""Hello, World!"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "Hello, World!" },
        },
      },
      {
        input: '"""123"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "123" },
        },
      },
      {
        input: '"""  spaces  and  tabs\t\t"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "  spaces  and  tabs\t\t" },
        },
      },
      {
        input: '"""special!@#$%^&*()"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "special!@#$%^&*()" },
        },
      },

      // Strings containing single and double quotes
      {
        input: '"""single\'quotes\'here"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "single'quotes'here" },
        },
      },
      {
        input: '"""double"quotes"here"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: 'double"quotes"here' },
        },
      },
      {
        input: '"""mixed"and\'quotes"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: `mixed"and'quotes` },
        },
      },

      // Strings containing backticks and interpolation-like syntax
      {
        input: '"""`backtick`"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "`backtick`" },
        },
      },
      {
        input: '"""${notInterpolation}"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "${notInterpolation}" },
        },
      },

      // Multiple consecutive newlines
      {
        input: '"""line1\n\n\nline2"""',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "line1\n\n\nline2" },
        },
      },

      // Mixed whitespace
      {
        input: '"""  \n\t\n  """',
        expected: {
          success: true,
          result: { type: "multiLineString", value: "  \n\t\n  " },
        },
      },

      // Failure cases
      { input: '"""hello', expected: { success: false } },
      { input: 'hello"""', expected: { success: false } },
      { input: '""hello"""', expected: { success: false } },
      { input: '"""hello""', expected: { success: false } },
      { input: '"hello"', expected: { success: false } },
      { input: "'hello'", expected: { success: false } },
      { input: "", expected: { success: false } },
      { input: "hello", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse ${JSON.stringify(input)} successfully`, () => {
          const result = multiLineStringParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse ${JSON.stringify(input)}`, () => {
          const result = multiLineStringParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("variableNameParser", () => {
    const testCases = [
      // Happy path
      {
        input: "foo",
        expected: {
          success: true,
          result: { type: "variableName", value: "foo" },
        },
      },
      {
        input: "bar",
        expected: {
          success: true,
          result: { type: "variableName", value: "bar" },
        },
      },
      {
        input: "x",
        expected: {
          success: true,
          result: { type: "variableName", value: "x" },
        },
      },
      {
        input: "myVariable",
        expected: {
          success: true,
          result: { type: "variableName", value: "myVariable" },
        },
      },

      // With numbers
      {
        input: "foo123",
        expected: {
          success: true,
          result: { type: "variableName", value: "foo123" },
        },
      },
      {
        input: "x1",
        expected: {
          success: true,
          result: { type: "variableName", value: "x1" },
        },
      },
      {
        input: "var2test",
        expected: {
          success: true,
          result: { type: "variableName", value: "var2test" },
        },
      },

      // Mixed case
      {
        input: "camelCase",
        expected: {
          success: true,
          result: { type: "variableName", value: "camelCase" },
        },
      },
      {
        input: "PascalCase",
        expected: {
          success: true,
          result: { type: "variableName", value: "PascalCase" },
        },
      },
      {
        input: "UPPERCASE",
        expected: {
          success: true,
          result: { type: "variableName", value: "UPPERCASE" },
        },
      },

      // Failure cases
      { input: "", expected: { success: false } },
      // cannot start with number
      {
        input: "1a",
        expected: {
          success: false,
        },
      },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = variableNameParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = variableNameParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("literalParser", () => {
    const testCases = [
      // Prompt literals (highest precedence)
      {
        input: "`hello`",
        expected: {
          success: true,
          result: {
            type: "prompt",
            segments: [{ type: "text", value: "hello" }],
          },
        },
      },
      {
        input: "`${foo}`",
        expected: {
          success: true,
          result: {
            type: "prompt",
            segments: [{ type: "interpolation", variableName: "foo" }],
          },
        },
      },

      // Number literals
      {
        input: "42",
        expected: { success: true, result: { type: "number", value: "42" } },
      },
      {
        input: "-3.14",
        expected: { success: true, result: { type: "number", value: "-3.14" } },
      },

      // String literals
      {
        input: '"hello"',
        expected: { success: true, result: { type: "string", value: "hello" } },
      },
      {
        input: '""',
        expected: { success: true, result: { type: "string", value: "" } },
      },

      // Variable name literals (lowest precedence)
      {
        input: "foo",
        expected: {
          success: true,
          result: { type: "variableName", value: "foo" },
        },
      },
      {
        input: "bar123",
        expected: {
          success: true,
          result: { type: "variableName", value: "bar123" },
        },
      },

      // Precedence tests - numbers vs variable names
      {
        input: "123",
        expected: { success: true, result: { type: "number", value: "123" } },
      },

      // Strings vs other types
      {
        input: '"123"',
        expected: { success: true, result: { type: "string", value: "123" } },
      },

      // Failure cases
      { input: "", expected: { success: false } },
      { input: "`unterminated", expected: { success: false } },
      { input: "'single quotes'", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input}" successfully`, () => {
          const result = literalParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse "${input}"`, () => {
          const result = literalParser(input);
          expect(result.success).toBe(false);
        });
      }
    });
  });
});
