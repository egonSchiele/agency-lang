import { describe, it, expect } from "vitest";
import { adlNode, adlParser, parseADL } from "./parser";

describe("adlNode", () => {
  const testCases = [
    {
      input: "bar :: number",
      expected: {
        success: true,
        nodeCount: 1,
        firstNodeType: "typeHint",
      },
    },
    {
      input: "x = 5",
      expected: {
        success: true,
        nodeCount: 1,
        firstNodeType: "assignment",
      },
    },
    {
      input: "def test() { foo = 1 }",
      expected: {
        success: true,
        nodeCount: 1,
        firstNodeType: "function",
      },
    },
    {
      input: "test()",
      expected: {
        success: true,
        nodeCount: 1,
        firstNodeType: "functionCall",
      },
    },
    {
      input: "bar :: number\nx = 5",
      expected: {
        success: true,
        nodeCount: 2,
        firstNodeType: "typeHint",
      },
    },
    {
      input: "foo :: string\nfoo = `hello`",
      expected: {
        success: true,
        nodeCount: 2,
        firstNodeType: "typeHint",
      },
    },
    {
      input: "def test() { foo = 1 }\ntest()",
      expected: {
        success: true,
        nodeCount: 2,
        firstNodeType: "function",
      },
    },
    {
      input: "",
      expected: {
        success: true,
        nodeCount: 0,
      },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = adlNode(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result.length).toBe(expected.nodeCount);
          if (expected.nodeCount > 0 && expected.firstNodeType) {
            expect(result.result[0].type).toBe(expected.firstNodeType);
          }
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = adlNode(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("adlParser", () => {
  const testCases = [
    {
      input: "bar :: number",
      expected: {
        success: true,
        nodeCount: 1,
      },
    },
    {
      input: "bar :: number\nbar = 5",
      expected: {
        success: true,
        nodeCount: 2,
      },
    },
    {
      input: "x = 5\ny = 10\nz = 15",
      expected: {
        success: true,
        nodeCount: 3,
      },
    },
    {
      input: "def test() { foo = 1 }",
      expected: {
        success: true,
        nodeCount: 1,
      },
    },
    {
      input: "def add() { x = 5\ny = 10 }\nadd()",
      expected: {
        success: true,
        nodeCount: 2,
      },
    },
    {
      input: "result :: number\nresult = `the number 42`",
      expected: {
        success: true,
        nodeCount: 2,
      },
    },
    {
      input: "",
      expected: {
        success: true,
        nodeCount: 0,
      },
    },
    {
      input: "bar :: number\nextra text",
      expected: { success: false },
    },
    {
      input: "x = 5\n!!!",
      expected: { success: false },
    },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input.replace(/\n/g, "\\n")}" successfully`, () => {
        const result = adlParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result.type).toBe("adlProgram");
          expect(result.result.nodes.length).toBe(expected.nodeCount);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = adlParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("parseADL", () => {
  const testCases = [
    {
      input: "bar :: number\nbar = `the number 1`",
      expected: {
        success: true,
        programType: "adlProgram",
        nodeCount: 2,
      },
    },
    {
      input: "def test() {\n  foo = 1\n  bar = `say hello`\n  bar\n}",
      expected: {
        success: true,
        programType: "adlProgram",
        nodeCount: 1,
      },
    },
    {
      input: "x = 5",
      expected: {
        success: true,
        programType: "adlProgram",
        nodeCount: 1,
      },
    },
    {
      input: "name :: string\nname = `generate a name`\ngreet(name)",
      expected: {
        success: true,
        programType: "adlProgram",
        nodeCount: 3,
      },
    },
    {
      input: "",
      expected: {
        success: true,
        programType: "adlProgram",
        nodeCount: 0,
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
        const result = parseADL(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result.type).toBe(expected.programType);
          expect(result.result.nodes.length).toBe(expected.nodeCount);
        }
      });
    } else {
      it(`should fail to parse "${input.replace(/\n/g, "\\n")}"`, () => {
        const result = parseADL(input);
        expect(result.success).toBe(false);
      });
    }
  });

  it("should handle complex multi-statement programs", () => {
    const input = `count :: number
count = \`the number 5\`
items :: string[]
items = \`list of fruits\`
def process() {
  result = count
  result
}
process()`;

    const result = parseADL(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.type).toBe("adlProgram");
      expect(result.result.nodes.length).toBe(6);
      expect(result.result.nodes[0].type).toBe("typeHint");
      expect(result.result.nodes[1].type).toBe("assignment");
      expect(result.result.nodes[2].type).toBe("typeHint");
      expect(result.result.nodes[3].type).toBe("assignment");
      expect(result.result.nodes[4].type).toBe("function");
      expect(result.result.nodes[5].type).toBe("functionCall");
    }
  });

  it("should parse real-world example from tests/assignment.adl pattern", () => {
    const input = `bar :: number
test :: string
bar = \`the number 1\``;

    const result = parseADL(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.nodes.length).toBe(3);
      expect(result.result.nodes[0]).toMatchObject({
        type: "typeHint",
        variableName: "bar",
        variableType: { type: "primitiveType", value: "number" },
      });
      expect(result.result.nodes[1]).toMatchObject({
        type: "typeHint",
        variableName: "test",
        variableType: { type: "primitiveType", value: "string" },
      });
    }
  });

  it("should parse real-world example from tests/function.adl pattern", () => {
    const input = `def test() {
  foo = 1
  bar = \`say hello\`
  bar
}`;

    const result = parseADL(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.nodes.length).toBe(1);
      expect(result.result.nodes[0].type).toBe("function");
      if (result.result.nodes[0].type === "function") {
        expect(result.result.nodes[0].functionName).toBe("test");
        expect(result.result.nodes[0].body.length).toBeGreaterThan(0);
      }
    }
  });
});
