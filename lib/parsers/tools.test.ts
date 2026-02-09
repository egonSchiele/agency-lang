import { describe, it, expect } from "vitest";
import { usesToolParser } from "./tools.js";

describe("usesToolParser", () => {
  const testCases = [
    // Happy path - basic tool usage with + syntax
    {
      input: "+foo",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["foo"],
        },
      },
    },
    {
      input: "+bar",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["bar"],
        },
      },
    },
    {
      input: "+myTool",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["myTool"],
        },
      },
    },

    // Happy path - uses keyword syntax
    {
      input: "uses foo",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["foo"],
        },
      },
    },
    {
      input: "uses bar",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["bar"],
        },
      },
    },
    {
      input: "uses myTool",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["myTool"],
        },
      },
    },

    // Multiple tools with + syntax
    {
      input: "+foo, bar",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["foo", "bar"],
        },
      },
    },
    {
      input: "+tool1, tool2, tool3",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["tool1", "tool2", "tool3"],
        },
      },
    },
    {
      input: "+readFile, writeFile",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["readFile", "writeFile"],
        },
      },
    },

    // Multiple tools with uses keyword
    {
      input: "uses foo, bar",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["foo", "bar"],
        },
      },
    },
    {
      input: "uses tool1, tool2, tool3",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["tool1", "tool2", "tool3"],
        },
      },
    },
    {
      input: "uses readFile, writeFile, deleteFile",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["readFile", "writeFile", "deleteFile"],
        },
      },
    },

    // Tool names with numbers
    {
      input: "+tool123",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["tool123"],
        },
      },
    },
    {
      input: "uses test1",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["test1"],
        },
      },
    },
    {
      input: "+123",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["123"],
        },
      },
    },

    // Edge cases - single character tool names
    {
      input: "+x",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["x"],
        },
      },
    },
    {
      input: "uses a",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["a"],
        },
      },
    },

    // camelCase and PascalCase tool names
    {
      input: "+camelCaseTool",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["camelCaseTool"],
        },
      },
    },
    {
      input: "uses PascalCaseTool",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["PascalCaseTool"],
        },
      },
    },
    {
      input: "+UPPERCASETOOL",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["UPPERCASETOOL"],
        },
      },
    },

    // Tool names with underscores (if varNameChar supports it)
    {
      input: "+my_tool",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["my_tool"],
        },
      },
    },
    {
      input: "uses tool_name_123",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["tool_name_123"],
        },
      },
    },

    // Multiple tools with mixed casing
    {
      input: "+camelCase, snake_case, PascalCase",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolNames: ["camelCase", "snake_case", "PascalCase"],
        },
      },
    },

    // Failure cases - missing plus sign or uses keyword
    { input: "foo", expected: { success: false } },
    { input: "bar", expected: { success: false } },
    { input: "tool123", expected: { success: false } },

    // Failure cases - plus sign without tool name
    { input: "+", expected: { success: false } },

    // Failure cases - uses keyword without tool name
    { input: "uses ", expected: { success: false } },

    // Failure cases - empty input
    { input: "", expected: { success: false } },

    // Failure cases - incorrect symbols
    { input: "-tool", expected: { success: false } },
    { input: "*tool", expected: { success: false } },
    { input: "/tool", expected: { success: false } },
  ];

  testCases.forEach(({ input, expected }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = usesToolParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = usesToolParser(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
