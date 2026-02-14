// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/toolCall.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (
  toolCall.name === "{{{name:string}}}"
) {
  const args = toolCall.arguments;

  const params = __{{{name:string}}}ToolParams.map((param, index) => {
            return args[param];
          })

  toolCallStartTime = performance.now();
  
  let result: any;
  if (__interruptResponse && __interruptResponse.type === "reject") {
        __messages.push(smoltalk.smoltalk.toolMessage("tool call rejected", {
        tool_call_id: toolCall.id,
        name: toolCall.name,
     }));
  } else {
    result = await {{{name}}}(params);
  }
  toolCallEndTime = performance.now();

  statelogClient.toolCall({
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
  __messages.push(smoltalk.toolMessage(result, {
        tool_call_id: toolCall.id,
        name: toolCall.name,
  }));
}`;

export type TemplateType = {
  name: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    