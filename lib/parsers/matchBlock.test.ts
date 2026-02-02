import { describe, it, expect } from "vitest";
import {
  matchBlockParser,
  matchBlockParserCase,
  defaultCaseParser,
} from "./matchBlock.js";

describe("defaultCaseParser", () => {
  const testCases = [
    {
      input: "_",
      expected: {
        success: true,
        result: "_",
      },
    },
    {
      input: "x",
      expected: { success: false },
    },
    {
      input: "",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = defaultCaseParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = defaultCaseParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("matchBlockParserCase", () => {
  const testCases = [
    {
      input: "1 => 2",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "number", value: "1" },
          body: { type: "number", value: "2" },
        },
      },
    },
    {
      input: "x => y",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "variableName", value: "x" },
          body: { type: "variableName", value: "y" },
        },
      },
    },
    {
      input: '"hello" => "world"',
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "string", segments: [{ type: "text", value: "hello" }] },
          body: { type: "string", segments: [{ type: "text", value: "world" }] },
        },
      },
    },
    {
      input: "_ => 42",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: "_",
          body: { type: "number", value: "42" },
        },
      },
    },
    {
      input: "  x  =>  y  ",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "variableName", value: "x" },
          body: { type: "variableName", value: "y" },
        },
      },
    },
    {
      input: "x => result = 5",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "variableName", value: "x" },
          body: {
            type: "assignment",
            variableName: "result",
            value: { type: "number", value: "5" },
          },
        },
      },
    },
    {
      input: "x => print(y)",
      expected: {
        success: true,
        result: {
          type: "matchBlockCase",
          caseValue: { type: "variableName", value: "x" },
          body: {
            type: "functionCall",
            functionName: "print",
            arguments: [{ type: "variableName", value: "y" }],
          },
        },
      },
    },
    {
      input: "x -> y",
      expected: { success: false },
    },
    {
      input: "=> y",
      expected: { success: false },
    },
    {
      input: "x =>",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = matchBlockParserCase(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = matchBlockParserCase(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("matchBlockParser", () => {
  const testCases = [
    {
      name: "basic match with variable expression and single case",
      input: `match(foo) {
  x => 1
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "foo" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "x" },
              body: { type: "number", value: "1" },
            },
          ],
        },
      },
    },
    {
      name: "match with multiple cases",
      input: `match(foo) {
  x => 1
  y => 2
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "foo" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "x" },
              body: { type: "number", value: "1" },
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "y" },
              body: { type: "number", value: "2" },
            },
          ],
        },
      },
    },
    {
      name: "match with default case",
      input: `match(foo) {
  x => 1
  _ => 2
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "foo" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "x" },
              body: { type: "number", value: "1" },
            },
            {
              type: "matchBlockCase",
              caseValue: "_",
              body: { type: "number", value: "2" },
            },
          ],
        },
      },
    },
    {
      name: "match with semicolon separators",
      input: `match(foo) {
  x => 1; y => 2; _ => 3
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "foo" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "x" },
              body: { type: "number", value: "1" },
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "y" },
              body: { type: "number", value: "2" },
            },
            {
              type: "matchBlockCase",
              caseValue: "_",
              body: { type: "number", value: "3" },
            },
          ],
        },
      },
    },
    {
      name: "match with string literals",
      input: `match(status) {
  "active" => "running"
  "inactive" => "stopped"
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "status" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "string", segments: [{ type: "text", value: "active" }] },
              body: { type: "string", segments: [{ type: "text", value: "running" }] },
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "string", segments: [{ type: "text", value: "inactive" }] },
              body: { type: "string", segments: [{ type: "text", value: "stopped" }] },
            },
          ],
        },
      },
    },
    {
      name: "match with number literals",
      input: `match(code) {
  200 => "OK"
  404 => "Not Found"
  500 => "Error"
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "code" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "200" },
              body: { type: "string", segments: [{ type: "text", value: "OK" }] },
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "404" },
              body: { type: "string", segments: [{ type: "text", value: "Not Found" }] },
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "500" },
              body: { type: "string", segments: [{ type: "text", value: "Error" }] },
            },
          ],
        },
      },
    },
    {
      name: "match with assignment bodies",
      input: `match(x) {
  1 => result = 10
  2 => result = 20
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "x" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "1" },
              body: {
                type: "assignment",
                variableName: "result",
                value: { type: "number", value: "10" },
              },
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "2" },
              body: {
                type: "assignment",
                variableName: "result",
                value: { type: "number", value: "20" },
              },
            },
          ],
        },
      },
    },
    {
      name: "match with function call bodies",
      input: `match(action) {
  "start" => print("Starting")
  "stop" => print("Stopping")
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "action" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "string", segments: [{ type: "text", value: "start" }] },
              body: {
                type: "functionCall",
                functionName: "print",
                arguments: [{ type: "string", segments: [{ type: "text", value: "Starting" }] }],
              },
            },
            {
              type: "matchBlockCase",
              caseValue: { type: "string", segments: [{ type: "text", value: "stop" }] },
              body: {
                type: "functionCall",
                functionName: "print",
                arguments: [{ type: "string", segments: [{ type: "text", value: "Stopping" }] }],
              },
            },
          ],
        },
      },
    },
    {
      name: "match with minimal whitespace",
      input: `match(x){y=>1}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "x" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "variableName", value: "y" },
              body: { type: "number", value: "1" },
            },
          ],
        },
      },
    },
    {
      name: "match with number expression",
      input: `match(42) {
  42 => "found"
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "number", value: "42" },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "number", value: "42" },
              body: { type: "string", segments: [{ type: "text", value: "found" }] },
            },
          ],
        },
      },
    },
    {
      name: "match with string expression",
      input: `match("test") {
  "test" => 1
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "string", segments: [{ type: "text", value: "test" }] },
          cases: [
            {
              type: "matchBlockCase",
              caseValue: { type: "string", segments: [{ type: "text", value: "test" }] },
              body: { type: "number", value: "1" },
            },
          ],
        },
      },
    },
    {
      name: "match with empty cases (no cases)",
      input: `match(x) {
}`,
      expected: {
        success: true,
        result: {
          type: "matchBlock",
          expression: { type: "variableName", value: "x" },
          cases: [],
        },
      },
    },
    {
      name: "missing opening parenthesis",
      input: `match foo) { x => 1 }`,
      expected: { success: false },
    },
    {
      name: "missing closing parenthesis",
      input: `match(foo { x => 1 }`,
      expected: { success: false },
    },
    {
      name: "missing opening brace",
      input: `match(foo) x => 1 }`,
      expected: { success: false },
    },
    {
      name: "missing closing brace",
      input: `match(foo) { x => 1`,
      expected: { success: false },
    },
    {
      name: "missing expression",
      input: `match() { x => 1 }`,
      expected: { success: false },
    },
    {
      name: "invalid match keyword",
      input: `macth(foo) { x => 1 }`,
      expected: { success: false },
    },
  ];

  testCases.forEach(({ name, input, expected }) => {
    if (expected.success) {
      it(`should parse ${name}`, () => {
        const result = matchBlockParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse ${name}`, () => {
        const result = matchBlockParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
