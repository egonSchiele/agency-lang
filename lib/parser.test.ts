import { describe, it, expect } from "vitest";
import { agencyNode, agencyParser, parseAgency } from "./parser.js";

describe("agencyNode", () => {
  const testCases = [
    {
      input: "bar :: number",
      expected: {
        success: true,
        firstNodeType: "typeHint",
      },
    },
    {
      input: "x = 5",
      expected: {
        success: true,
        firstNodeType: "assignment",
      },
    },
    {
      input: "def test() { foo = 1 }",
      expected: {
        success: true,
        firstNodeType: "function",
      },
    },
    {
      input: "test()",
      expected: {
        success: true,
        firstNodeType: "functionCall",
      },
    },
    {
      input: "// this is a comment",
      expected: {
        success: true,
        firstNodeType: "comment",
      },
    },
    {
      input: "bar :: number\nx = 5",
      expected: {
        success: true,
        firstNodeType: "typeHint",
      },
    },
    {
      input: "foo :: string\nfoo = `hello`",
      expected: {
        success: true,
        firstNodeType: "typeHint",
      },
    },
    {
      input: "def test() { foo = 1 }\ntest()",
      expected: {
        success: true,
        firstNodeType: "function",
      },
    },
    {
      input: "",
      expected: {
        success: true,
      },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = agencyNode(input);
        expect(result.success).toBe(true);
        if (result.success) {
          if (expected.firstNodeType) {
            expect(result.result[0].type).toBe(expected.firstNodeType);
          }
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = agencyNode(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("agencyParser", () => {
  const testCases = [
    {
      input: "bar :: number",
      expected: {
        success: true,
      },
    },
    {
      input: "bar :: number\nbar = 5",
      expected: {
        success: true,
      },
    },
    {
      input: "x = 5\ny = 10\nz = 15",
      expected: {
        success: true,
      },
    },
    {
      input: "def test() { foo = 1 }",
      expected: {
        success: true,
      },
    },
    {
      input: "def add() { x = 5\ny = 10 }\nadd()",
      expected: {
        success: true,
      },
    },
    {
      input: "result :: number\nresult = `the number 42`",
      expected: {
        success: true,
      },
    },
    {
      input: "",
      expected: {
        success: true,
      },
    },
    {
      input: "x = 5\n!!!",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = agencyParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result.type).toBe("agencyProgram");
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = agencyParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("parseAgency", () => {
  const testCases = [
    {
      input: "bar :: number\nbar = `the number 1`",
      expected: {
        success: true,
        programType: "agencyProgram",
      },
    },
    {
      input: "def test() {\n  foo = 1\n  bar = `say hello`\n  bar\n}",
      expected: {
        success: true,
        programType: "agencyProgram",
      },
    },
    {
      input: "x = 5",
      expected: {
        success: true,
        programType: "agencyProgram",
      },
    },
    {
      input: "name :: string\nname = `generate a name`\ngreet(name)",
      expected: {
        success: true,
        programType: "agencyProgram",
      },
    },
    {
      input: "",
      expected: {
        success: true,
        programType: "agencyProgram",
      },
    },
    {
      input: "invalid syntax @#$",
      expected: { success: false },
    },
    {
      input: "x = 5\ngarbage!!!",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = parseAgency(input, {}, false);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result.type).toBe(expected.programType);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = parseAgency(input, {}, false);
        expect(result.success).toBe(false);
      });
    }
  });
});
