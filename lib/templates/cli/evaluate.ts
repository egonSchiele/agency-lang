// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/evaluate.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import { {{{nodeName:string}}} } from "./{{{filename:string}}}";

async function main() {
  const result = await {{{nodeName:string}}}();
  console.log("Evaluation result:", result.data);
}

main();`;

export type TemplateType = {
  nodeName: string;
  filename: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    