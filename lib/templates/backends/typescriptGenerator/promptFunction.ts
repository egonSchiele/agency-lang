// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/promptFunction.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
async function _{{{variableName:string}}}({{{argsStr:string}}}): Promise<{{{typeString:string}}}> {
  const prompt = {{{promptCode:string}}};
  const startTime = performance.now();
  const messages:any[] = [{ role: "user", content: prompt }];
  const tools = [{{{tools}}}];
  console.log("Running prompt for {{{variableName:string}}}")
  let completion = await openai.chat.completions.create({
    model: "gpt-5-nano-2025-08-07",
    messages,
    tools,
    response_format: zodResponseFormat(z.object({
      value: {{{zodSchema:string}}}
    }), "{{{variableName:string}}}_response"),
  });
  const endTime = performance.now();
  console.log("Prompt for variable '{{{variableName:string}}}' took " + (endTime - startTime).toFixed(2) + " ms");
  console.log("Completion response:", JSON.stringify(completion, null, 2));

  let responseMessage = completion.choices[0].message;
  // Handle function calls
  while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    // Add assistant's response with tool calls to message history
    messages.push(responseMessage);

    // Process each tool call
    for (const toolCall of responseMessage.tool_calls) {
      {{{functionCalls:string}}}
    }

    // Get the next response from the model
    completion = await openai.chat.completions.create({
      model: "gpt-5-nano-2025-08-07",
      messages: messages,
      tools: tools,
    });

    responseMessage = completion.choices[0].message;
  }

  // Add final assistant response to history
  messages.push(responseMessage);

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
  tools: string | boolean | number;
  zodSchema: string;
  functionCalls: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    