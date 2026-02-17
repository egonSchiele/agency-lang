import { describe, it, expect } from "vitest";
import {
  functionParser,
  asyncFunctionParser,
  syncFunctionParser,
  docStringParser,
  graphNodeParser,
  timeBlockParser,
  messageThreadParser,
  _messageThreadParser,
  _submessageThreadParser,
} from "./function.js";
import { normalizeCode } from "@/parser.js";

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
          returnType: null,
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
          returnType: null,
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
          returnType: null,
          docString: undefined,
          body: [
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
    },
    {
      input: "def empty() {}",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "empty",
          parameters: [],
          returnType: null,
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
          returnType: null,
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
          returnType: null,
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
          returnType: null,
          docString: undefined,
          body: [
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
            {
              type: "newLine",
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
      throws: true,
    },
    {
      input: "def () { foo = 1 }",
      expected: { success: false },
    },
    {
      input: "def test() {",
      expected: { success: false },
      throws: true,
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
          returnType: null,
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
          returnType: null,
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
            {
              type: "newLine",
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
          returnType: null,
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
    },
    {
      input: 'def empty() { """Empty function with docstring""" }',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "empty",
          parameters: [],
          returnType: null,
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
          returnType: null,
          docString: {
            type: "docString",
            value: "This is a multi-line\ndocstring",
          },
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "5" },
            },
            {
              type: "newLine",
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
          returnType: null,
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
          returnType: null,
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
          returnType: null,
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
          returnType: null,
          docString: undefined,
          body: [
            {
              type: "assignment",
              variableName: "result",
              value: { type: "number", value: "42" },
            },
            {
              type: "newLine",
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
          returnType: null,
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
          returnType: null,
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
          returnType: null,
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

    // Functions with single parameter with type hint
    {
      input: "def add(x: number) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "add",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    {
      input: "def greet(name: string) { name }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "greet",
          parameters: [
            {
              type: "functionParameter",
              name: "name",
              typeHint: { type: "primitiveType", value: "string" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "name" }],
        },
      },
    },
    {
      input: "def check(active: boolean) { active }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "check",
          parameters: [
            {
              type: "functionParameter",
              name: "active",
              typeHint: { type: "primitiveType", value: "boolean" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "active" }],
        },
      },
    },
    {
      input: "def process(data: any) { data }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "process",
          parameters: [
            {
              type: "functionParameter",
              name: "data",
              typeHint: { type: "typeAliasVariable", aliasName: "any" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "data" }],
        },
      },
    },
    {
      input: "def handle(x : number) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "handle",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    // Functions with multiple parameters with type hints
    {
      input: "def add(x: number, y: number) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "add",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            {
              type: "functionParameter",
              name: "y",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    {
      input: "def concat(a: string, b: string, c: string) { a }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "concat",
          parameters: [
            {
              type: "functionParameter",
              name: "a",
              typeHint: { type: "primitiveType", value: "string" },
            },
            {
              type: "functionParameter",
              name: "b",
              typeHint: { type: "primitiveType", value: "string" },
            },
            {
              type: "functionParameter",
              name: "c",
              typeHint: { type: "primitiveType", value: "string" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "a" }],
        },
      },
    },
    {
      input: "def compare(x: number, y: string) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "compare",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            {
              type: "functionParameter",
              name: "y",
              typeHint: { type: "primitiveType", value: "string" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    {
      input: "def calc(x:number,y:number) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "calc",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            {
              type: "functionParameter",
              name: "y",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    // Functions with mixed typed and untyped parameters
    {
      input: "def mixed(x: number, y) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "mixed",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            { type: "functionParameter", name: "y" },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    {
      input: "def partial(a, b: string, c) { a }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "partial",
          parameters: [
            { type: "functionParameter", name: "a" },
            {
              type: "functionParameter",
              name: "b",
              typeHint: { type: "primitiveType", value: "string" },
            },
            { type: "functionParameter", name: "c" },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "a" }],
        },
      },
    },
    {
      input: "def combo(typed: number, untyped) { typed }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "combo",
          parameters: [
            {
              type: "functionParameter",
              name: "typed",
              typeHint: { type: "primitiveType", value: "number" },
            },
            { type: "functionParameter", name: "untyped" },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "typed" }],
        },
      },
    },
    // Functions with complex type hints (arrays)
    {
      input: "def processArray(items: number[]) { items }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "processArray",
          parameters: [
            {
              type: "functionParameter",
              name: "items",
              typeHint: {
                type: "arrayType",
                elementType: { type: "primitiveType", value: "number" },
              },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "items" }],
        },
      },
    },
    {
      input: "def handleStrings(names: string[]) { names }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "handleStrings",
          parameters: [
            {
              type: "functionParameter",
              name: "names",
              typeHint: {
                type: "arrayType",
                elementType: { type: "primitiveType", value: "string" },
              },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "names" }],
        },
      },
    },
    {
      input: "def processData(obj: object) { obj }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "processData",
          parameters: [
            {
              type: "functionParameter",
              name: "obj",
              typeHint: { type: "typeAliasVariable", aliasName: "object" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "obj" }],
        },
      },
    },
    {
      input: "def multi(arr: string[], count: number) { arr }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "multi",
          parameters: [
            {
              type: "functionParameter",
              name: "arr",
              typeHint: {
                type: "arrayType",
                elementType: { type: "primitiveType", value: "string" },
              },
            },
            {
              type: "functionParameter",
              name: "count",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "arr" }],
        },
      },
    },
    {
      input: "def nested(matrix: number[][]) { matrix }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "nested",
          parameters: [
            {
              type: "functionParameter",
              name: "matrix",
              typeHint: {
                type: "arrayType",
                elementType: {
                  type: "arrayType",
                  elementType: { type: "primitiveType", value: "number" },
                },
              },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "matrix" }],
        },
      },
    },
    // Functions with union type hints
    {
      input: "def flexible(value: string | number) { value }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "flexible",
          parameters: [
            {
              type: "functionParameter",
              name: "value",
              typeHint: {
                type: "unionType",
                types: [
                  { type: "primitiveType", value: "string" },
                  { type: "primitiveType", value: "number" },
                ],
              },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "value" }],
        },
      },
    },
    {
      input: "def multiUnion(x: number | string | boolean) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "multiUnion",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: {
                type: "unionType",
                types: [
                  { type: "primitiveType", value: "number" },
                  { type: "primitiveType", value: "string" },
                  { type: "primitiveType", value: "boolean" },
                ],
              },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    {
      input: "def dual(a: string | number, b: boolean) { a }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "dual",
          parameters: [
            {
              type: "functionParameter",
              name: "a",
              typeHint: {
                type: "unionType",
                types: [
                  { type: "primitiveType", value: "string" },
                  { type: "primitiveType", value: "number" },
                ],
              },
            },
            {
              type: "functionParameter",
              name: "b",
              typeHint: { type: "primitiveType", value: "boolean" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "a" }],
        },
      },
    },
    // Functions with type hints and docstrings
    {
      input:
        'def add(x: number, y: number) {\n  """Adds two numbers"""\n  x\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "add",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            {
              type: "functionParameter",
              name: "y",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: null,
          docString: {
            type: "docString",
            value: "Adds two numbers",
          },
          body: [{ type: "variableName", value: "x" }, { type: "newLine" }],
        },
      },
    },
    {
      input:
        'def greet(name: string) {\n  """Greets a person by name"""\n  name\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "greet",
          parameters: [
            {
              type: "functionParameter",
              name: "name",
              typeHint: { type: "primitiveType", value: "string" },
            },
          ],
          returnType: null,
          docString: {
            type: "docString",
            value: "Greets a person by name",
          },
          body: [{ type: "variableName", value: "name" }, { type: "newLine" }],
        },
      },
    },
    {
      input:
        'def mixedWithDoc(typed: number, untyped) {\n  """Mix of typed and untyped params"""\n  typed\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "mixedWithDoc",
          parameters: [
            {
              type: "functionParameter",
              name: "typed",
              typeHint: { type: "primitiveType", value: "number" },
            },
            { type: "functionParameter", name: "untyped" },
          ],
          returnType: null,
          docString: {
            type: "docString",
            value: "Mix of typed and untyped params",
          },
          body: [{ type: "variableName", value: "typed" }, { type: "newLine" }],
        },
      },
    },
    // Edge cases for type hints
    {
      input: "def f(x: number) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "f",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    {
      input: "def add(x  :  number  ,  y  :  string) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "add",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            {
              type: "functionParameter",
              name: "y",
              typeHint: { type: "primitiveType", value: "string" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    {
      input: "def process(my_var: string) { my_var }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "process",
          parameters: [
            {
              type: "functionParameter",
              name: "my_var",
              typeHint: { type: "primitiveType", value: "string" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "my_var" }],
        },
      },
    },
    {
      input: "def handle(data: SomeLongTypeName) { data }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "handle",
          parameters: [
            {
              type: "functionParameter",
              name: "data",
              typeHint: {
                type: "typeAliasVariable",
                aliasName: "SomeLongTypeName",
              },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "data" }],
        },
      },
    },
    // Failure cases for type hints
    {
      input: "def bad(x:) { x }",
      expected: { success: false },
    },
    {
      input: "def bad(: number) { x }",
      expected: { success: false },
    },
    {
      input: "def bad(x: number y: string) { x }",
      expected: { success: false },
    },
    // Functions with return types - primitive types
    {
      input: "def getNumber(): number { 42 }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "getNumber",
          parameters: [],
          returnType: { type: "primitiveType", value: "number" },
          docString: undefined,
          body: [{ type: "number", value: "42" }],
        },
      },
    },
    {
      input: "def getString(): string { name }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "getString",
          parameters: [],
          returnType: { type: "primitiveType", value: "string" },
          docString: undefined,
          body: [{ type: "variableName", value: "name" }],
        },
      },
    },
    {
      input: "def getBoolean(): boolean { true }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "getBoolean",
          parameters: [],
          returnType: { type: "primitiveType", value: "boolean" },
          docString: undefined,
          body: [{ type: "boolean", value: true }],
        },
      },
    },
    // Functions with return types and parameters
    {
      input: "def add(x: number, y: number): number { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "add",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            {
              type: "functionParameter",
              name: "y",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: { type: "primitiveType", value: "number" },
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    {
      input: "def greet(name: string): string { name }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "greet",
          parameters: [
            {
              type: "functionParameter",
              name: "name",
              typeHint: { type: "primitiveType", value: "string" },
            },
          ],
          returnType: { type: "primitiveType", value: "string" },
          docString: undefined,
          body: [{ type: "variableName", value: "name" }],
        },
      },
    },
    {
      input: "def check(value): boolean { value }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "check",
          parameters: [{ type: "functionParameter", name: "value" }],
          returnType: { type: "primitiveType", value: "boolean" },
          docString: undefined,
          body: [{ type: "variableName", value: "value" }],
        },
      },
    },
    // Functions with array return types
    {
      input: "def getNumbers(): number[] { items }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "getNumbers",
          parameters: [],
          returnType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          docString: undefined,
          body: [{ type: "variableName", value: "items" }],
        },
      },
    },
    {
      input: "def getStrings(): string[] { names }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "getStrings",
          parameters: [],
          returnType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "string" },
          },
          docString: undefined,
          body: [{ type: "variableName", value: "names" }],
        },
      },
    },
    {
      input: "def processArray(items: number[]): number[] { items }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "processArray",
          parameters: [
            {
              type: "functionParameter",
              name: "items",
              typeHint: {
                type: "arrayType",
                elementType: { type: "primitiveType", value: "number" },
              },
            },
          ],
          returnType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          docString: undefined,
          body: [{ type: "variableName", value: "items" }],
        },
      },
    },
    // Functions with union return types
    {
      input: "def getValue(): string | number { value }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "getValue",
          parameters: [],
          returnType: {
            type: "unionType",
            types: [
              { type: "primitiveType", value: "string" },
              { type: "primitiveType", value: "number" },
            ],
          },
          docString: undefined,
          body: [{ type: "variableName", value: "value" }],
        },
      },
    },
    {
      input: "def flexible(x: number): string | number | boolean { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "flexible",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: {
            type: "unionType",
            types: [
              { type: "primitiveType", value: "string" },
              { type: "primitiveType", value: "number" },
              { type: "primitiveType", value: "boolean" },
            ],
          },
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    // Functions with return types and docstrings
    {
      input:
        'def add(x: number, y: number): number {\n  """Adds two numbers"""\n  x\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "add",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            {
              type: "functionParameter",
              name: "y",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: { type: "primitiveType", value: "number" },
          docString: {
            type: "docString",
            value: "Adds two numbers",
          },
          body: [{ type: "variableName", value: "x" }, { type: "newLine" }],
        },
      },
    },
    {
      input:
        'def greet(name: string): string {\n  """Greets a person"""\n  name\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "greet",
          parameters: [
            {
              type: "functionParameter",
              name: "name",
              typeHint: { type: "primitiveType", value: "string" },
            },
          ],
          returnType: { type: "primitiveType", value: "string" },
          docString: {
            type: "docString",
            value: "Greets a person",
          },
          body: [{ type: "variableName", value: "name" }, { type: "newLine" }],
        },
      },
    },
    // Functions with whitespace variations in return types
    {
      input: "def foo():number { 1 }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "foo",
          parameters: [],
          returnType: { type: "primitiveType", value: "number" },
          docString: undefined,
          body: [{ type: "number", value: "1" }],
        },
      },
    },
    {
      input: "def bar()  :  string { name }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "bar",
          parameters: [],
          returnType: { type: "primitiveType", value: "string" },
          docString: undefined,
          body: [{ type: "variableName", value: "name" }],
        },
      },
    },
    {
      input: "def baz(x: number)  :  number  { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "baz",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: { type: "primitiveType", value: "number" },
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    // Functions with type alias return types
    {
      input: "def getPoint(): Point { point }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "getPoint",
          parameters: [],
          returnType: { type: "typeAliasVariable", aliasName: "Point" },
          docString: undefined,
          body: [{ type: "variableName", value: "point" }],
        },
      },
    },
    {
      input: "def getData(id: number): UserData { data }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "getData",
          parameters: [
            {
              type: "functionParameter",
              name: "id",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: { type: "typeAliasVariable", aliasName: "UserData" },
          docString: undefined,
          body: [{ type: "variableName", value: "data" }],
        },
      },
    },
    // Functions with object return types
    {
      input: "def getCoords(): { x: number; y: number } { coords }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "getCoords",
          parameters: [],
          returnType: {
            type: "objectType",
            properties: [
              {
                key: "x",
                value: { type: "primitiveType", value: "number" },
              },
              {
                key: "y",
                value: { type: "primitiveType", value: "number" },
              },
            ],
          },
          docString: undefined,
          body: [{ type: "variableName", value: "coords" }],
        },
      },
    },
    // Failure cases for return types
    {
      input: "def bad(): { x }",
      expected: { success: false },
      throws: true,
    },
    {
      input: "def bad() : { x }",
      expected: { success: false },
      throws: true,
    },
  ];

  testCases.forEach(({ input, expected, throws }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = functionParser(normalizeCode(input));
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else if (throws) {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        expect(() => functionParser(normalizeCode(input))).toThrow();
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = functionParser(normalizeCode(input));
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("asyncFunctionParser", () => {
  const testCases = [
    // Basic async function
    {
      input: 'async def bar() {\n  return "Hello from bar!"\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "bar",
          parameters: [],
          returnType: null,
          docString: undefined,
          body: [
            {
              type: "returnStatement",
              value: {
                type: "string",
                segments: [{ type: "text", value: "Hello from bar!" }],
              },
            },
            { type: "newLine" },
          ],
          async: true,
        },
      },
    },
    // Async function with parameters
    {
      input: "async def add(x: number, y: number) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "add",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            {
              type: "functionParameter",
              name: "y",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
          async: true,
        },
      },
    },
    // Async function with return type
    {
      input: "async def getNumber(): number { 42 }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "getNumber",
          parameters: [],
          returnType: { type: "primitiveType", value: "number" },
          docString: undefined,
          body: [{ type: "number", value: "42" }],
          async: true,
        },
      },
    },
    // Async function with docstring
    {
      input:
        'async def greet() {\n  """Greets the user"""\n  bar = `say hello`\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "greet",
          parameters: [],
          returnType: null,
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
            { type: "newLine" },
          ],
          async: true,
        },
      },
    },
    // Async function with empty body
    {
      input: "async def empty() {}",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "empty",
          parameters: [],
          returnType: null,
          docString: undefined,
          body: [],
          async: true,
        },
      },
    },
    // Failure cases
    { input: "def test() { x = 1 }", expected: { success: false } },
    { input: "sync def test() { x = 1 }", expected: { success: false } },
    { input: "async test() { x = 1 }", expected: { success: false } },
    { input: "async { x = 1 }", expected: { success: false } },
    { input: "", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = asyncFunctionParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = asyncFunctionParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("syncFunctionParser", () => {
  const testCases = [
    // Basic sync function
    {
      input: 'sync def bar() {\n  return "Hello from bar!"\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "bar",
          parameters: [],
          returnType: null,
          docString: undefined,
          body: [
            {
              type: "returnStatement",
              value: {
                type: "string",
                segments: [{ type: "text", value: "Hello from bar!" }],
              },
            },
            { type: "newLine" },
          ],
          async: false,
        },
      },
    },
    // Sync function with parameters
    {
      input: "sync def add(x: number, y: number) { x }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "add",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            {
              type: "functionParameter",
              name: "y",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: null,
          docString: undefined,
          body: [{ type: "variableName", value: "x" }],
          async: false,
        },
      },
    },
    // Sync function with return type
    {
      input: "sync def getNumber(): number { 42 }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "getNumber",
          parameters: [],
          returnType: { type: "primitiveType", value: "number" },
          docString: undefined,
          body: [{ type: "number", value: "42" }],
          async: false,
        },
      },
    },
    // Sync function with docstring
    {
      input:
        'sync def greet() {\n  """Greets the user"""\n  bar = `say hello`\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "greet",
          parameters: [],
          returnType: null,
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
            { type: "newLine" },
          ],
          async: false,
        },
      },
    },
    // Sync function with empty body
    {
      input: "sync def empty() {}",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "empty",
          parameters: [],
          returnType: null,
          docString: undefined,
          body: [],
          async: false,
        },
      },
    },
    // Failure cases
    { input: "def test() { x = 1 }", expected: { success: false } },
    { input: "async def test() { x = 1 }", expected: { success: false } },
    { input: "sync test() { x = 1 }", expected: { success: false } },
    { input: "sync { x = 1 }", expected: { success: false } },
    { input: "", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = syncFunctionParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = syncFunctionParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("functionParser with async/sync keywords", () => {
  const testCases = [
    // async def goes through functionParser
    {
      input: "async def foo() { x = 1 }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "foo",
          parameters: [],
          returnType: null,
          docString: undefined,
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
          ],
          async: true,
        },
      },
    },
    // sync def goes through functionParser
    {
      input: "sync def foo() { x = 1 }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "foo",
          parameters: [],
          returnType: null,
          docString: undefined,
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
          ],
          async: false,
        },
      },
    },
    // plain def goes through functionParser (no async field)
    {
      input: "def foo() { x = 1 }",
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "foo",
          parameters: [],
          returnType: null,
          docString: undefined,
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
          ],
        },
      },
    },
    // async with params, return type, and docstring
    {
      input:
        'async def calculate(x: number, y: number): number {\n  """Calculates result"""\n  x\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "calculate",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            {
              type: "functionParameter",
              name: "y",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: { type: "primitiveType", value: "number" },
          docString: {
            type: "docString",
            value: "Calculates result",
          },
          body: [{ type: "variableName", value: "x" }, { type: "newLine" }],
          async: true,
        },
      },
    },
    // sync with params, return type, and docstring
    {
      input:
        'sync def calculate(x: number, y: number): number {\n  """Calculates result"""\n  x\n}',
      expected: {
        success: true,
        result: {
          type: "function",
          functionName: "calculate",
          parameters: [
            {
              type: "functionParameter",
              name: "x",
              typeHint: { type: "primitiveType", value: "number" },
            },
            {
              type: "functionParameter",
              name: "y",
              typeHint: { type: "primitiveType", value: "number" },
            },
          ],
          returnType: { type: "primitiveType", value: "number" },
          docString: {
            type: "docString",
            value: "Calculates result",
          },
          body: [{ type: "variableName", value: "x" }, { type: "newLine" }],
          async: false,
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

describe("timeBlockParser", () => {
  const testCases = [
    // Happy path - basic time blocks
    {
      input: "time {\n  x = 1\n}",
      expected: {
        success: true,
        result: {
          type: "timeBlock",
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },
    {
      input: "time {\n  foo = `hello`\n}",
      expected: {
        success: true,
        result: {
          type: "timeBlock",
          body: [
            {
              type: "assignment",
              variableName: "foo",
              value: {
                type: "prompt",
                segments: [{ type: "text", value: "hello" }],
              },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },

    // Multiple statements in body
    {
      input: "time {\n  a = 1\n  b = 2\n  c = 3\n}",
      expected: {
        success: true,
        result: {
          type: "timeBlock",
          body: [
            {
              type: "assignment",
              variableName: "a",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
            {
              type: "assignment",
              variableName: "b",
              value: { type: "number", value: "2" },
            },
            {
              type: "newLine",
            },
            {
              type: "assignment",
              variableName: "c",
              value: { type: "number", value: "3" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },

    // Empty body
    {
      input: "time {\n}",
      expected: {
        success: true,
        result: {
          type: "timeBlock",
          body: [],
        },
      },
    },

    // Whitespace variations
    {
      input: "time{\n  x = 1\n}",
      expected: {
        success: true,
        result: {
          type: "timeBlock",
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },
    {
      input: "time  {  \n  x = 1\n  }",
      expected: {
        success: true,
        result: {
          type: "timeBlock",
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },

    // Function calls in body
    {
      input: "time {\n  result = doSomething()\n}",
      expected: {
        success: true,
        result: {
          type: "timeBlock",
          body: [
            {
              type: "assignment",
              variableName: "result",
              value: {
                type: "functionCall",
                functionName: "doSomething",
                arguments: [],
              },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },

    // Complex body with different statement types
    {
      input: "time {\n  x = 1\n  y = `prompt`\n  z = foo()\n}",
      expected: {
        success: true,
        result: {
          type: "timeBlock",
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
            {
              type: "newLine",
            },
            {
              type: "assignment",
              variableName: "y",
              value: {
                type: "prompt",
                segments: [{ type: "text", value: "prompt" }],
              },
            },
            {
              type: "newLine",
            },
            {
              type: "assignment",
              variableName: "z",
              value: {
                type: "functionCall",
                functionName: "foo",
                arguments: [],
              },
            },
            {
              type: "newLine",
            },
          ],
        },
      },
    },

    // Failure cases - missing braces
    {
      input: "time \n  x = 1\n",
      expected: { success: false },
    },
    {
      input: "time {\n  x = 1",
      expected: { success: false },
    },
    {
      input: "time \n  x = 1\n}",
      expected: { success: false },
    },

    // Failure cases - empty or malformed
    {
      input: "",
      expected: { success: false },
    },
    {
      input: "time",
      expected: { success: false },
    },
    {
      input: "time {",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = timeBlockParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = timeBlockParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("graphNodeParser", () => {
  const testCases = [
    // Basic graph nodes without return types
    {
      input: "node main() { x = 1 }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "main",
          parameters: [],
          returnType: null,
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "number", value: "1" },
            },
          ],
        },
      },
    },
    {
      input: "node greet() { message = `hello` }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "greet",
          parameters: [],
          returnType: null,
          body: [
            {
              type: "assignment",
              variableName: "message",
              value: {
                type: "prompt",
                segments: [{ type: "text", value: "hello" }],
              },
            },
          ],
        },
      },
    },
    {
      input: "node empty() {}",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "empty",
          parameters: [],
          returnType: null,
          body: [],
        },
      },
    },
    // Graph nodes with parameters
    {
      input: "node process(input) { x = input }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "process",
          parameters: [{ type: "functionParameter", name: "input" }],
          returnType: null,
          body: [
            {
              type: "assignment",
              variableName: "x",
              value: { type: "variableName", value: "input" },
            },
          ],
        },
      },
    },
    {
      input: "node calculate(a, b) { result = 42 }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "calculate",
          parameters: [
            { type: "functionParameter", name: "a" },
            { type: "functionParameter", name: "b" },
          ],
          returnType: null,
          body: [
            {
              type: "assignment",
              variableName: "result",
              value: { type: "number", value: "42" },
            },
          ],
        },
      },
    },
    // Graph nodes with return types - primitive types
    {
      input: "node getNumber(): number { 42 }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "getNumber",
          parameters: [],
          returnType: { type: "primitiveType", value: "number" },
          body: [{ type: "number", value: "42" }],
        },
      },
    },
    {
      input: "node getString(): string { name }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "getString",
          parameters: [],
          returnType: { type: "primitiveType", value: "string" },
          body: [{ type: "variableName", value: "name" }],
        },
      },
    },
    {
      input: "node getBoolean(): boolean { true }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "getBoolean",
          parameters: [],
          returnType: { type: "primitiveType", value: "boolean" },
          body: [{ type: "boolean", value: true }],
        },
      },
    },
    // Graph nodes with parameters and return types
    {
      input: "node add(x, y): number { result = 10 }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "add",
          parameters: [
            { type: "functionParameter", name: "x" },
            { type: "functionParameter", name: "y" },
          ],
          returnType: { type: "primitiveType", value: "number" },
          body: [
            {
              type: "assignment",
              variableName: "result",
              value: { type: "number", value: "10" },
            },
          ],
        },
      },
    },
    {
      input: "node greet(name): string { message = `hello` }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "greet",
          parameters: [{ type: "functionParameter", name: "name" }],
          returnType: { type: "primitiveType", value: "string" },
          body: [
            {
              type: "assignment",
              variableName: "message",
              value: {
                type: "prompt",
                segments: [{ type: "text", value: "hello" }],
              },
            },
          ],
        },
      },
    },
    {
      input: "node process(input): boolean { result }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "process",
          parameters: [{ type: "functionParameter", name: "input" }],
          returnType: { type: "primitiveType", value: "boolean" },
          body: [{ type: "variableName", value: "result" }],
        },
      },
    },
    // Graph nodes with array return types
    {
      input: "node getNumbers(): number[] { items }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "getNumbers",
          parameters: [],
          returnType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          body: [{ type: "variableName", value: "items" }],
        },
      },
    },
    {
      input: "node getStrings(): string[] { names }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "getStrings",
          parameters: [],
          returnType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "string" },
          },
          body: [{ type: "variableName", value: "names" }],
        },
      },
    },
    {
      input: "node processArray(items): number[] { items }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "processArray",
          parameters: [{ type: "functionParameter", name: "items" }],
          returnType: {
            type: "arrayType",
            elementType: { type: "primitiveType", value: "number" },
          },
          body: [{ type: "variableName", value: "items" }],
        },
      },
    },
    // Graph nodes with union return types
    {
      input: "node getValue(): string | number { value }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "getValue",
          parameters: [],
          returnType: {
            type: "unionType",
            types: [
              { type: "primitiveType", value: "string" },
              { type: "primitiveType", value: "number" },
            ],
          },
          body: [{ type: "variableName", value: "value" }],
        },
      },
    },
    {
      input: "node flexible(x): string | number | boolean { x }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "flexible",
          parameters: [{ type: "functionParameter", name: "x" }],
          returnType: {
            type: "unionType",
            types: [
              { type: "primitiveType", value: "string" },
              { type: "primitiveType", value: "number" },
              { type: "primitiveType", value: "boolean" },
            ],
          },
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    // Graph nodes with whitespace variations in return types
    {
      input: "node foo():number { 1 }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "foo",
          parameters: [],
          returnType: { type: "primitiveType", value: "number" },
          body: [{ type: "number", value: "1" }],
        },
      },
    },
    {
      input: "node bar()  :  string { name }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "bar",
          parameters: [],
          returnType: { type: "primitiveType", value: "string" },
          body: [{ type: "variableName", value: "name" }],
        },
      },
    },
    {
      input: "node baz(x)  :  number  { x }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "baz",
          parameters: [{ type: "functionParameter", name: "x" }],
          returnType: { type: "primitiveType", value: "number" },
          body: [{ type: "variableName", value: "x" }],
        },
      },
    },
    // Graph nodes with type alias return types
    {
      input: "node getPoint(): Point { point }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "getPoint",
          parameters: [],
          returnType: { type: "typeAliasVariable", aliasName: "Point" },
          body: [{ type: "variableName", value: "point" }],
        },
      },
    },
    {
      input: "node getData(id): UserData { data }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "getData",
          parameters: [{ type: "functionParameter", name: "id" }],
          returnType: { type: "typeAliasVariable", aliasName: "UserData" },
          body: [{ type: "variableName", value: "data" }],
        },
      },
    },
    // Graph nodes with object return types
    {
      input: "node getCoords(): { x: number; y: number } { coords }",
      expected: {
        success: true,
        result: {
          type: "graphNode",
          nodeName: "getCoords",
          parameters: [],
          returnType: {
            type: "objectType",
            properties: [
              {
                key: "x",
                value: { type: "primitiveType", value: "number" },
              },
              {
                key: "y",
                value: { type: "primitiveType", value: "number" },
              },
            ],
          },
          body: [{ type: "variableName", value: "coords" }],
        },
      },
    },
    // Failure cases
    {
      input: "main() { x = 1 }",
      expected: { success: false },
    },
    {
      input: "node { x = 1 }",
      expected: { success: false },
    },
    {
      input: "node main() x = 1",
      expected: { success: false },
    },
    {
      input: "node main() {",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
    // Failure cases for return types
    {
      input: "node bad(): { x }",
      expected: { success: false },
      throws: true,
    },
    {
      input: "node bad() : { x }",
      expected: { success: false },
      throws: true,
    },
  ];

  testCases.forEach(({ input, expected, throws }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = graphNodeParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else if (throws) {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        expect(() => graphNodeParser(input)).toThrow();
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = graphNodeParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("messageThreadParser", () => {
  describe("thread blocks", () => {
    const threadTestCases = [
      // Happy path - basic thread
      {
        input: "thread {\n}",
        expected: {
          success: true,
          result: {
            type: "messageThread",
            subthread: false,
            body: [],
          },
        },
      },
      // Thread with minimal spacing
      {
        input: "thread{ }",
        expected: {
          success: true,
          result: {
            type: "messageThread",
            subthread: false,
            body: [],
          },
        },
      },
      // Thread with extra spaces
      {
        input: "thread   {   \n   }",
        expected: {
          success: true,
          result: {
            type: "messageThread",
            subthread: false,
            body: [],
          },
        },
      },
      // Thread with newlines
      {
        input: "thread {\n\n\n}",
        expected: {
          success: true,
          result: {
            type: "messageThread",
            subthread: false,
            body: [],
          },
        },
      },
    ];

    threadTestCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
          const result = messageThreadParser(normalizeCode(input));
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result.type).toBe(expected.result.type);
            expect(result.result.subthread).toBe(expected.result.subthread);
            expect(result.result.body).toBeDefined();
          }
        });
      } else {
        it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
          const result = messageThreadParser(normalizeCode(input));
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("subthread blocks", () => {
    const subthreadTestCases = [
      // Happy path - basic subthread
      {
        input: "subthread {\n}",
        expected: {
          success: true,
          result: {
            type: "messageThread",
            subthread: true,
            body: [],
          },
        },
      },
      // Subthread with minimal spacing
      {
        input: "subthread{ }",
        expected: {
          success: true,
          result: {
            type: "messageThread",
            subthread: true,
            body: [],
          },
        },
      },
      // Subthread with extra spaces
      {
        input: "subthread   {   \n   }",
        expected: {
          success: true,
          result: {
            type: "messageThread",
            subthread: true,
            body: [],
          },
        },
      },
      // Subthread with newlines
      {
        input: "subthread {\n\n\n}",
        expected: {
          success: true,
          result: {
            type: "messageThread",
            subthread: true,
            body: [],
          },
        },
      },
    ];

    subthreadTestCases.forEach(({ input, expected }) => {
      if (expected.success) {
        it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
          const result = messageThreadParser(normalizeCode(input));
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.result.type).toBe(expected.result.type);
            expect(result.result.subthread).toBe(expected.result.subthread);
            expect(result.result.body).toBeDefined();
          }
        });
      } else {
        it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
          const result = messageThreadParser(normalizeCode(input));
          expect(result.success).toBe(false);
        });
      }
    });
  });

  describe("thread vs subthread distinction", () => {
    it("should correctly distinguish thread from subthread", () => {
      const threadResult = messageThreadParser("thread { }");
      const subthreadResult = messageThreadParser("subthread { }");

      expect(threadResult.success).toBe(true);
      expect(subthreadResult.success).toBe(true);

      if (threadResult.success && subthreadResult.success) {
        expect(threadResult.result.subthread).toBe(false);
        expect(subthreadResult.result.subthread).toBe(true);
      }
    });

    it("_messageThreadParser should only parse thread", () => {
      const threadResult = _messageThreadParser("thread { }");
      const subthreadResult = _messageThreadParser("subthread { }");

      expect(threadResult.success).toBe(true);
      expect(subthreadResult.success).toBe(false);
    });

    it("_submessageThreadParser should only parse subthread", () => {
      const threadResult = _submessageThreadParser("thread { }");
      const subthreadResult = _submessageThreadParser("subthread { }");

      expect(threadResult.success).toBe(false);
      expect(subthreadResult.success).toBe(true);
    });
  });

  describe("thread/subthread with body content", () => {
    it("should parse thread with assignment", () => {
      const input = "thread {\n  x = 5\n}";
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(false);
        expect(result.result.body.length).toBeGreaterThan(0);
      }
    });

    it("should parse subthread with assignment", () => {
      const input = "subthread {\n  x = 5\n}";
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(true);
        expect(result.result.body.length).toBeGreaterThan(0);
      }
    });

    it("should parse thread with multiple statements", () => {
      const input = `thread {
  x = 5
  y = 10
  z = 15
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.body.length).toBeGreaterThan(0);
      }
    });

    it("should parse thread with comment", () => {
      const input = `thread {
  // this is a comment
  x = 5
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.body.length).toBeGreaterThan(0);
      }
    });

    it("should parse thread with prompt assignment", () => {
      const input = `thread {
  result: number[] = llm(\`What are the first 5 prime numbers?\`)
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(false);
        expect(result.result.body.length).toBeGreaterThan(0);
      }
    });

    it("should parse subthread with prompt assignment", () => {
      const input = `subthread {
  result: number = llm(\`Calculate the sum\`)
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(true);
        expect(result.result.body.length).toBeGreaterThan(0);
      }
    });
  });

  describe("failure cases", () => {
    const failureCases = [
      { input: "", description: "empty string" },
      { input: "thread", description: "missing braces" },
      { input: "subthread", description: "subthread missing braces" },
      { input: "thread {", description: "missing closing brace" },
      { input: "subthread {", description: "subthread missing closing brace" },
      { input: "thread }", description: "missing opening brace" },
      { input: "subthread }", description: "subthread missing opening brace" },
      { input: "threads { }", description: "wrong keyword (threads)" },
      { input: "Thread { }", description: "wrong capitalization (Thread)" },
      {
        input: "Subthread { }",
        description: "wrong capitalization (Subthread)",
      },
      { input: "sub thread { }", description: "space in keyword" },
      { input: "THREAD { }", description: "uppercase keyword" },
      { input: "message_thread { }", description: "wrong keyword format" },
      { input: "def thread() { }", description: "function-like syntax" },
      { input: "{ }", description: "braces only" },
      { input: "// thread { }", description: "commented out" },
    ];

    failureCases.forEach(({ input, description }) => {
      it(`should fail to parse ${description}: "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = messageThreadParser(normalizeCode(input));
        expect(result.success).toBe(false);
      });
    });
  });

  describe("whitespace edge cases", () => {
    it("should handle thread with tabs", () => {
      const input = "thread\t{\t\n\t}";
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.subthread).toBe(false);
      }
    });

    it("should handle thread with mixed whitespace", () => {
      const input = "thread \t {\n\t \n}";
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.subthread).toBe(false);
      }
    });

    it("should handle subthread with tabs", () => {
      const input = "subthread\t{\t\n\t}";
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.subthread).toBe(true);
      }
    });
  });

  describe("rest of input handling", () => {
    it("should consume only the thread block and leave rest", () => {
      const input = "thread { }\nx = 5";
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.rest).toContain("x = 5");
      }
    });

    it("should consume only the subthread block and leave rest", () => {
      const input = "subthread { }\ny = 10";
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.rest).toContain("y = 10");
      }
    });
  });

  describe("nested content scenarios", () => {
    it("should parse thread with function call", () => {
      const input = `thread {
  result = doSomething()
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.body.length).toBeGreaterThan(0);
      }
    });

    it("should parse subthread with typed assignment", () => {
      const input = `subthread {
  x: number = 5
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(true);
        expect(result.result.body.length).toBeGreaterThan(0);
      }
    });

    it("should parse thread with multiple assignments", () => {
      const input = `thread {
  count = 1
  name = "test"
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.body.length).toBeGreaterThan(0);
      }
    });
  });

  describe("nested threads and subthreads", () => {
    it("should parse thread containing a single subthread", () => {
      const input = `thread {
  res1 = 1
  subthread {
    res2 = 2
  }
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(false);
        expect(result.result.body.length).toBeGreaterThan(0);

        // Find the nested subthread in the body
        const nestedSubthread = result.result.body.find(
          (node: any) =>
            node.type === "messageThread" && node.subthread === true,
        );
        expect(nestedSubthread).toBeDefined();
      }
    });

    it("should parse thread containing multiple subthreads", () => {
      const input = `thread {
  res1 = 1
  subthread {
    res2 = 2
  }
  subthread {
    res3 = 3
  }
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(false);

        // Count subthreads in the body
        const subthreads = result.result.body.filter(
          (node: any) =>
            node.type === "messageThread" && node.subthread === true,
        );
        expect(subthreads.length).toBe(2);
      }
    });

    it("should parse subthread containing a thread", () => {
      const input = `subthread {
  res1 = 1
  thread {
    res2 = 2
  }
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(true);

        // Find the nested thread in the body
        const nestedThread = result.result.body.find(
          (node: any) =>
            node.type === "messageThread" && node.subthread === false,
        );
        expect(nestedThread).toBeDefined();
      }
    });

    it("should parse deeply nested subthreads (3 levels)", () => {
      const input = `thread {
  res1 = 1
  subthread {
    res2 = 2
    subthread {
      res3 = 3
    }
  }
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(false);

        // Find the first level subthread
        const firstSubthread = result.result.body.find(
          (node: any) =>
            node.type === "messageThread" && node.subthread === true,
        );
        expect(firstSubthread).toBeDefined();

        if (firstSubthread) {
          // Find the second level subthread
          const secondSubthread = (firstSubthread as any).body.find(
            (node: any) =>
              node.type === "messageThread" && node.subthread === true,
          );
          expect(secondSubthread).toBeDefined();
        }
      }
    });

    it("should parse thread with nested subthread and thread", () => {
      const input = `thread {
  res1 = 1
  subthread {
    res2 = 2
    thread {
      res3 = 3
    }
  }
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(false);

        const firstSubthread = result.result.body.find(
          (node: any) =>
            node.type === "messageThread" && node.subthread === true,
        );
        expect(firstSubthread).toBeDefined();

        if (firstSubthread) {
          const nestedThread = (firstSubthread as any).body.find(
            (node: any) =>
              node.type === "messageThread" && node.subthread === false,
          );
          expect(nestedThread).toBeDefined();
        }
      }
    });

    it("should parse complex nested structure from foo.agency example", () => {
      const input = `thread {
  res1: number[] = llm(\`What are the first 5 prime numbers?\`)
  subthread {
    res2: number[] = llm(\`What are the next 2 prime numbers after those?\`)
    subthread {
      res3: number = llm(\`And what is the sum of all those numbers combined?\`)
    }
    thread {
      res5: number = llm(\`And what is the sum of all those numbers combined?\`)
    }
  }
  subthread {
    res4: number = llm(\`And what is the sum of all those numbers combined?\`)
  }
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(false);

        // Should have 2 top-level subthreads
        const topLevelSubthreads = result.result.body.filter(
          (node: any) =>
            node.type === "messageThread" && node.subthread === true,
        );
        expect(topLevelSubthreads.length).toBe(2);
      }
    });

    it("should parse thread with nested empty subthread", () => {
      const input = `thread {
  x = 1
  subthread {
  }
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");

        const nestedSubthread = result.result.body.find(
          (node: any) =>
            node.type === "messageThread" && node.subthread === true,
        );
        expect(nestedSubthread).toBeDefined();
        if (nestedSubthread) {
          expect((nestedSubthread as any).body).toEqual([]);
        }
      }
    });

    it("should parse subthread with nested empty thread", () => {
      const input = `subthread {
  x = 1
  thread {
  }
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(true);

        const nestedThread = result.result.body.find(
          (node: any) =>
            node.type === "messageThread" && node.subthread === false,
        );
        expect(nestedThread).toBeDefined();
        if (nestedThread) {
          expect((nestedThread as any).body).toEqual([]);
        }
      }
    });

    it("should parse thread with interleaved assignments and subthreads", () => {
      const input = `thread {
  a = 1
  subthread {
    b = 2
  }
  c = 3
  subthread {
    d = 4
  }
  e = 5
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.body.length).toBeGreaterThan(4);

        const subthreads = result.result.body.filter(
          (node: any) => node.type === "messageThread",
        );
        expect(subthreads.length).toBe(2);
      }
    });

    it("should parse deeply nested structure (4 levels)", () => {
      const input = `thread {
  level1 = 1
  subthread {
    level2 = 2
    thread {
      level3 = 3
      subthread {
        level4 = 4
      }
    }
  }
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(false);

        // Verify first level nesting exists
        const level1Subthread = result.result.body.find(
          (node: any) => node.type === "messageThread",
        );
        expect(level1Subthread).toBeDefined();
      }
    });

    it("should parse thread with multiple nested subthreads at same level", () => {
      const input = `thread {
  subthread {
    a = 1
  }
  subthread {
    b = 2
  }
  subthread {
    c = 3
  }
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        const subthreads = result.result.body.filter(
          (node: any) =>
            node.type === "messageThread" && node.subthread === true,
        );
        expect(subthreads.length).toBe(3);
      }
    });

    it("should handle whitespace variations in nested structures", () => {
      const input = `thread{
subthread{
x=1
}
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");

        const nestedSubthread = result.result.body.find(
          (node: any) => node.type === "messageThread",
        );
        expect(nestedSubthread).toBeDefined();
      }
    });

    it("should parse nested threads with comments", () => {
      const input = `thread {
  // outer thread
  x = 1
  subthread {
    // inner subthread
    y = 2
  }
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.body.length).toBeGreaterThan(0);
      }
    });

    it("should parse nested structure with mixed content types", () => {
      const input = `thread {
  x: number = 5
  y = \`prompt\`
  subthread {
    z = doSomething()
    thread {
      result = 42
    }
  }
}`;
      const result = messageThreadParser(normalizeCode(input));

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.body.length).toBeGreaterThan(0);

        const nestedSubthread = result.result.body.find(
          (node: any) =>
            node.type === "messageThread" && node.subthread === true,
        );
        expect(nestedSubthread).toBeDefined();
      }
    });

    it("should parse alternating thread and subthread nesting", () => {
      const input = `thread {
  a = 1
  subthread {
    b = 2
    thread {
      c = 3
      subthread {
        d = 4
        thread {
          e = 5
        }
      }
    }
  }
}`;
      const result = messageThreadParser(normalizeCode(input));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.type).toBe("messageThread");
        expect(result.result.subthread).toBe(false);
      } else {
        console.log(
          "Parsing failed for input:",
          input,
          "with error:",
          result.message,
        );
      }
    });
  });
});
