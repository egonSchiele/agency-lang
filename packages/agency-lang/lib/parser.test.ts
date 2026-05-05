import { describe, it, expect } from "vitest";
import { agencyNode, agencyParser, parseAgency, replaceBlankLines } from "./parser.js";

const S = "\uE000";

describe("replaceBlankLines", () => {
  it("replaces a simple blank line", () => {
    const input = "a\n\nb";
    expect(replaceBlankLines(input)).toBe(`a${S}\nb`);
  });

  it("replaces multiple consecutive blank lines", () => {
    const input = "a\n\n\nb";
    expect(replaceBlankLines(input)).toBe(`a${S}${S}\nb`);
  });

  it("preserves length", () => {
    const input = "a\n\nb";
    expect(replaceBlankLines(input).length).toBe(input.length);
  });

  it("does not touch non-blank lines", () => {
    const input = "a\nb\nc";
    expect(replaceBlankLines(input)).toBe("a\nb\nc");
  });

  it("handles blank line at start of input", () => {
    const input = "\n\na";
    expect(replaceBlankLines(input)).toBe(`${S}\na`);
  });

  it("handles blank line at end of input", () => {
    const input = "a\n\n";
    expect(replaceBlankLines(input)).toBe(`a${S}\n`);
  });
});

describe("agencyNode", () => {
  const testCases = [
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
      input: "let foo: string = `hello`",
      expected: {
        success: true,
        firstNodeType: "assignment",
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
      input: "let bar: number = 5",
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
      input: "let result: number = `the number 42`",
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

describe("parseAgency structured errors", () => {
  it("should return errorData with position info for syntax errors that trigger TarsecError", () => {
    // This malformed input should surface structured tarsec position info.
    const result = parseAgency("def foo( { }", {}, false);
    if (!result.success && result.errorData) {
      expect(typeof result.errorData.line).toBe("number");
      expect(typeof result.errorData.column).toBe("number");
      expect(typeof result.errorData.length).toBe("number");
      expect(typeof result.errorData.prettyMessage).toBe("string");
    }
    expect(result.success).toBe(false);
  });

  it("should return a plain failure for non-TarsecError parse failures", () => {
    const result = parseAgency("x = 5\n!!!", {}, false);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBeDefined();
    }
  });
});

describe("parseAgency", () => {
  const testCases = [
    {
      input: "let bar: number = `the number 1`",
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
      input: "let name: string = `generate a name`\ngreet(name)",
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
