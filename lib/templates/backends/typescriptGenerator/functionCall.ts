// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/functionCall.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (toolCall.type === "function" &&
  toolCall.function.name === "{{{name:string}}}"
) {
  const args = JSON.parse(toolCall.function.arguments);

  // Call the actual function
  const result = {{{name}}}(args);

  // Add function result to messages
  messages.push({
    role: "tool",
    tool_call_id: toolCall.id,
    content: JSON.stringify(result),
  });
}`;

export type TemplateType = {
  name: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    