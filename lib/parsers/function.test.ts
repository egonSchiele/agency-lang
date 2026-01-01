import { describe, it, expect } from "vitest";
import { functionBodyParser, functionParser, docStringParser } from "./function";

describe("docStringParser", () => {
  const testCases = [
    // Happy path - basic docstrings
    {
      input: '"""This is a docstring"""',
      expected: {
        success: true,
        result: { type: "docString", value: "This is a docstring" },
      },
    },
    {
      input: '"""Simple description"""',
      expected: {
        success: true,
        result: { type: "docString", value: "Simple description" },
      },
    },

    // Docstrings with whitespace
    {
      input: '"""  Leading and trailing spaces  """',
      expected: {
        success: true,
        result: { type: "docString", value: "Leading and trailing spaces" },
      },
    },
    {
      input: '"""\nMultiline\ndocstring\n"""',
      expected: {
        success: true,
        result: { type: "docString", value: "Multiline\ndocstring" },
      },
    },

    // Empty docstring (fails because many1Till requires at least one char)
    {
      input: '""""""',
      expected: { success: false },
    },
    // Docstring with only whitespace
    {
      input: '"""   """',
      expected: {
        success: true,
        result: { type: "docString", value: "" },
      },
    },

    // Docstrings with special characters
    {
      input: '"""Docstring with numbers: 123, 456"""',
      expected: {
        success: true,
        result: {
          type: "docString",
          value: "Docstring with numbers: 123, 456",
        },
      },
    },
    {
      input: '"""Special chars: !@#$%^&*()"""',
      expected: {
        success: true,
        result: { type: "docString", value: "Special chars: !@#$%^&*()" },
      },
    },
    {
      input: '"""Code example: x = 5"""',
      expected: {
        success: true,
        result: { type: "docString", value: "Code example: x = 5" },
      },
    },

    // Docstrings with punctuation
    {
      input: '"""This function does something. It takes params."""',
      expected: {
        success: true,
        result: {
          type: "docString",
          value: "This function does something. It takes params.",
        },
      },
    },
    {
      input: '"""Returns: the result"""',
      expected: {
        success: true,
        result: { type: "docString", value: "Returns: the result" },
      },
    },

    // Failure cases
    { input: '"This is not a docstring"', expected: { success: false } },
    { input: '""incomplete', expected: { success: false } },
    { input: 'incomplete"""', expected: { success: false } },
    { input: '"""no closing', expected: { success: false } },
    { input: "", expected: { success: false } },
    { input: "text", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = docStringParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = docStringParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("functionBodyParser", () => {
  const testCases = [
    {
      input: "foo = 1",
      expected: {
        success: true,
        result: [
          {
            type: "returnStatement",
            value: {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
            },
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
            type: "returnStatement",
            value: {
              type: "assignment",
              variableName: "bar",
              value: { type: "string", value: "hello" },
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
            type: "returnStatement",
            value: { type: "variableName", value: "foo" },
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
            type: "returnStatement",
            value: {
              type: "assignment",
              variableName: "y",
              value: { type: "number", value: "10" },
            },
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
            type: "returnStatement",
            value: { type: "number", value: "42" },
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
        const result = functionBodyParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = functionBodyParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("functionParser", () => {
  const testCases = [
    {
      input: "def test() { foo = 1 }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "test",
          body: [
            {
              type: "returnStatement",
              value: {
                type: "assignment",
                variableName: "foo",
                value: { type: "number", value: "1" },
              },
            },
          ],
        },
      },
    },
    {
      input: "def greet() { bar = `say hello` }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "greet",
          body: [
            {
              type: "returnStatement",
              value: {
                type: "assignment",
                variableName: "bar",
                value: {
                  type: "prompt",
                  segments: [{ type: "text", value: "say hello" }],
                },
              },
            },
          ],
        },
      },
    },
    {
      input: "def calculate() { x = 5\ny = 10 }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "calculate",
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "5" },
            },
            {
              type: "returnStatement",
              value: {
                type: "assignment",
                variableName: "y",
                value: { type: "number", value: "10" },
              },
            },
          ],
        },
      },
    },
    {
      input: "def empty() {}",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "empty",
          body: [],
        },
      },
    },
    {
      input: "def withSpaces() {  foo = 1  }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "withSpaces",
          body: [
            {
              type: "returnStatement",
              value: {
                type: "assignment",
                variableName: "foo",
                value: { type: "number", value: "1" },
              },
            },
          ],
        },
      },
    },
    {
      input: "def noSpaces(){foo=1}",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "noSpaces",
          body: [
            {
              type: "returnStatement",
              value: {
                type: "assignment",
                variableName: "foo",
                value: { type: "number", value: "1" },
              },
            },
          ],
        },
      },
    },
    {
      input: "def multiline() {\n  x = 5\n  y = 10\n}",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "multiline",
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "5" },
            },
            {
              type: "returnStatement",
              value: {
                type: "assignment",
                variableName: "y",
                value: { type: "number", value: "10" },
              },
            },
          ],
        },
      },
    },
    {
      input: "test() { foo = 1 }",
      expected: { success: false },
    },
    {
      input: "def test { foo = 1 }",
      expected: { success: false },
    },
    {
      input: "def test() foo = 1",
      expected: { success: false },
    },
    {
      input: "def () { foo = 1 }",
      expected: { success: false },
    },
    {
      input: "def test() {",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
    // Functions with docstrings
    {
      input: 'def test() { """This is a test function"""\nfoo = 1 }',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "test",
          docString: {
            type: "docString",
            value: "This is a test function",
          },
          body: [
            {
              type: "returnStatement",
              value: {
                type: "assignment",
                variableName: "foo",
                value: { type: "number", value: "1" },
              },
            },
          ],
        },
      },
    },
    {
      input: 'def greet() {\n  """Greets the user"""\n  bar = `say hello`\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "greet",
          docString: {
            type: "docString",
            value: "Greets the user",
          },
          body: [
            {
              type: "returnStatement",
              value: {
                type: "assignment",
                variableName: "bar",
                value: {
                  type: "prompt",
                  segments: [{ type: "text", value: "say hello" }],
                },
              },
            },
          ],
        },
      },
    },
    {
      input: 'def calculate() { """Calculate something"""\nx = 5\ny = 10 }',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "calculate",
          docString: {
            type: "docString",
            value: "Calculate something",
          },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "5" },
            },
            {
              type: "returnStatement",
              value: {
                type: "assignment",
                variableName: "y",
                value: { type: "number", value: "10" },
              },
            },
          ],
        },
      },
    },
    {
      input: 'def empty() { """Empty function with docstring""" }',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "empty",
          docString: {
            type: "docString",
            value: "Empty function with docstring",
          },
          body: [],
        },
      },
    },
    {
      input:
        'def multilineDoc() {\n  """\n  This is a multi-line\n  docstring\n  """\n  x = 5\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "multilineDoc",
          docString: {
            type: "docString",
            value: "This is a multi-line\n  docstring",
          },
          body: [
            {
              type: "returnStatement",
              value: {
                type: "assignment",
                variableName: "x",
                value: { type: "number", value: "5" },
              },
            },
          ],
        },
      },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = functionParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = functionParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});