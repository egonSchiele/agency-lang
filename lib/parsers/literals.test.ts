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
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "text", value: "hello" }],
          },
        },
      },
      {
        input: '"world"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "text", value: "world" }],
          },
        },
      },
      {
        input: '"Hello, World!"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "text", value: "Hello, World!" }],
          },
        },
      },

      // Empty string
      {
        input: '""',
        expected: {
          success: true,
          result: { type: "string", segments: [] },
        },
      },

      // Strings with special characters
      {
        input: '"123"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "text", value: "123" }],
          },
        },
      },
      {
        input: '"  spaces  "',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "text", value: "  spaces  " }],
          },
        },
      },
      {
        input: '"tab\there"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "text", value: "tab\there" }],
          },
        },
      },
      {
        input: '"special!@#%^&*()"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "text", value: "special!@#%^&*()" }],
          },
        },
      },
      {
        input: '"single\'quote"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "text", value: "single'quote" }],
          },
        },
      },
      {
        input: '"`backtick`"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "text", value: "`backtick`" }],
          },
        },
      },

      // Strings with interpolation
      {
        input: '"Hello ${name}"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "Hello " },
              { type: "interpolation", variableName: "name" },
            ],
          },
        },
      },
      {
        input: '"${greeting} world"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "interpolation", variableName: "greeting" },
              { type: "text", value: " world" },
            ],
          },
        },
      },
      {
        input: '"The value is ${x} and ${y}"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "The value is " },
              { type: "interpolation", variableName: "x" },
              { type: "text", value: " and " },
              { type: "interpolation", variableName: "y" },
            ],
          },
        },
      },

      // Failure cases
      { input: '"hello', expected: { success: false } },
      { input: 'hello"', expected: { success: false } },
      { input: "'hello'", expected: { success: false } },
      { input: "", expected: { success: false } },
      { input: "hello", expected: { success: false } },
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

  describe("stringParser - string concatenation with + operator", () => {
    const testCases = [
      // String + Variable
      {
        input: '"Hello, " + name',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "Hello, " },
              { type: "interpolation", variableName: "name" },
            ],
          },
        },
      },
      {
        input: '"Value: " + x',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "Value: " },
              { type: "interpolation", variableName: "x" },
            ],
          },
        },
      },

      // Variable + String
      {
        input: 'name + "!"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "interpolation", variableName: "name" },
              { type: "text", value: "!" },
            ],
          },
        },
      },
      {
        input: 'greeting + " world"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "interpolation", variableName: "greeting" },
              { type: "text", value: " world" },
            ],
          },
        },
      },

      // String + Variable + String
      {
        input: '"Hello, " + name + "!"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "Hello, " },
              { type: "interpolation", variableName: "name" },
              { type: "text", value: "!" },
            ],
          },
        },
      },
      {
        input: '"[" + status + "]"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "[" },
              { type: "interpolation", variableName: "status" },
              { type: "text", value: "]" },
            ],
          },
        },
      },

      // String + String
      {
        input: '"Hello, " + "world"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "Hello, " },
              { type: "text", value: "world" },
            ],
          },
        },
      },
      {
        input: '"a" + "b"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "a" },
              { type: "text", value: "b" },
            ],
          },
        },
      },

      // Variable + Variable
      {
        input: "firstName + lastName",
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "interpolation", variableName: "firstName" },
              { type: "interpolation", variableName: "lastName" },
            ],
          },
        },
      },
      {
        input: "x + y",
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "interpolation", variableName: "x" },
              { type: "interpolation", variableName: "y" },
            ],
          },
        },
      },

      // Multiple concatenations (3+ parts)
      {
        input: '"a" + "b" + "c"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "a" },
              { type: "text", value: "b" },
              { type: "text", value: "c" },
            ],
          },
        },
      },
      {
        input: 'firstName + " " + lastName',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "interpolation", variableName: "firstName" },
              { type: "text", value: " " },
              { type: "interpolation", variableName: "lastName" },
            ],
          },
        },
      },
      {
        input: '"[" + tag + "] " + message',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "[" },
              { type: "interpolation", variableName: "tag" },
              { type: "text", value: "] " },
              { type: "interpolation", variableName: "message" },
            ],
          },
        },
      },
      {
        input: 'a + b + c + d',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "interpolation", variableName: "a" },
              { type: "interpolation", variableName: "b" },
              { type: "interpolation", variableName: "c" },
              { type: "interpolation", variableName: "d" },
            ],
          },
        },
      },

      // Concatenation with string interpolation
      {
        input: '"Hello ${x}" + name',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "Hello " },
              { type: "interpolation", variableName: "x" },
              { type: "interpolation", variableName: "name" },
            ],
          },
        },
      },
      {
        input: 'greeting + " ${name}!"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "interpolation", variableName: "greeting" },
              { type: "text", value: " " },
              { type: "interpolation", variableName: "name" },
              { type: "text", value: "!" },
            ],
          },
        },
      },
      {
        input: '"${a}" + "${b}"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "interpolation", variableName: "a" },
              { type: "interpolation", variableName: "b" },
            ],
          },
        },
      },

      // Concatenation without spaces around +
      {
        input: '"hello"+"world"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "hello" },
              { type: "text", value: "world" },
            ],
          },
        },
      },
      {
        input: 'name+"!"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "interpolation", variableName: "name" },
              { type: "text", value: "!" },
            ],
          },
        },
      },

      // Empty strings in concatenation
      {
        input: '"" + name',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "interpolation", variableName: "name" }],
          },
        },
      },
      {
        input: 'name + ""',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "interpolation", variableName: "name" }],
          },
        },
      },
      {
        input: '"" + ""',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [],
          },
        },
      },
      {
        input: '"hello" + "" + "world"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "hello" },
              { type: "text", value: "world" },
            ],
          },
        },
      },

      // Single character strings
      {
        input: '"a" + name',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "text", value: "a" },
              { type: "interpolation", variableName: "name" },
            ],
          },
        },
      },
      {
        input: 'x + "y"',
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [
              { type: "interpolation", variableName: "x" },
              { type: "text", value: "y" },
            ],
          },
        },
      },

      // Failure cases
      // Single variable name should fail (not a string concatenation)
      { input: "name", expected: { success: false } },
      { input: "variableName", expected: { success: false } },
    ];

    testCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse ${JSON.stringify(input)} successfully`, () => {
          const result = stringParser(input);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result).toEqual(expected.result);
          }
        });
      } else {
        it(`should fail to parse ${JSON.stringify(input)}`, () => {
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
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "hello" }],
          },
        },
      },
      {
        input: '"""world"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "world" }],
          },
        },
      },

      // Empty multi-line string
      {
        input: '""""""',
        expected: {
          success: true,
          result: { type: "multiLineString", segments: [] },
        },
      },

      // Multi-line strings with actual newlines
      {
        input: '"""line1\nline2"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "line1\nline2" }],
          },
        },
      },
      {
        input: '"""line1\nline2\nline3"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "line1\nline2\nline3" }],
          },
        },
      },
      {
        input: '"""\nstarts with newline"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "\nstarts with newline" }],
          },
        },
      },
      {
        input: '"""ends with newline\n"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "ends with newline\n" }],
          },
        },
      },

      // Strings with special characters
      {
        input: '"""Hello, World!"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "Hello, World!" }],
          },
        },
      },
      {
        input: '"""123"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "123" }],
          },
        },
      },
      {
        input: '"""  spaces  and  tabs\t\t"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "  spaces  and  tabs\t\t" }],
          },
        },
      },

      // Strings containing single and double quotes
      {
        input: '"""single\'quotes\'here"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "single'quotes'here" }],
          },
        },
      },
      {
        input: '"""double"quotes"here"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: 'double"quotes"here' }],
          },
        },
      },
      {
        input: '"""mixed"and\'quotes"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: `mixed"and'quotes` }],
          },
        },
      },

      // Strings containing backticks
      {
        input: '"""`backtick`"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "`backtick`" }],
          },
        },
      },

      // String interpolation support
      {
        input: '"""${name}"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "interpolation", variableName: "name" }],
          },
        },
      },
      {
        input: '"""Hello, ${name}!"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [
              { type: "text", value: "Hello, " },
              { type: "interpolation", variableName: "name" },
              { type: "text", value: "!" },
            ],
          },
        },
      },
      {
        input: '"""${firstName} ${lastName}"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [
              { type: "interpolation", variableName: "firstName" },
              { type: "text", value: " " },
              { type: "interpolation", variableName: "lastName" },
            ],
          },
        },
      },
      {
        input: '"""line1\n${variable}\nline3"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [
              { type: "text", value: "line1\n" },
              { type: "interpolation", variableName: "variable" },
              { type: "text", value: "\nline3" },
            ],
          },
        },
      },

      // Multiple consecutive newlines
      {
        input: '"""line1\n\n\nline2"""',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "line1\n\n\nline2" }],
          },
        },
      },

      // Mixed whitespace
      {
        input: '"""  \n\t\n  """',
        expected: {
          success: true,
          result: {
            type: "multiLineString",
            segments: [{ type: "text", value: "  \n\t\n  " }],
          },
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
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "text", value: "hello" }],
          },
        },
      },
      {
        input: '""',
        expected: {
          success: true,
          result: { type: "string", segments: [] },
        },
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
        expected: {
          success: true,
          result: {
            type: "string",
            segments: [{ type: "text", value: "123" }],
          },
        },
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
