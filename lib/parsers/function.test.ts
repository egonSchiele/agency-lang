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
          returnType: null,
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
          body: [{ type: "variableName", value: "x" }],
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
          body: [{ type: "variableName", value: "name" }],
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
          body: [{ type: "variableName", value: "typed" }],
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
          body: [{ type: "variableName", value: "true" }],
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
          body: [{ type: "variableName", value: "x" }],
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
          body: [{ type: "variableName", value: "name" }],
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
    },
    {
      input: "def bad() : { x }",
      expected: { success: false },
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
