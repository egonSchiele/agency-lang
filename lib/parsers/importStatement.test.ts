import { describe, it, expect } from "vitest";
import {
  importStatmentParser,
  importNodeStatmentParser,
  importToolStatmentParser,
} from "./importStatement.js";

describe("importStatmentParser", () => {
  // Default imports
  it('should parse: import foo from "./foo.ts"', () => {
    const result = importStatmentParser('import foo from "./foo.ts"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "importStatement",
        importedNames: [{ type: "defaultImport", importedNames: "foo" }],
        modulePath: "./foo.ts",
      });
    }
  });

  // Named imports
  it('should parse: import { foo } from "./foo.ts"', () => {
    const result = importStatmentParser('import { foo } from "./foo.ts"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "importStatement",
        importedNames: [{ type: "namedImport", importedNames: ["foo"] }],
        modulePath: "./foo.ts",
      });
    }
  });

  // Default + named imports
  it('should parse: import foo, { bar } from "./foo.ts"', () => {
    const result = importStatmentParser('import foo, { bar } from "./foo.ts"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "importStatement",
        importedNames: [
          { type: "defaultImport", importedNames: "foo" },
          { type: "namedImport", importedNames: ["bar"] },
        ],
        modulePath: "./foo.ts",
      });
    }
  });

  // Namespace imports
  it('should parse: import * as foo from "./foo.ts"', () => {
    const result = importStatmentParser('import * as foo from "./foo.ts"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "importStatement",
        importedNames: [{ type: "namespaceImport", importedNames: "foo" }],
        modulePath: "./foo.ts",
      });
    }
  });

  // Default + namespace imports
  it('should parse: import foo, * as bar from "./foo.ts"', () => {
    const result = importStatmentParser(
      'import foo, * as bar from "./foo.ts"',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "importStatement",
        importedNames: [
          { type: "defaultImport", importedNames: "foo" },
          { type: "namespaceImport", importedNames: "bar" },
        ],
        modulePath: "./foo.ts",
      });
    }
  });

  // .agency file imports
  it('should parse: import foo from "./foo.agency"', () => {
    const result = importStatmentParser('import foo from "./foo.agency"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "importStatement",
        importedNames: [{ type: "defaultImport", importedNames: "foo" }],
        modulePath: "./foo.agency",
      });
    }
  });

  it('should parse: import { foo } from "./foo.agency"', () => {
    const result = importStatmentParser('import { foo } from "./foo.agency"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "importStatement",
        importedNames: [{ type: "namedImport", importedNames: ["foo"] }],
        modulePath: "./foo.agency",
      });
    }
  });

  // node/tool imports are handled by their own parsers, not importStatmentParser
  it('should not parse: import node { foo } from "./foo.agency"', () => {
    expect(() =>
      importStatmentParser('import node { foo } from "./foo.agency"'),
    ).toThrow();
  });

  it('should not parse: import tool { foo } from "./foo.agency"', () => {
    expect(() =>
      importStatmentParser('import tool { foo } from "./foo.agency"'),
    ).toThrow();
  });

  // Multiple named imports
  it('should parse: import { foo, bar, baz } from "myModule"', () => {
    const result = importStatmentParser(
      'import { foo, bar, baz } from "myModule"',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({
        type: "importStatement",
        importedNames: [
          { type: "namedImport", importedNames: ["foo", "bar", "baz"] },
        ],
        modulePath: "myModule",
      });
    }
  });

  // With semicolons
  it('should parse imports with semicolons', () => {
    const result = importStatmentParser('import foo from "./foo.ts";');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.modulePath).toBe("./foo.ts");
    }
  });

  // With single quotes
  it("should parse imports with single quotes", () => {
    const result = importStatmentParser("import foo from './foo.ts'");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.modulePath).toBe("./foo.ts");
    }
  });

  // Failure cases
  it("should fail on empty input", () => {
    const result = importStatmentParser("");
    expect(result.success).toBe(false);
  });

  it("should fail on non-import input", () => {
    const result = importStatmentParser("foo from bar;");
    expect(result.success).toBe(false);
  });

  it("should throw on unquoted paths", () => {
    expect(() => importStatmentParser("import foo from bar;")).toThrow();
  });

  it("should throw on missing parts", () => {
    expect(() => importStatmentParser("import foo from;")).toThrow();
  });
});

describe("importNodeStatmentParser", () => {
  const testCases = [
    // Basic syntax with "nodes" keyword
    {
      input: 'import nodes { myNode } from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["myNode"],
          agencyFile: "file.agency",
        },
      },
    },
    {
      input: 'import nodes { node1 } from "./path/to/file.agency";',
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["node1"],
          agencyFile: "./path/to/file.agency",
        },
      },
    },

    // Basic syntax with "node" keyword (singular)
    {
      input: 'import node { myNode } from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["myNode"],
          agencyFile: "file.agency",
        },
      },
    },

    // Multiple nodes
    {
      input: 'import nodes { node1, node2 } from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["node1", "node2"],
          agencyFile: "file.agency",
        },
      },
    },
    {
      input: 'import nodes { node1, node2, node3 } from "multi.agency";',
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["node1", "node2", "node3"],
          agencyFile: "multi.agency",
        },
      },
    },

    // Single quotes
    {
      input: "import nodes { myNode } from 'file.agency';",
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["myNode"],
          agencyFile: "file.agency",
        },
      },
    },
    {
      input: "import node { node1, node2 } from '../other.agency';",
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["node1", "node2"],
          agencyFile: "../other.agency",
        },
      },
    },

    // Without semicolon
    {
      input: 'import nodes { myNode } from "file.agency"',
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["myNode"],
          agencyFile: "file.agency",
        },
      },
    },

    // No spaces in braces
    {
      input: 'import nodes {node1} from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["node1"],
          agencyFile: "file.agency",
        },
      },
    },
    {
      input: 'import nodes {node1,node2,node3} from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["node1", "node2", "node3"],
          agencyFile: "file.agency",
        },
      },
    },

    // Extra spaces
    {
      input: 'import nodes {  node1  ,  node2  } from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["node1", "node2"],
          agencyFile: "file.agency",
        },
      },
    },

    // Different file paths
    {
      input: 'import nodes { node1 } from "../../../utils/nodes.agency";',
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["node1"],
          agencyFile: "../../../utils/nodes.agency",
        },
      },
    },
    {
      input: 'import nodes { node1 } from "/absolute/path/file.agency";',
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["node1"],
          agencyFile: "/absolute/path/file.agency",
        },
      },
    },

    // Alphanumeric node names
    {
      input: 'import nodes { node1, node2abc, test123 } from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importNodeStatement",
          importedNodes: ["node1", "node2abc", "test123"],
          agencyFile: "file.agency",
        },
      },
    },

    // Failure cases - wrong keyword (doesn't match "import nodes/node" -> don't throw)
    {
      input: 'import tools { myNode } from "file.agency";',
      expected: { success: false },
      throws: false,
    },
    {
      input: 'import { myNode } from "file.agency";',
      expected: { success: false },
      throws: false,
    },

    // Failure cases - missing parts (matches "import nodes/node" -> throws)
    {
      input: 'import nodes from "file.agency";',
      expected: { success: false },
      throws: true,
    },
    {
      input: 'import nodes { myNode } from;',
      expected: { success: false },
      throws: true,
    },
    {
      input: 'import nodes { myNode };',
      expected: { success: false },
      throws: true,
    },
    {
      input: 'nodes { myNode } from "file.agency";',
      expected: { success: false },
      throws: false,
    },

    // Failure cases - empty braces (matches "import nodes/node {" -> throws)
    {
      input: 'import nodes {} from "file.agency";',
      expected: { success: false },
      throws: true,
    },
    {
      input: 'import nodes { } from "file.agency";',
      expected: { success: false },
      throws: true,
    },

    // Failure cases - missing quotes (matches "import nodes/node { ... }" -> throws)
    {
      input: "import nodes { myNode } from file.agency;",
      expected: { success: false },
      throws: true,
    },

    // Failure cases - mismatched quotes (matches "import nodes/node { ... }" -> throws)
    {
      input: 'import nodes { myNode } from "file.agency\';',
      expected: { success: false },
      throws: true,
    },

    // Failure cases - missing braces (matches "import nodes/node" -> throws)
    {
      input: 'import nodes myNode from "file.agency";',
      expected: { success: false },
      throws: true,
    },

    // Failure cases - empty input (doesn't match "import" -> doesn't throw)
    {
      input: "",
      expected: { success: false },
      throws: false,
    },
  ];

  testCases.forEach(({ input, expected, throws }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = importNodeStatmentParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else if (throws) {
      it(`should fail to parse "${input}"`, () => {
        expect(() => importNodeStatmentParser(input)).toThrow();
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = importNodeStatmentParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});

describe("importToolStatmentParser", () => {
  const testCases = [
    // Basic syntax with "tools" keyword
    {
      input: 'import tools { myTool } from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["myTool"],
          agencyFile: "file.agency",
        },
      },
    },
    {
      input: 'import tools { tool1 } from "./path/to/file.agency";',
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["tool1"],
          agencyFile: "./path/to/file.agency",
        },
      },
    },

    // Basic syntax with "tool" keyword (singular)
    {
      input: 'import tool { myTool } from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["myTool"],
          agencyFile: "file.agency",
        },
      },
    },

    // Multiple tools
    {
      input: 'import tools { tool1, tool2 } from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["tool1", "tool2"],
          agencyFile: "file.agency",
        },
      },
    },
    {
      input: 'import tools { tool1, tool2, tool3 } from "multi.agency";',
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["tool1", "tool2", "tool3"],
          agencyFile: "multi.agency",
        },
      },
    },

    // Single quotes
    {
      input: "import tools { myTool } from 'file.agency';",
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["myTool"],
          agencyFile: "file.agency",
        },
      },
    },
    {
      input: "import tool { tool1, tool2 } from '../other.agency';",
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["tool1", "tool2"],
          agencyFile: "../other.agency",
        },
      },
    },

    // Without semicolon
    {
      input: 'import tools { myTool } from "file.agency"',
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["myTool"],
          agencyFile: "file.agency",
        },
      },
    },

    // No spaces in braces
    {
      input: 'import tools {tool1} from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["tool1"],
          agencyFile: "file.agency",
        },
      },
    },
    {
      input: 'import tools {tool1,tool2,tool3} from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["tool1", "tool2", "tool3"],
          agencyFile: "file.agency",
        },
      },
    },

    // Extra spaces
    {
      input: 'import tools {  tool1  ,  tool2  } from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["tool1", "tool2"],
          agencyFile: "file.agency",
        },
      },
    },

    // Different file paths
    {
      input: 'import tools { tool1 } from "../../../utils/tools.agency";',
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["tool1"],
          agencyFile: "../../../utils/tools.agency",
        },
      },
    },
    {
      input: 'import tools { tool1 } from "/absolute/path/file.agency";',
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["tool1"],
          agencyFile: "/absolute/path/file.agency",
        },
      },
    },

    // Alphanumeric tool names
    {
      input: 'import tools { tool1, tool2abc, test123 } from "file.agency";',
      expected: {
        success: true,
        result: {
          type: "importToolStatement",
          importedTools: ["tool1", "tool2abc", "test123"],
          agencyFile: "file.agency",
        },
      },
    },

    // Failure cases - wrong keyword (doesn't match "import tools/tool" -> don't throw)
    {
      input: 'import nodes { myTool } from "file.agency";',
      expected: { success: false },
      throws: false,
    },
    {
      input: 'import { myTool } from "file.agency";',
      expected: { success: false },
      throws: false,
    },

    // Failure cases - missing parts (matches "import tools/tool" -> throws)
    {
      input: 'import tools from "file.agency";',
      expected: { success: false },
      throws: true,
    },
    {
      input: 'import tools { myTool } from;',
      expected: { success: false },
      throws: true,
    },
    {
      input: 'import tools { myTool };',
      expected: { success: false },
      throws: true,
    },
    {
      input: 'tools { myTool } from "file.agency";',
      expected: { success: false },
      throws: false,
    },

    // Failure cases - empty braces (matches "import tools/tool {" -> throws)
    {
      input: 'import tools {} from "file.agency";',
      expected: { success: false },
      throws: true,
    },
    {
      input: 'import tools { } from "file.agency";',
      expected: { success: false },
      throws: true,
    },

    // Failure cases - missing quotes (matches "import tools/tool { ... }" -> throws)
    {
      input: "import tools { myTool } from file.agency;",
      expected: { success: false },
      throws: true,
    },

    // Failure cases - mismatched quotes (matches "import tools/tool { ... }" -> throws)
    {
      input: 'import tools { myTool } from "file.agency\';',
      expected: { success: false },
      throws: true,
    },

    // Failure cases - missing braces (matches "import tools/tool" -> throws)
    {
      input: 'import tools myTool from "file.agency";',
      expected: { success: false },
      throws: true,
    },

    // Failure cases - empty input (doesn't match "import" -> doesn't throw)
    {
      input: "",
      expected: { success: false },
      throws: false,
    },
  ];

  testCases.forEach(({ input, expected, throws }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = importToolStatmentParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else if (throws) {
      it(`should fail to parse "${input}"`, () => {
        expect(() => importToolStatmentParser(input)).toThrow();
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = importToolStatmentParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
