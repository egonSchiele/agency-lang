// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/evaluate.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import { {{{nodeName:string}}} } from "./{{{filename:string}}}";
import { writeFileSync } from "fs";

export async function runEvaluation() {
  {{#hasArgs}}
  const result = await {{{nodeName:string}}}({{{args?:string}}});
  {{/hasArgs}}
  {{^hasArgs}}
  const result = await {{{nodeName:string}}}();
  {{/hasArgs}}
  console.log("Evaluation result:", result.data);
  writeFileSync("__evaluate.json", JSON.stringify(result, null, 2));
  return result;
}

runEvaluation();`;

export type TemplateType = {
  nodeName: string;
  filename: string;
  hasArgs: boolean;
  args?: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    