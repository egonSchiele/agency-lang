import { describe, it, expect } from "vitest";
import { usesToolParser } from "@/parsers/tools";

describe("usesToolParser", () => {
  const testCases = [
    // Happy path - basic tool usage
    {
      input: "+foo",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolName: "foo",
        },
      },
    },
    {
      input: "+bar",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolName: "bar",
        },
      },
    },
    {
      input: "+myTool",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolName: "myTool",
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
          toolName: "tool123",
        },
      },
    },
    {
      input: "+test1",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolName: "test1",
        },
      },
    },
    {
      input: "+123",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolName: "123",
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
          toolName: "x",
        },
      },
    },
    {
      input: "+a",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolName: "a",
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
          toolName: "camelCaseTool",
        },
      },
    },
    {
      input: "+PascalCaseTool",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolName: "PascalCaseTool",
        },
      },
    },
    {
      input: "+UPPERCASETOOL",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolName: "UPPERCASETOOL",
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
          toolName: "my_tool",
        },
      },
    },
    {
      input: "+tool_name_123",
      expected: {
        success: true,
        result: {
          type: "usesTool",
          toolName: "tool_name_123",
        },
      },
    },

    // Failure cases - missing plus sign
    { input: "foo", expected: { success: false } },
    { input: "bar", expected: { success: false } },
    { input: "tool123", expected: { success: false } },

    // Failure cases - plus sign without tool name
    { input: "+", expected: { success: false } },

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
