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

export const printTool = {
  name: "print",
  description: `A tool for printing messages to the console.`,
  schema: z.object({ message: z.string() }),
};
export const printToolParams = ["message"];

export const printJSONTool = {
  name: "printJSON",
  description: `A tool for printing an object as formatted JSON to the console.`,
  schema: z.object({ obj: z.any() }),
};
export const printJSONToolParams = ["obj"];

export const inputTool = {
  name: "input",
  description: `A tool for prompting the user for input and returning their response.`,
  schema: z.object({ prompt: z.string() }),
};
export const inputToolParams = ["prompt"];

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

export const fetchTool = {
  name: "fetch",
  description: `A tool for fetching a URL and returning the response as text.`,
  schema: z.object({ url: z.string() }),
};
export const fetchToolParams = ["url"];

export const fetchJSONTool = {
  name: "fetchJSON",
  description: `A tool for fetching a URL and returning the response as parsed JSON.`,
  schema: z.object({ url: z.string() }),
};
export const fetchJSONToolParams = ["url"];

export const fetchJsonTool = fetchJSONTool;
export const fetchJsonToolParams = fetchJSONToolParams;

export const sleepTool = {
  name: "sleep",
  description: `A tool for pausing execution for a specified number of seconds.`,
  schema: z.object({ seconds: z.number() }),
};
export const sleepToolParams = ["seconds"];

export const roundTool = {
  name: "round",
  description: `A tool for rounding a number to a specified number of decimal places.`,
  schema: z.object({
    num: z.number(),
    precision: z.number().optional().default(0),
  }),
};
export const roundToolParams = ["num", "precision"];
