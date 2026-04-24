// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/builtinFunctions/setLLMClient.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `function setLLMClient(client) {
  __globalCtx.setLLMClient(client);
}
`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    