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

