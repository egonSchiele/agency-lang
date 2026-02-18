// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/startNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const initialState = { messages: [], data: {} };
    await main(initialState);
}`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    