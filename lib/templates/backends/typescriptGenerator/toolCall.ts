// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/toolCall.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (
  toolCall.name === "{{{name:string}}}"
) {
  const args = toolCall.arguments;

  const params = [ {{{paramsStr:string}}} ];

  console.log(\`>> Tool '{{{name:string}}}' called with arguments:\`, params);
  

  toolCallStartTime = performance.now();
  
  let result: any;
  if (__interruptResponse && __interruptResponse.type === "reject") {
        __messages.push(toolMessage("tool call rejected", {
        tool_call_id: toolCall.id,
        name: toolCall.name,
     }));
  } else {
    result = await {{{name}}}(params);
  }
  toolCallEndTime = performance.now();

  // console.log("Tool '{{{name:string}}}' called with arguments:", params);
  // console.log("Tool '{{{name:string}}}' returned result:", result);

await statelogClient.toolCall({
    toolName: "{{{name:string}}}",
    params,
    output: result,
    model: __client.getModel(),
    timeTaken: toolCallEndTime - toolCallStartTime,
  });

  if (isInterrupt(result)) {
    haltInterrupt = result;
    haltToolCall = {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    }
    haltExecution = true;
    break;
  }

    // Add function result to messages
  __messages.push(toolMessage(result, {
        tool_call_id: toolCall.id,
        name: toolCall.name,
  }));
}`;

export type TemplateType = {
  name: string;
  paramsStr: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    