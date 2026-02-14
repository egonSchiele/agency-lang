// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/graphGenerator/startNode.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const initialState: __State = {messages: [], data: {}};
    const finalState = graph.run("{{{startNode}}}", initialState);
}`;

export type TemplateType = {
  startNode: string | boolean | number;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    