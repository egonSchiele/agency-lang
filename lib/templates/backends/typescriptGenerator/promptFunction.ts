// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/promptFunction.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `
async function _{{{variableName:string}}}({{{argsStr:string}}}): Promise<{{{typeString:string}}}> {
  const __prompt = {{{promptCode:string}}};
  const startTime = performance.now();
  __messages.push(userMessage(__prompt));
  const __tools = {{{tools}}};

  {{#hasResponseFormat}}
  // Need to make sure this is always an object
  const __responseFormat = z.object({
     response: {{{zodSchema:string}}}
  });
  {{/hasResponseFormat}}
  {{^hasResponseFormat}}
  const __responseFormat = undefined;
  {{/hasResponseFormat}}

  const __client = getClientWithConfig({{{clientConfig:string}}});

  let __completion = await __client.text({
    messages: __messages,
    tools: __tools,
    responseFormat: __responseFormat,
  });

  const endTime = performance.now();
  await statelogClient.promptCompletion({
    messages: __messages,
    completion: __completion,
    model: __client.getModel(),
    timeTaken: endTime - startTime,
  });

  if (!__completion.success) {
    throw new Error(
      \`Error getting response from $\{__model\}: $\{__completion.error\}\`
    );
  }

  let responseMessage = __completion.value;

  // Handle function calls
  while (responseMessage.toolCalls.length > 0) {
    // Add assistant's response with tool calls to message history
    __messages.push(assistantMessage(responseMessage.output, { toolCalls: responseMessage.toolCalls }));
    let toolCallStartTime, toolCallEndTime;
    let haltExecution = false;
    let haltToolCall = {}

    // Process each tool call
    for (const toolCall of responseMessage.toolCalls) {
      {{{functionCalls:string}}}
    }

    if (haltExecution) {
      await statelogClient.debug(\`Tool call interrupted execution.\`, {
        messages: __messages,
        model: __client.getModel(),
      });
      try {
        const obj = JSON.parse(__messages.at(-1).content);
        obj.__messages = __messages;
        obj.__nodesTraversed = __graph.getNodesTraversed();
        obj.__toolCall = haltToolCall;
        return obj;
      } catch (e) {
        return __messages.at(-1).content;
      }
      //return __messages;
    }
  
    const nextStartTime = performance.now();
    let __completion = await __client.text({
      messages: __messages,
      tools: __tools,
      responseFormat: __responseFormat,
    });

    const nextEndTime = performance.now();

    await statelogClient.promptCompletion({
      messages: __messages,
      completion: __completion,
      model: __client.getModel(),
      timeTaken: nextEndTime - nextStartTime,
    });

    if (!__completion.success) {
      throw new Error(
        \`Error getting response from $\{__model\}: $\{__completion.error\}\`
      );
    }
    responseMessage = __completion.value;
  }

  // Add final assistant response to history
  // not passing tool calls back this time
  __messages.push(assistantMessage(responseMessage.output));
  {{#hasResponseFormat}}
  try {
  const result = JSON.parse(responseMessage.output || "");
  return result.response;
  } catch (e) {
    return responseMessage.output;
    // console.error("Error parsing response for variable '{{{variableName:string}}}':", e);
    // console.error("Full completion response:", JSON.stringify(__completion, null, 2));
    // throw e;
  }
  {{/hasResponseFormat}}

  {{^hasResponseFormat}}
  return responseMessage.output;
  {{/hasResponseFormat}}
}

const {{{variableName:string}}} = await _{{{variableName:string}}}({{{funcCallParams:string}}});
`;

export type TemplateType = {
  variableName: string;
  argsStr: string;
  typeString: string;
  promptCode: string;
  tools: string | boolean | number;
  hasResponseFormat: boolean;
  zodSchema: string;
  clientConfig: string;
  functionCalls: string;
  funcCallParams: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    