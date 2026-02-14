import { describe, it, expect } from "vitest";
import {
  importStatmentParser,
  importNodeStatmentParser,
  importToolStatmentParser,
} from "./importStatement.js";

describe("importStatmentParser", () => {
  const testCases = [
    // Unquoted module paths are no longer supported (start with "import" -> throw)
    {
      input: "import foo from bar;",
      expected: { success: false },
      throws: true,
    },
    {
      input: "import myModule from path/to/module;",
      expected: { success: false },
      throws: true,
    },

    // Module paths with double quotes
    {
      input: 'import foo from "bar";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "foo ",
          modulePath: "bar",
        },
      },
    },
    {
      input: 'import foo from "./local/path.js";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "foo ",
          modulePath: "./local/path.js",
        },
      },
    },
    {
      input: 'import bar from "../utils/helper.js";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "bar ",
          modulePath: "../utils/helper.js",
        },
      },
    },
    {
      input: 'import { useState } from "react";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "{ useState } ",
          modulePath: "react",
        },
      },
    },

    // Module paths with single quotes
    {
      input: "import foo from 'bar';",
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "foo ",
          modulePath: "bar",
        },
      },
    },
    {
      input: "import test from './module.js';",
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "test ",
          modulePath: "./module.js",
        },
      },
    },

    // Without semicolon - unquoted paths no longer supported (start with "import" -> throw)
    {
      input: "import foo from bar\n",
      expected: { success: false },
      throws: true,
    },
    {
      input: "import test from module",
      expected: { success: false },
      throws: true,
    },
    {
      input: 'import foo from "bar"\n',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "foo ",
          modulePath: "bar",
        },
      },
    },

    // Multiple imported names (destructured imports) - unquoted paths no longer supported (start with "import" -> throw)
    {
      input: "import { foo, bar } from module;",
      expected: { success: false },
      throws: true,
    },
    {
      input: 'import { foo, bar, baz } from "myModule";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "{ foo, bar, baz } ",
          modulePath: "myModule",
        },
      },
    },

    // Default and named imports
    {
      input: 'import React, { useState } from "react";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "React, { useState } ",
          modulePath: "react",
        },
      },
    },

    // Namespace imports
    {
      input: 'import * as utils from "utils";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "* as utils ",
          modulePath: "utils",
        },
      },
    },

    // Scoped packages
    {
      input: 'import { Parser } from "@typescript-eslint/parser";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "{ Parser } ",
          modulePath: "@typescript-eslint/parser",
        },
      },
    },

    // Spaces around keywords - unquoted paths no longer supported (start with "import" -> throw)
    {
      input: "import   foo   from   bar;",
      expected: { success: false },
      throws: true,
    },

    // Edge cases - single character names with unquoted path (start with "import" -> throw)
    {
      input: "import x from y;",
      expected: { success: false },
      throws: true,
    },
    {
      input: 'import x from "y";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "x ",
          modulePath: "y",
        },
      },
    },

    // Complex paths - unquoted paths no longer supported (start with "import" -> throw)
    {
      input: "import foo from ../../../utils/helpers;",
      expected: { success: false },
      throws: true,
    },
    {
      input: 'import foo from "../../../utils/helpers.js";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "foo ",
          modulePath: "../../../utils/helpers.js",
        },
      },
    },

    // Aliased imports
    {
      input: 'import { foo as bar } from "module";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "{ foo as bar } ",
          modulePath: "module",
        },
      },
    },

    // Failure cases - missing keywords (don't start with "import" -> don't throw)
    { input: "foo from bar;", expected: { success: false }, throws: false },
    { input: "from bar;", expected: { success: false }, throws: false },
    { input: "import foo bar;", expected: { success: false }, throws: true },

    // Failure cases - missing parts (start with "import" -> throw)
    { input: "import from bar;", expected: { success: false }, throws: true },
    { input: "import foo from;", expected: { success: false }, throws: true },
    { input: "import;", expected: { success: false }, throws: true },

    // Failure cases - empty input (doesn't start with "import" -> don't throw)
    { input: "", expected: { success: false }, throws: false },

    // Failure cases - just keyword
    { input: "import", expected: { success: false }, throws: true },
    { input: "from", expected: { success: false }, throws: false },
  ];

  testCases.forEach(({ input, expected, throws }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = importStatmentParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else if (throws) {
      it(`should fail to parse "${input}"`, () => {
        expect(() => importStatmentParser(input)).toThrow();
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = importStatmentParser(input);
        expect(result.success).toBe(false);
      });
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
