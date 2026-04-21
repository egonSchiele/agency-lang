// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/builtinFunctions/mcp.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `async function mcp(serverName: string) {
  return __ctx.mcpManager.getTools(serverName);
}`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    