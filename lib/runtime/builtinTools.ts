import { z } from "zod";

export const readSkillTool = {
  name: "readSkill",
  description: `Skills provide specialized knowledge and instructions for particular scenarios.
Use this tool when you need enhanced guidance for a specific type of task.

Args:
    filepath: The name of the skill to read.

Returns:
    The skill content with specialized instructions, or an error message
    if the skill is not found.
`,
  schema: z.object({ filepath: z.string() }),
};
export const readSkillToolParams = ["filepath"];

export const readTool = {
  name: "read",
  description: `A tool for reading the contents of a file and returning it as a string.`,
  schema: z.object({ filename: z.string() }),
};
export const readToolParams = ["filename"];

export const readImageTool = {
  name: "readImage",
  description: `A tool for reading an image file and returning its contents as a Base64-encoded string.`,
  schema: z.object({ filename: z.string() }),
};
export const readImageToolParams = ["filename"];

export const writeTool = {
  name: "write",
  description: `A tool for writing content to a file.`,
  schema: z.object({ filename: z.string(), content: z.string() }),
};
export const writeToolParams = ["filename", "content"];

