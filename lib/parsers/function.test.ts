import { describe, it, expect } from "vitest";
import { functionParser, docStringParser } from "./function.js";

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

describe("functionParser", () => {
  const testCases = [
    {
      input: "def test() { foo = 1 }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "test",
          parameters: [],
          docString: undefined,
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
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
          parameters: [],
          docString: undefined,
          body: [
            {
              type: "assignment",
              variableName: "bar",
              value: {
                type: "prompt",
                segments: [{ type: "text", value: "say hello" }],
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
          parameters: [],
          docString: undefined,
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "5" },
            },
            {
              type: "assignment",
              variableName: "y",
              value: { type: "number", value: "10" },
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
          parameters: [],
          docString: undefined,
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
          parameters: [],
          docString: undefined,
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
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
          parameters: [],
          docString: undefined,
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
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
          parameters: [],
          docString: undefined,
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "5" },
            },
            {
              type: "assignment",
              variableName: "y",
              value: { type: "number", value: "10" },
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
          parameters: [],
          docString: {
            type: "docString",
            value: "This is a test function",
          },
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: { type: "number", value: "1" },
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
          parameters: [],
          docString: {
            type: "docString",
            value: "Greets the user",
          },
          body: [
            {
              type: "assignment",
              variableName: "bar",
              value: {
                type: "prompt",
                segments: [{ type: "text", value: "say hello" }],
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
          parameters: [],
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
              type: "assignment",
              variableName: "y",
              value: { type: "number", value: "10" },
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
          parameters: [],
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
          parameters: [],
          docString: {
            type: "docString",
            value: "This is a multi-line\n  docstring",
          },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "5" },
            },
          ],
        },
      },
    },
    // Functions with one parameter
    {
      input: "def add(x) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "add",
          parameters: [{ type: "functionParameter", name: "x" }],
          docString: undefined,
          body: [
            {
              type: "variableName",
              value: "x",
            },
          ],
        },
      },
    },
    {
      input: "def greet(name) { bar = `say hello to ${name}` }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "greet",
          parameters: [{ type: "functionParameter", name: "name" }],
          docString: undefined,
          body: [
            {
              type: "assignment",
              variableName: "bar",
              value: {
                type: "prompt",
                segments: [
                  { type: "text", value: "say hello to " },
                  { type: "interpolation", variableName: "name" },
                ],
              },
            },
          ],
        },
      },
    },
    // Functions with multiple parameters
    {
      input: "def add(x, y) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "add",
          parameters: [
            { type: "functionParameter", name: "x" },
            { type: "functionParameter", name: "y" },
          ],
          docString: undefined,
          body: [
            {
              type: "variableName",
              value: "x",
            },
          ],
        },
      },
    },
    {
      input: "def calculate(a, b, c) { result = 42\nresult }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "calculate",
          parameters: [
            { type: "functionParameter", name: "a" },
            { type: "functionParameter", name: "b" },
            { type: "functionParameter", name: "c" },
          ],
          docString: undefined,
          body: [
            {
              type: "assignment",
              variableName: "result",
              value: { type: "number", value: "42" },
            },
            {
              type: "variableName",
              value: "result",
            },
          ],
        },
      },
    },
    {
      input: "def multiply(x,y) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "multiply",
          parameters: [
            { type: "functionParameter", name: "x" },
            { type: "functionParameter", name: "y" },
          ],
          docString: undefined,
          body: [
            {
              type: "variableName",
              value: "x",
            },
          ],
        },
      },
    },
    {
      input: "def process(  a  ,  b  ) { a }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "process",
          parameters: [
            { type: "functionParameter", name: "a" },
            { type: "functionParameter", name: "b" },
          ],
          docString: undefined,
          body: [
            {
              type: "variableName",
              value: "a",
            },
          ],
        },
      },
    },
    // Functions with parameters and docstring
    {
      input: 'def add(x, y) { """Adds two numbers"""\nx }',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "add",
          parameters: [
            { type: "functionParameter", name: "x" },
            { type: "functionParameter", name: "y" },
          ],
          docString: {
            type: "docString",
            value: "Adds two numbers",
          },
          body: [
            {
              type: "variableName",
              value: "x",
            },
          ],
        },
      },
    },
    {
      input:
        'def greet(name, greeting) {\n  """Greets someone with a custom greeting"""\n  result = `${greeting} ${name}`\n  result\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "greet",
          parameters: [
            { type: "functionParameter", name: "name" },
            { type: "functionParameter", name: "greeting" },
          ],
          docString: {
            type: "docString",
            value: "Greets someone with a custom greeting",
          },
          body: [
            {
              type: "assignment",
              variableName: "result",
              value: {
                type: "prompt",
                segments: [
                  { type: "interpolation", variableName: "greeting" },
                  { type: "text", value: " " },
                  { type: "interpolation", variableName: "name" },
                ],
              },
            },
            {
              type: "variableName",
              value: "result",
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
