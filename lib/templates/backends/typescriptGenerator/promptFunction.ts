// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/promptFunction.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `async function _{{{variableName:string}}}({{{argsStr:string}}}): Promise<{{{typeString:string}}}> {
  const prompt = {{{promptCode:string}}};
  const startTime = performance.now();
  console.log("Running prompt for {{{variableName:string}}}")
  const completion = await openai.chat.completions.create({
    model: "gpt-5-nano-2025-08-07",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    tools: tools,
    response_format: zodResponseFormat(z.object({
      value: {{{zodSchema:string}}}
    }), "{{{variableName:string}}}_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable '{{{variableName:string}}}' took " + (endTime - startTime).toFixed(2) + " ms");
  console.log("Completion response:", JSON.stringify(completion, null, 2));
  try {
  const result = JSON.parse(completion.choices[0].message.content || "");
  console.log("{{{variableName:string}}}:", result.value);
  return result.value;
  } catch (e) {
    console.error("Error parsing response for variable '{{{variableName:string}}}':", e);
    console.error("Full completion response:", JSON.stringify(completion, null, 2));
    throw e;
  }
}
`;

export type TemplateType = {
  variableName: string;
  argsStr: string;
  typeString: string;
  promptCode: string;
  zodSchema: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    