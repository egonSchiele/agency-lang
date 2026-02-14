// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/backends/typescriptGenerator/builtinFunctions/read.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `function _builtinRead(filename) {
  const data = fs.readFileSync(filename);
  const contents = data.toString('utf8');
  return contents;
}`;

export type TemplateType = {
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    