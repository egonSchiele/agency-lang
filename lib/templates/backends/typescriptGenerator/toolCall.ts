// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/toolCall.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (
  toolCall.name === "{{{name:string}}}"
) {
  const args = toolCall.arguments;

  toolCallStartTime = performance.now();
  const result = await {{{name}}}(args);
  toolCallEndTime = performance.now();

  console.log("Tool '{{{name:string}}}' called with arguments:", args);
  console.log("Tool '{{{name:string}}}' returned result:", result);

statelogClient.toolCall({
    toolName: "{{{name:string}}}",
    args,
    output: result,
    model: __client.getModel(),
    timeTaken: toolCallEndTime - toolCallStartTime,
  });

  // Add function result to messages
  __messages.push(toolMessage(result, {
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
    