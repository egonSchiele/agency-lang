// THIS FILE WAS AUTO-GENERATED
// Source: lib/templates/cli/judgeEvaluate.mustache
// Any manual changes will be lost.
import { apply } from "typestache";

export const template = `import { judge } from "./{{{judgeFilename:string}}}";
import { writeFileSync } from "fs";

async function runJudge() {
  const actualOutput = {{{actualOutput:string}}};
  const expectedOutput = {{{expectedOutput:string}}};
  const judgePrompt = {{{judgePrompt:string}}};

  const result = await judge(actualOutput, expectedOutput, judgePrompt);
  writeFileSync("__judge_evaluate.json", JSON.stringify(result, null, 2));
}

runJudge();
`;

export type TemplateType = {
  judgeFilename: string;
  actualOutput: string;
  expectedOutput: string;
  judgePrompt: string;
};

const render = (args: TemplateType) => {
  return apply(template, args);
}

export default render;
    