// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/tool.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `const {{{name:string}}}Tool: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "{{{name:string}}}",
      description:
        "{{{description:string}}}",
      parameters: {
        type: "object",
        properties: {
          {{{properties:string}}}
        },
        required: [{{{requiredParameters:string}}}],
        additionalProperties: false,
      },
    },
  },
];`;

export type TemplateType = {
  name: string;
  description: string;
  properties: string;
  requiredParameters: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    