// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/promptFunction.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
async function _{{{variableName:string}}}({{{argsStr:string}}}): Promise<{{{typeString:string}}}> {
  const prompt = {{{promptCode:string}}};
  const startTime = performance.now();
  const messages:any[] = [{ role: "user", content: prompt }];
  const tools = {{{tools}}};

  let completion = await client.text(prompt,{
    messages,
    tools,
    responseFormat: zodResponseFormat(z.object({
      value: {{{zodSchema:string}}}
    }), "{{{variableName:string}}}_response"),
  });
  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages,
    completion,
    model,
    timeTaken: endTime - startTime,
  });
  if (completion.success === false) {
    throw new Error("Completion failed: " + JSON.stringify(completion.error, null, 2));
  }

  let responseMessage = completion.value;
  // Handle function calls
  while (responseMessage.toolCalls.length > 0) {
    // Add assistant's response with tool calls to message history
    // this needs to be converted to an obj
    messages.push(responseMessage.output);
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.toolCalls) {
      {{{functionCalls:string}}}
    }

    const nextStartTime = performance.now();
    // Get the next response from the model
    completion = await client.text(responseMessage.output || "", {
      tools,
      messages
    });
    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages,
      completion,
      model,
      timeTaken: nextEndTime - nextStartTime,
    });

    if (completion.success === false) {
      throw new Error("Completion failed: " + JSON.stringify(completion.error, null, 2));
    }

    responseMessage = completion.value;
  }

  // Add final assistant response to history
  messages.push(responseMessage.output);

  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.value;
  } catch (e) {
    return responseMessage.output || "";
    // console.error("Error parsing response for variable '{{{variableName:string}}}':", e);
    // console.error("Full completion response:", JSON.stringify(completion, null, 2));
    // throw e;
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
    