import { describe, it, expect } from "vitest";
import { skillParser } from "./skill.js";
import { eof, seqC, seqR } from "tarsec";

describe("skillParser", () => {
  const testCases = [
    // Happy path - basic syntax with "skill" keyword
    {
      input: 'skill "path/to/skill.ts"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "path/to/skill.ts",
        },
      },
    },
    {
      input: 'skill "./skills/analyze.ts"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "./skills/analyze.ts",
        },
      },
    },
    {
      input: 'skill "../utils/helper.ts"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "../utils/helper.ts",
        },
      },
    },

    // Happy path - basic syntax with "skills" keyword (plural)
    {
      input: 'skills "path/to/skill.ts"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "path/to/skill.ts",
        },
      },
    },
    {
      input: 'skills "./skills/process.ts"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "./skills/process.ts",
        },
      },
    },

    // Happy path - single quotes
    {
      input: "skill 'path/to/skill.ts'",
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "path/to/skill.ts",
        },
      },
    },
    {
      input: "skills './skills/analyze.ts'",
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "./skills/analyze.ts",
        },
      },
    },

    // Happy path - with description
    {
      input: 'skill "path/to/skill.ts", "Analyzes data"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "path/to/skill.ts",
          description: "Analyzes data",
        },
      },
    },
    {
      input: 'skills "./skills/process.ts", "Processes input"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "./skills/process.ts",
          description: "Processes input",
        },
      },
    },
    {
      input: 'skill "../utils/helper.ts", "Helper utilities"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "../utils/helper.ts",
          description: "Helper utilities",
        },
      },
    },

    // Happy path - with description using single quotes
    {
      input: "skill 'path/to/skill.ts', 'Analyzes data'",
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "path/to/skill.ts",
          description: "Analyzes data",
        },
      },
    },
    {
      input: "skills './skills/process.ts', 'Processes input'",
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "./skills/process.ts",
          description: "Processes input",
        },
      },
    },

    // Happy path - mixed quotes
    {
      input: "skill \"path/to/skill.ts\", 'Analyzes data'",
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "path/to/skill.ts",
          description: "Analyzes data",
        },
      },
    },
    {
      input: "skills './skills/process.ts', \"Processes input\"",
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "./skills/process.ts",
          description: "Processes input",
        },
      },
    },

    // Happy path - absolute paths
    {
      input: 'skill "/absolute/path/to/skill.ts"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "/absolute/path/to/skill.ts",
        },
      },
    },
    {
      input: 'skills "/usr/local/skills/analyze.ts", "System analyzer"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "/usr/local/skills/analyze.ts",
          description: "System analyzer",
        },
      },
    },

    // Happy path - paths with special characters
    {
      input: 'skill "./skills/analyze-data.ts"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "./skills/analyze-data.ts",
        },
      },
    },
    {
      input: 'skills "./skills/process_data.ts", "Process data"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "./skills/process_data.ts",
          description: "Process data",
        },
      },
    },

    // Happy path - nested paths
    {
      input: 'skill "./src/utils/skills/helper.ts"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "./src/utils/skills/helper.ts",
        },
      },
    },
    {
      input: 'skills "../../../common/skills/shared.ts", "Shared utilities"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "../../../common/skills/shared.ts",
          description: "Shared utilities",
        },
      },
    },

    // Happy path - descriptions with special characters
    {
      input: 'skill "./skill.ts", "Analyzes data & generates reports"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "./skill.ts",
          description: "Analyzes data & generates reports",
        },
      },
    },
    {
      input: 'skills "./skill.ts", "Process: analyze, transform, export"',
      expected: {
        success: true,
        result: {
          type: "skill",
          filepath: "./skill.ts",
          description: "Process: analyze, transform, export",
        },
      },
    },

    // Failure cases - missing keyword
    {
      input: '"path/to/skill.ts"',
      expected: { success: false },
      throws: false,
    },
    {
      input: "./skills/analyze.ts",
      expected: { success: false },
      throws: false,
    },

    // Failure cases - wrong keyword
    {
      input: 'tool "path/to/skill.ts"',
      expected: { success: false },
      throws: false,
    },
    {
      input: 'import "path/to/skill.ts"',
      expected: { success: false },
      throws: false,
    },

    // Failure cases - missing quotes
    {
      input: "skill path/to/skill.ts",
      expected: { success: false },
      throws: false,
    },
    {
      input: "skills ./skills/analyze.ts",
      expected: { success: false },
      throws: false,
    },

    // Failure cases - missing filepath
    { input: "skill", expected: { success: false }, throws: false },
    { input: "skills", expected: { success: false }, throws: false },
    { input: 'skill ""', expected: { success: false }, throws: false },
    { input: "skills ''", expected: { success: false }, throws: false },

    // Failure cases - missing comma between filepath and description
    {
      input: 'skill "path/to/skill.ts" "description"',
      expected: { success: false },
      throws: false,
    },
    {
      input: 'skills "./skill.ts" "Analyzes data"',
      expected: { success: false },
      throws: false,
    },

    // Failure cases - missing description after comma
    {
      input: 'skill "path/to/skill.ts",',
      expected: { success: false },
      throws: false,
    },
    {
      input: 'skills "./skill.ts",',
      expected: { success: false },
      throws: false,
    },

    // Failure cases - empty input
    { input: "", expected: { success: false }, throws: false },

    // Failure cases - only whitespace
    { input: "   ", expected: { success: false }, throws: false },
    { input: "\t\n", expected: { success: false }, throws: false },
  ];

  testCases.forEach(({ input, expected, throws }) => {
    if (expected.success) {
      it(`should parse "${input}" successfully`, () => {
        const result = skillParser(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toEqual(expected.result);
        }
      });
    } else if (throws) {
      it(`should fail to parse "${input}"`, () => {
        expect(() => skillParser(input)).toThrow();
      });
    } else {
      it(`should fail to parse "${input}"`, () => {
        const result = seqC(skillParser, eof)(input);
        expect(result.success).toBe(false);
      });
    }
  });
});
