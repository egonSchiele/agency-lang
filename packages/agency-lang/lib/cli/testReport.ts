/**
 * The machine-readable result of `agency test --json`: one document on
 * stdout, versioned, validated by the consumers that parse it (the eval
 * grader). Field names are a public contract; `version` bumps on any
 * incompatible change.
 */
import { z } from "zod";

export const TEST_REPORT_VERSION = 1;

export const TestCaseReportSchema = z.strictObject({
  node: z.string(),
  description: z.string().optional(),
  input: z.string().optional(),
  status: z.enum(["passed", "failed", "skipped", "aborted"]),
  /** Present on `failed`: the same text the human output prints (the
   *  exact-match diff, the judge's reasoning, the execution error, the
   *  interrupt mismatch). */
  feedback: z.string().optional(),
  durationMs: z.number(),
  /** How many attempts ran (1 + retries); the feedback is the last one's. */
  attempts: z.number().optional(),
});

export const TestFileReportSchema = z.strictObject({
  /** The .test.json path as the runner was given it. */
  file: z.string(),
  sourceFile: z.string(),
  /** `ran`: cases executed. `compile-failed`: the source did not compile or
   *  was refused (`error` says why); every case is listed as failed. `error`:
   *  the runner itself failed on this file (`error` says why). `skipped`:
   *  file-level skip. `aborted`: the suite abort reached it. */
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
  /** Files that did not run (`compile-failed`, `error`) plus files with a
   *  failed case. Non-zero means the command exited 1, even when `failed`
   *  is 0 (a refused file that declared no cases). */
  filesFailed: z.number(),
});

export type TestCaseReport = z.infer<typeof TestCaseReportSchema>;
export type TestFileReport = z.infer<typeof TestFileReportSchema>;
export type TestReport = z.infer<typeof TestReportSchema>;

/** Totals are derived from the cases, never counted separately. */
export function buildTestReport(files: TestFileReport[]): TestReport {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let filesFailed = 0;
  for (const file of files) {
    let fileFailed = file.status === "compile-failed" || file.status === "error";
    for (const testCase of file.cases) {
      if (testCase.status === "passed") passed++;
      else if (testCase.status === "failed") {
        failed++;
        fileFailed = true;
      } else if (testCase.status === "skipped") skipped++;
    }
    if (fileFailed) filesFailed++;
  }
  return { version: TEST_REPORT_VERSION, files, passed, failed, skipped, filesFailed };
}

/** A file that never ran its cases (compile refusal, runner error): every
 *  declared case is reported failed with the file's error as feedback, so a
 *  consumer counting cases sees the right denominator. */
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
