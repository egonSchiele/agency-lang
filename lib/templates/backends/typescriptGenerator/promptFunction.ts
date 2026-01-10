// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/promptFunction.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
async function _{{{variableName:string}}}({{{argsStr:string}}}): Promise<{{{typeString:string}}}> {
  const prompt = {{{promptCode:string}}};
  const startTime = performance.now();
  const messages: Message[] = [userMessage(prompt)];
  const tools = {{{tools}}};

  // Need to make sure this is always an object
  const responseFormat = z.object({
     response: {{{zodSchema:string}}}
  });

  let completion = await client.text({
    messages,
    tools,
    responseFormat,
  });

  const endTime = performance.now();
  statelogClient.promptCompletion({
    messages,
    completion,
    model,
    timeTaken: endTime - startTime,
  });

  if (!completion.success) {
    throw new Error(
      \`Error getting response from $\{model\}: $\{completion.error\}\`
    );
  }

  let responseMessage = completion.value;

  // Handle function calls
  while (responseMessage.toolCalls.length > 0) {
    // Add assistant's response with tool calls to message history
    messages.push(assistantMessage(responseMessage.output));
    let toolCallStartTime, toolCallEndTime;

    // Process each tool call
    for (const toolCall of responseMessage.toolCalls) {
      {{{functionCalls:string}}}
    }

    const nextStartTime = performance.now();
    let completion = await client.text({
      messages,
      tools,
      responseFormat,
    });

    const nextEndTime = performance.now();

    statelogClient.promptCompletion({
      messages,
      completion,
      model,
      timeTaken: nextEndTime - nextStartTime,
    });

    if (!completion.success) {
      throw new Error(
        \`Error getting response from $\{model\}: $\{completion.error\}\`
      );
    }
    responseMessage = completion.value;
  }

  // Add final assistant response to history
  messages.push(assistantMessage(responseMessage.output));

  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
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
    