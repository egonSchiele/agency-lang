import { _compileFile, resolveInSandbox } from "./agency.js";
import { buildTestReport, fileFailureReport } from "../cli/testReport.js";

/** Compilation only returns bytes. Agency writes each file through std::write. */
export function _compileFileOutputs(dir: string, filename: string) {
  if (!filename.endsWith(".agency")) {
    throw new Error("compile requires an .agency source file");
  }
  resolveInSandbox(dir, filename);
  const program = _compileFile(dir, filename, true);
  const files = {
    ...program.modules,
    [program.entryPath ?? filename.replace(/\.agency$/, ".js")]: program.code,
  };
  return Object.entries(files).map(([filename, code]) => ({ filename, code }));
}

/** Use the CLI's report schema and counters for the sandbox runner's results. */
export function _testReportJson(
  file: string,
  report: {
    sourceFile: string;
    cases: { node: string; pass: boolean; feedback: string; durationMs: number }[];
  },
): string {
  return (
    JSON.stringify(
      buildTestReport([
        {
          file,
          sourceFile: report.sourceFile,
          status: "ran",
          cases: report.cases.map((item) => ({
            node: item.node,
            status: item.pass ? "passed" : "failed",
            ...(item.pass ? {} : { feedback: item.feedback }),
            durationMs: item.durationMs,
          })),
        },
      ]),
    ) + "\n"
  );
}

/** Preserve the declared case count when compilation prevented execution. */
export function _testCompileFailureJson(
  file: string,
  error: string,
  data: { sourceFile: string; cases: { node: string }[] },
): string {
  return (
    JSON.stringify(
      buildTestReport([
        fileFailureReport({
          file,
          sourceFile: data.sourceFile,
          status: "compile-failed",
          error,
          caseNodes: data.cases.map((item) => item.node),
        }),
      ]),
    ) + "\n"
  );
}
