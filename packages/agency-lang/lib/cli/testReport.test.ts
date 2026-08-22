import { describe, test, expect } from "vitest";
import {
  buildTestReport,
  fileFailureReport,
  TestReportSchema,
  type TestFileReport,
} from "./testReport.js";

const ran: TestFileReport = {
  file: "a.test.json",
  sourceFile: "a.agency",
  status: "ran",
  cases: [
    { node: "one", status: "passed", durationMs: 3, attempts: 1 },
    { node: "two", status: "failed", feedback: "- 1\n+ 2", durationMs: 4, attempts: 2 },
    { node: "three", status: "skipped", durationMs: 0 },
    { node: "four", status: "aborted", durationMs: 1 },
  ],
};

describe("buildTestReport", () => {
  test("totals come from the cases, a compile-failed file counts its cases as failed", () => {
    const refused = fileFailureReport({
      file: "b.test.json",
      sourceFile: "b.agency",
      status: "compile-failed",
      error: "b.agency imports 'fs', which is not Agency source",
      caseNodes: ["x", "y"],
    });
    const report = buildTestReport([ran, refused]);
    expect(report.version).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(3);
    expect(report.skipped).toBe(1);
    expect(refused.cases.map((c) => c.feedback)).toEqual([refused.error, refused.error]);
  });

  test("the schema round-trips the document and refuses unknown keys", () => {
    const report = buildTestReport([ran]);
    expect(TestReportSchema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
    expect(TestReportSchema.safeParse({ ...report, extra: 1 }).success).toBe(false);
    expect(TestReportSchema.safeParse({ ...report, version: 2 }).success).toBe(false);
  });
});
