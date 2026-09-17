// Regenerates designTool.test.json. Run from packages/agency-lang:
//   node tests/agency/toolbox/generate-designTool-mocks.mjs
// The mocked drafts embed the good fixture as a string, so run this
// whenever fixtures/tools/good/impl.agency changes; a stale copy fails the
// coding agent's own check and silently spends the round's mocks.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const good = readFileSync(join(here, "fixtures/tools/good/impl.agency"), "utf8");
// The coding agent accepts this module; the assembled tool.agency does not
// typecheck because nothing named `run` is exported.
const wrongExport = good.replace("export def run(", "export def compute(");
// Typechecks on its own, but declares a Request other than the request
// text; only the comparison in assembleTool catches it.
const wrongRequest = good
  .replace("export type Request = {\n  n: number\n}", "export type Request = {\n  text: string\n}")
  .replace("return request.n + 1", "return request.text.length + 1");
const modelImpl = `import { Json } from "std::validation"

export type Request = {
  n: number
}

export def run(request: Request): Json {
  """
  Greet the number using a model.

  @param request - The number to greet
  """
  return llm("Say hello to number \${request.n}")
}
`;
// read raises std::read, so run has an effect without calling a model.
const readImpl = modelImpl
  .replace("Greet the number using a model.", "Read the file named after the number.")
  .replace("The number to greet", "The number naming the file")
  .replace('return llm("Say hello to number ${request.n}")', 'return read("${request.n}.txt")');
// Imports a raw primitive that raises no interrupt. The sandboxed compile
// refuses the import; nothing else in the pipeline would.
const nodeImportImpl = modelImpl
  .replace('import { Json } from "std::validation"', 'import { Json } from "std::validation"\nimport { _which } from "agency-lang/stdlib-lib/shell.js"')
  .replace("Greet the number using a model.", "Find a command on PATH.")
  .replace("The number to greet", "The command to find")
  .replace('return llm("Say hello to number ${request.n}")', 'return _which("${request.n}")');
// Calls today(), so its output is not testable even though it has no effects.
const dateImpl = modelImpl
  .replace('import { Json } from "std::validation"', 'import { Json } from "std::validation"\nimport { today } from "std::date"')
  .replace("Greet the number using a model.", "Stamp the number with the date.")
  .replace("The number to greet", "The number to stamp")
  .replace('return llm("Say hello to number ${request.n}")', 'return "${request.n} on ${today()}"');
// Reaches now() through an import alias.
const aliasImpl = dateImpl
  .replace('import { today } from "std::date"', 'import { now as clock } from "std::date"')
  .replace('return "${request.n} on ${today()}"', 'return "${request.n} at ${clock()}"');
const cases = [
  { request: { n: 41 }, expectedJson: "42" },
  { request: { n: 0 }, expectedJson: "1" },
];
const codeMock = (source) => ({ return: { code: source } });
const reviewOk = { return: [] };
const casesMock = { return: cases };
const testCase = (nodeName, rounds) => ({
  nodeName,
  input: "",
  expectedOutput: "true",
  evaluationCriteria: [{ type: "exact" }],
  useTestLLMProvider: true,
  llmMocks: scopedMocks(rounds),
});
// Per round: coding agent, review agent, then (pure tools only) test cases.
// The review runs before the tool is assembled, so a draft with the wrong
// export still draws the review mock.
//
// The mocks are scoped by module. The test cases come from a generated
// program that runs in its own process under a random module id, so it
// reads the "*" queue, from the start, every time. That is why the other
// two calls need their own queues.
const draftRound = (source, tested) => ({ source, tested });
const pureRound = [draftRound(good, true)];
const modelRound = [draftRound(modelImpl, false)];
const readRound = [draftRound(readImpl, false)];
const wrongRound = [draftRound(wrongExport, false)];
const wrongRequestRound = [draftRound(wrongRequest, false)];
const nodeImportRound = [draftRound(nodeImportImpl, false)];
const dateRound = [draftRound(dateImpl, false)];
const aliasRound = [draftRound(aliasImpl, false)];
const scopedMocks = (rounds) => {
  if (rounds.length === 0) {
    return [];
  }
  const mocks = {
    coding: rounds.map((round) => codeMock(round.source)),
    review: rounds.map(() => reviewOk),
  };
  if (rounds.some((round) => round.tested)) {
    mocks["*"] = [casesMock];
  }
  return mocks;
};
const tests = [
  testCase("acceptSavesTheTool", pureRound),
  testCase("acceptRaisesTheSaveGate", pureRound),
  testCase("rejectAtSaveWritesNothing", pureRound),
  testCase("rejectWritesNothing", pureRound),
  testCase("reviseRunsASecondRound", [...pureRound, ...pureRound]),
  testCase("wrongExportGoesBackToTheCodingAgent", [...wrongRound, ...pureRound]),
  testCase("wrongRequestGoesBackToTheCodingAgent", [...wrongRequestRound, ...pureRound]),
  testCase("refusesAnExistingName", []),
  testCase("refusesALongName", []),
  testCase("refusesAnEmptyDir", []),
  testCase("refusesTheStagingName", []),
  testCase("refusesBadRequestText", []),
  testCase("bareApproveAccepts", pureRound),
  testCase("modelToolSkipsTests", modelRound),
  testCase("effectfulToolSkipsTests", readRound),
  testCase("objectAnswerFails", pureRound),
  testCase("whitespaceFeedbackFails", pureRound),
  testCase("leftoverStagingDoesNotBlock", pureRound),
  testCase("nodeImportGoesBackToTheCodingAgent", [...nodeImportRound, ...pureRound]),
  testCase("dateToolSkipsTests", dateRound),
  testCase("staleTestFileDoesNotShip", [...pureRound, ...modelRound]),
  testCase("runToolRunsAndRecords", pureRound),
  testCase("declinedRecordUseKeepsTheResult", pureRound),
  testCase("symlinkedToolIsRefused", []),
  testCase("refusedWriteStopsTheRounds", pureRound),
  testCase("aliasedDateCallSkipsTests", aliasRound),
  testCase("refusesATimeLimitOverAnHour", []),
  testCase("refusesAnImportInTheRequestText", []),
  testCase("runToolRefusesAnEmptyDir", []),
  testCase("runToolRefusesAMissingTool", []),
  testCase("runToolRefusesAPath", []),
  testCase("runToolRefusesCorruptMeta", []),
];
writeFileSync(join(here, "designTool.test.json"), JSON.stringify({ tests }, null, 2) + "\n");
