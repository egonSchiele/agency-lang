import { describe, it, expect } from "vitest";
import { importStatmentParser } from "./importStatement.js";

describe("importStatmentParser", () => {
  const testCases = [
    // Happy path - basic import
    {
      input: "import foo from bar;",
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
      input: "import myModule from path/to/module;",
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "myModule ",
          modulePath: "path/to/module",
        },
      },
    },

    // Module paths with double quotes
    {
      input: 'import foo from "bar";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "foo ",
          modulePath: '"bar"',
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
          modulePath: '"./local/path.js"',
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
          modulePath: '"../utils/helper.js"',
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
          modulePath: '"react"',
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
          modulePath: "'bar'",
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
          modulePath: "'./module.js'",
        },
      },
    },

    // Without semicolon (should still parse due to optionalSemicolon)
    {
      input: "import foo from bar\n",
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
      input: "import test from module",
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "test ",
          modulePath: "module",
        },
      },
    },
    {
      input: 'import foo from "bar"\n',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "foo ",
          modulePath: '"bar"',
        },
      },
    },

    // Multiple imported names (destructured imports)
    {
      input: "import { foo, bar } from module;",
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "{ foo, bar } ",
          modulePath: "module",
        },
      },
    },
    {
      input: 'import { foo, bar, baz } from "myModule";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "{ foo, bar, baz } ",
          modulePath: '"myModule"',
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
          modulePath: '"react"',
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
          modulePath: '"utils"',
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
          modulePath: '"@typescript-eslint/parser"',
        },
      },
    },

    // Spaces around keywords
    {
      input: "import   foo   from   bar;",
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "foo   ",
          modulePath: "bar",
        },
      },
    },

    // Edge cases - single character names
    {
      input: "import x from y;",
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "x ",
          modulePath: "y",
        },
      },
    },
    {
      input: 'import x from "y";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "x ",
          modulePath: '"y"',
        },
      },
    },

    // Complex paths
    {
      input: "import foo from ../../../utils/helpers;",
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "foo ",
          modulePath: "../../../utils/helpers",
        },
      },
    },
    {
      input: 'import foo from "../../../utils/helpers.js";',
      expected: {
        success: true,
        result: {
          type: "importStatement",
          importedNames: "foo ",
          modulePath: '"../../../utils/helpers.js"',
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
          modulePath: '"module"',
        },
      },
    },

    // Failure cases - missing keywords
    { input: "foo from bar;", expected: { success: false } },
    { input: "from bar;", expected: { success: false } },
    { input: "import foo bar;", expected: { success: false } },

    // Failure cases - missing parts
    { input: "import from bar;", expected: { success: false } },
    { input: "import foo from;", expected: { success: false } },
    { input: "import;", expected: { success: false } },

    // Failure cases - empty input
    { input: "", expected: { success: false } },

    // Failure cases - just keyword
    { input: "import", expected: { success: false } },
    { input: "from", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = importStatmentParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = importStatmentParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
