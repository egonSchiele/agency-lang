import { describe, it, expect } from "vitest";
import {
  importStatmentParser,
  importNodeStatmentParser,
} from "./parsers.js";

describe("importStatmentParser", () => {
  // Default imports
  it('should parse: import foo from "./foo.ts"', () => {
    const result = importStatmentParser('import foo from "./foo.ts"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [{ type: "defaultImport", importedNames: "foo" }],
        modulePath: "./foo.ts",
        isAgencyImport: false,
      });
    }
  });

  // Named imports
  it('should parse: import { foo } from "./foo.ts"', () => {
    const result = importStatmentParser('import { foo } from "./foo.ts"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          { type: "namedImport", importedNames: ["foo"], aliases: {} },
        ],
        modulePath: "./foo.ts",
        isAgencyImport: false,
      });
    }
  });

  // Default + named imports
  it('should parse: import foo, { bar } from "./foo.ts"', () => {
    const result = importStatmentParser('import foo, { bar } from "./foo.ts"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          { type: "defaultImport", importedNames: "foo" },
          { type: "namedImport", importedNames: ["bar"], aliases: {} },
        ],
        modulePath: "./foo.ts",
        isAgencyImport: false,
      });
    }
  });

  // Namespace imports
  it('should parse: import * as foo from "./foo.ts"', () => {
    const result = importStatmentParser('import * as foo from "./foo.ts"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [{ type: "namespaceImport", importedNames: "foo" }],
        modulePath: "./foo.ts",
        isAgencyImport: false,
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
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          { type: "defaultImport", importedNames: "foo" },
          { type: "namespaceImport", importedNames: "bar" },
        ],
        modulePath: "./foo.ts",
        isAgencyImport: false,
      });
    }
  });

  // .agency file imports
  it('should parse: import foo from "./foo.agency"', () => {
    const result = importStatmentParser('import foo from "./foo.agency"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [{ type: "defaultImport", importedNames: "foo" }],
        modulePath: "./foo.agency",
        isAgencyImport: true,
      });
    }
  });

  it('should parse: import { foo } from "./foo.agency"', () => {
    const result = importStatmentParser('import { foo } from "./foo.agency"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          { type: "namedImport", importedNames: ["foo"], aliases: {} },
        ],
        modulePath: "./foo.agency",
        isAgencyImport: true,
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
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          {
            type: "namedImport",
            importedNames: ["foo", "bar", "baz"],
            aliases: {},
          },
        ],
        modulePath: "myModule",
        isAgencyImport: false,
      });
    }
  });

  // Idempotent imports
  it('should parse: import { idempotent foo, bar } from "./tools.js"', () => {
    const result = importStatmentParser(
      'import { idempotent foo, bar } from "./tools.js"',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          {
            type: "namedImport",
            importedNames: ["foo", "bar"],
            idempotentNames: ["foo"],
            aliases: {},
          },
        ],
        modulePath: "./tools.js",
        isAgencyImport: false,
      });
    }
  });

  it('should parse: import { idempotent foo, idempotent bar, baz } from "./tools.js"', () => {
    const result = importStatmentParser(
      'import { idempotent foo, idempotent bar, baz } from "./tools.js"',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          {
            type: "namedImport",
            importedNames: ["foo", "bar", "baz"],
            idempotentNames: ["foo", "bar"],
            aliases: {},
          },
        ],
        modulePath: "./tools.js",
        isAgencyImport: false,
      });
    }
  });

  it('should parse: import { idempotent foo } from "./tools.js"', () => {
    const result = importStatmentParser(
      'import { idempotent foo } from "./tools.js"',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          {
            type: "namedImport",
            importedNames: ["foo"],
            idempotentNames: ["foo"],
            aliases: {},
          },
        ],
        modulePath: "./tools.js",
        isAgencyImport: false,
      });
    }
  });

  it('should parse: import { destructive rm, stat } from "./tools.js"', () => {
    const result = importStatmentParser(
      'import { destructive rm, stat } from "./tools.js"',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          {
            type: "namedImport",
            importedNames: ["rm", "stat"],
            destructiveNames: ["rm"],
            aliases: {},
          },
        ],
        modulePath: "./tools.js",
        isAgencyImport: false,
      });
    }
  });

  it('should parse: import { idempotent a, destructive b } from "./tools.js"', () => {
    const result = importStatmentParser(
      'import { idempotent a, destructive b } from "./tools.js"',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          {
            type: "namedImport",
            importedNames: ["a", "b"],
            idempotentNames: ["a"],
            destructiveNames: ["b"],
            aliases: {},
          },
        ],
        modulePath: "./tools.js",
        isAgencyImport: false,
      });
    }
  });

  it('should parse: import { destructive rm as remove } from "./tools.js"', () => {
    const result = importStatmentParser(
      'import { destructive rm as remove } from "./tools.js"',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          {
            type: "namedImport",
            importedNames: ["rm"],
            destructiveNames: ["rm"],
            aliases: { rm: "remove" },
          },
        ],
        modulePath: "./tools.js",
        isAgencyImport: false,
      });
    }
  });

  // Aliased imports
  it('should parse: import { foo as bar } from "./foo.ts"', () => {
    const result = importStatmentParser(
      'import { foo as bar } from "./foo.ts"',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          {
            type: "namedImport",
            importedNames: ["foo"],
            aliases: { foo: "bar" },
          },
        ],
        modulePath: "./foo.ts",
        isAgencyImport: false,
      });
    }
  });

  it('should parse: import { foo as f, bar as b, baz } from "./mod.js"', () => {
    const result = importStatmentParser(
      'import { foo as f, bar as b, baz } from "./mod.js"',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          {
            type: "namedImport",
            importedNames: ["foo", "bar", "baz"],
            aliases: { foo: "f", bar: "b" },
          },
        ],
        modulePath: "./mod.js",
        isAgencyImport: false,
      });
    }
  });

  it('should parse: import { idempotent foo as f } from "./tools.js"', () => {
    const result = importStatmentParser(
      'import { idempotent foo as f } from "./tools.js"',
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          {
            type: "namedImport",
            importedNames: ["foo"],
            idempotentNames: ["foo"],
            aliases: { foo: "f" },
          },
        ],
        modulePath: "./tools.js",
        isAgencyImport: false,
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

  // Test-only imports: `import test { ... }`
  it('parses: import test { foo } from "std::x" with testOnly true', () => {
    const result = importStatmentParser('import test { foo } from "std::x"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqualWithoutLoc({
        type: "importStatement",
        importedNames: [
          { type: "namedImport", importedNames: ["foo"], aliases: {} },
        ],
        modulePath: "std::x",
        isAgencyImport: true,
        testOnly: true,
      });
    }
  });

  it('parses: import { test } from "./m.agency" as a symbol named test (no testOnly key)', () => {
    const result = importStatmentParser('import { test } from "./m.agency"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect("testOnly" in result.result).toBe(false); // not null, not false — absent
      const first = result.result.importedNames[0];
      expect(first.type).toBe("namedImport");
      if (first.type === "namedImport") {
        expect(first.importedNames).toEqual(["test"]);
      }
    }
  });

  it('parses: import test from "./t.ts" as a default import named test', () => {
    const result = importStatmentParser('import test from "./t.ts"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect("testOnly" in result.result).toBe(false);
      expect(result.result.importedNames).toEqual([
        { type: "defaultImport", importedNames: "test" },
      ]);
    }
  });

  it('parses: import test, { bar } from "./x.ts" as default(test) + named(bar)', () => {
    const result = importStatmentParser('import test, { bar } from "./x.ts"');
    expect(result.success).toBe(true);
    if (result.success) {
      expect("testOnly" in result.result).toBe(false);
      expect(result.result.importedNames).toEqual([
        { type: "defaultImport", importedNames: "test" },
        { type: "namedImport", importedNames: ["bar"], aliases: {} },
      ]);
    }
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
          expect(result.result).toEqualWithoutLoc(expected.result);
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

