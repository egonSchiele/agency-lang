// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/judgePairwiseEvaluate.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import { judgePairwise } from "./{{{judgeFilename:string}}}";
import { writeFileSync } from "fs";

async function runJudge() {
  const goal = {{{goal:string}}};
  const responseA = {{{responseA:string}}};
  const responseB = {{{responseB:string}}};

  const result = await judgePairwise(goal, responseA, responseB);

  writeFileSync("{{{resultsFilename:string}}}", JSON.stringify(result, null, 2));
}

runJudge();
`;

export type TemplateType = {
  judgeFilename: string;
  goal: string;
  responseA: string;
  responseB: string;
  resultsFilename: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    