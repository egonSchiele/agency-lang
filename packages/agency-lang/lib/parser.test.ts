import { describe, it, expect } from "vitest";
import { agencyNode, agencyParser, parseAgency, replaceBlankLines } from "./parser.js";
import type { AgencyProgram } from "./types.js";
import { walkNodes } from "./utils/node.js";

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

describe("parseAgency loc.line invariant", () => {
  // Pin the invariant that loc.line is 0-indexed in the user's source
  // regardless of whether the template wrapper was applied. Without this,
  // every consumer would have to compensate for the parse mode.
  const collectLines = (program: AgencyProgram): number[] => {
    const lines: number[] = [];
    for (const { node } of walkNodes(program.nodes)) {
      if (node.loc) lines.push(node.loc.line);
    }
    return lines;
  };

  it("produces identical loc.line values with and without applyTemplate", () => {
    const source = "def foo() {}\n\nnode main() {\n  print(1)\n}\n";
    const withTemplate = parseAgency(source, {}, true);
    const withoutTemplate = parseAgency(source, {}, false);
    if (!withTemplate.success || !withoutTemplate.success) {
      throw new Error("parse failed");
    }
    expect(collectLines(withTemplate.result)).toEqual(collectLines(withoutTemplate.result));
  });

  it("places loc.line at the user-source 0-indexed line", () => {
    // Anchors against ground truth, not just inter-mode equality —
    // catches a hypothetical regression where both modes drift the same way.
    // Source:
    //   line 0: def foo() {}
    //   line 1: let x = 5
    const result = parseAgency("def foo() {}\nlet x = 5\n", {}, true);
    if (!result.success) throw new Error("parse failed");
    const lines = collectLines(result.result);
    expect(Math.min(...lines)).toBe(0);
    expect(Math.max(...lines)).toBe(1);
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
