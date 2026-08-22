/** The result of one `agency test` run: every file and case. Printed as the
 *  `--json` document (`version` bumps on an incompatible change); the
 *  summary and exit code derive from it. */
import { z } from "zod";

export const TEST_REPORT_VERSION = 1;

export const TestCaseReportSchema = z.strictObject({
  node: z.string(),
  description: z.string().optional(),
  input: z.string().optional(),
  status: z.enum(["passed", "failed", "skipped", "aborted"]),
  /** On `failed`: the same text the human output prints. */
  feedback: z.string().optional(),
  durationMs: z.number(),
  /** How many attempts ran (1 + retries); the feedback is the last one's. */
  attempts: z.number().optional(),
});

export const TestFileReportSchema = z.strictObject({
  /** The .test.json path as the runner was given it. */
  file: z.string(),
  sourceFile: z.string(),
  /** `compile-failed` and `error` carry `error`; `aborted` files may have
   *  cases that ran before the abort. */
  status: z.enum(["ran", "compile-failed", "error", "skipped", "aborted"]),
  error: z.string().optional(),
  cases: z.array(TestCaseReportSchema),
});

export const TestReportSchema = z.strictObject({
  version: z.literal(TEST_REPORT_VERSION),
  files: z.array(TestFileReportSchema),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  /** See `fileFailed`. Non-zero fails the command even when `failed` is 0. */
  filesFailed: z.number(),
});

export type TestCaseReport = z.infer<typeof TestCaseReportSchema>;
export type TestFileReport = z.infer<typeof TestFileReportSchema>;
export type TestReport = z.infer<typeof TestReportSchema>;

/** A file fails when it did not run to the end or any case failed. */
export function fileFailed(file: TestFileReport): boolean {
  return (
    file.status === "compile-failed" ||
    file.status === "error" ||
    file.status === "aborted" ||
    file.cases.some((c) => c.status === "failed")
  );
}

export function failedFiles(report: TestReport): string[] {
  return report.files.filter(fileFailed).map((f) => f.file);
}

/** Every case that ran, with its duration, named the way the summary prints it. */
export function caseTimings(report: TestReport): { name: string; durationMs: number }[] {
  const timings: { name: string; durationMs: number }[] = [];
  for (const file of report.files) {
    for (const c of file.cases) {
      if (c.status !== "passed" && c.status !== "failed") continue;
      const name = c.description
        ? `${file.file} > ${c.node} > ${c.description}`
        : `${file.file} > ${c.node}(${c.input ?? ""})`;
      timings.push({ name, durationMs: c.durationMs });
    }
  }
  return timings;
}

export function buildTestReport(files: TestFileReport[]): TestReport {
  const cases = files.flatMap((f) => f.cases);
  const count = (status: TestCaseReport["status"]) =>
    cases.filter((c) => c.status === status).length;
  return {
    version: TEST_REPORT_VERSION,
    files,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    filesFailed: files.filter(fileFailed).length,
  };
}

/** A file that never ran its cases: each declared case is reported failed
 *  with the file's error, so a consumer counting cases sees the denominator. */
export function fileFailureReport(args: {
  file: string;
  sourceFile: string;
  status: "compile-failed" | "error";
  error: string;
  caseNodes: string[];
}): TestFileReport {
  return {
    file: args.file,
    sourceFile: args.sourceFile,
    status: args.status,
    error: args.error,
    cases: args.caseNodes.map((node) => ({
      node,
      status: "failed",
      feedback: args.error,
      durationMs: 0,
    })),
  };
}
