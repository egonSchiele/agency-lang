// Regenerates writeTool.test.json. Run from packages/agency-lang:
//   node tests/agency/toolbox/generate-writeTool-mocks.mjs
// The mocked drafts embed the good fixture as a string, so run this
// whenever fixtures/tools/good/tool.agency changes; a stale copy fails the
// coding agent's own check and silently spends the round's mocks.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const good = readFileSync(join(here, "fixtures/tools/good/tool.agency"), "utf8");
// The coding agent accepts this; checkToolShape refuses the extra export.
const bad = good + "\nexport def helper(): number {\n  return 1\n}\n";
const modelTool = `/** @module
  @summary Greet a person by name using a model.
*/

export type Request = {
  name: string
}

export def tool(request: Request): Result<string> {
  """
  Greet the person by name using a model.

  Example: tool({ name: "Ada" })

  @param request - Who to greet
  """
  return guard(time: 1m, cost: $0.10) {
    return llm("Say hello to \${request.name}")

    finalize {
      return ""
    }
  }
}

export node main(request: Request): Result<string> {
  return tool(request)
}
`;
// Imports a module outside PURE_IMPORTS, so it is impure without calling llm.
const shellTool = modelTool
  .replace("/** @module", 'import { which } from "std::shell"\n\n/** @module')
  .replace("Greet a person by name using a model.", "Find a command on PATH.")
  .replace("Greet the person by name using a model.", "Find the command named in the request on PATH.")
  .replace("Who to greet", "The command to find")
  .replace('return llm("Say hello to ${request.name}")', "return which(request.name)");
const cases = {
  cases: [
    { nodeName: "main", args: { request: { n: 41 } }, expectedOutput: 42 },
    { nodeName: "main", args: { request: { n: 0 } }, expectedOutput: 1 },
  ],
};
const codeMock = (source) => ({ return: { code: source } });
const reviewOk = { return: [] };
const casesMock = { return: cases };
const testCase = (nodeName, llmMocks) => ({
  nodeName,
  input: "",
  expectedOutput: "true",
  evaluationCriteria: [{ type: "exact" }],
  useTestLLMProvider: true,
  llmMocks,
});
// Per round: coding agent, review agent, then (pure tools only) test cases.
const pureRound = [codeMock(good), reviewOk, casesMock];
const modelRound = [codeMock(modelTool), reviewOk];
const shellRound = [codeMock(shellTool), reviewOk];
const tests = [
  testCase("acceptSavesThreeFiles", pureRound),
  testCase("rejectWritesNothing", pureRound),
  testCase("reviseRunsASecondRound", [...pureRound, ...pureRound]),
  testCase("badShapeGoesBackToTheCodingAgent", [codeMock(bad), ...pureRound]),
  testCase("refusesAnExistingName", []),
  testCase("refusesALongName", []),
  testCase("refusesAnEmptyDir", []),
  testCase("refusesTheStagingName", []),
  testCase("bareApproveAccepts", pureRound),
  testCase("modelToolSkipsTests", modelRound),
  testCase("impureImportSkipsTests", shellRound),
  testCase("reviseWithoutFeedbackFails", pureRound),
  testCase("staleTestFileDoesNotShip", [...pureRound, ...modelRound]),
];
writeFileSync(join(here, "writeTool.test.json"), JSON.stringify({ tests }, null, 2) + "\n");
