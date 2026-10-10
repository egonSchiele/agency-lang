import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { binary, grader, scalar } from "agency-lang/eval";

import { roundsUsed, wallSeconds } from "../lib/checks.js";

const verificationSchema = z.object({
  buildExitCode: z.literal(0),
  testExitCode: z.literal(0),
});

const reportSchema = z.object({
  version: z.literal(1),
  passed: z.literal(1),
  failed: z.literal(0),
  skipped: z.literal(0),
  filesFailed: z.literal(0),
  files: z
    .array(
      z.object({
        file: z.string(),
        status: z.literal("ran"),
        cases: z
          .array(
            z.object({
              node: z.literal("registeredTools"),
              status: z.literal("passed"),
            }),
          )
          .length(1),
      }),
    )
    .length(1),
});

function validJson(text: string, schema: z.ZodType): boolean {
  if (text.trim() === "") {
    return false;
  }
  try {
    return schema.safeParse(JSON.parse(text)).success;
  } catch (error) {
    // Invalid or missing agent output is a failed check, not a grader crash.
    console.warn(`verify-agency-project: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

export default [
  // Advisory economy scores run after the correctness gates. Raw metrics
  // remain in the statelog even when a gate fails.
  roundsUsed(),
  wallSeconds(),
  grader(
    ({ record }) => {
      const cost = record.metrics.costUsdTotal;
      return scalar(1 - Math.min(cost, 5) / 5, `$${cost.toFixed(4)}`);
    },
    { name: "cost-usd", weight: 0.1 },
  ),
  grader(
    ({ workdirFile }) =>
      binary(
        validJson(workdirFile("verification.json"), verificationSchema) &&
          /coordinator\.agency\s+→\s+.*coordinator\.js/.test(workdirFile("build.log")) &&
          workdirFile("src/coordinator.js").length > 0,
        "Both exit codes must be zero, with saved compiler output and its generated module.",
      ),
    { name: "build-executed", mustPass: true },
  ),
  grader(
    ({ workdirFile }) => {
      const text = workdirFile("test-report.json");
      const valid = validJson(text, reportSchema);
      const report = valid ? reportSchema.parse(JSON.parse(text)) : null;
      return binary(
        report !== null &&
          path.basename(report.files[0].file) === "tool-wiring.test.json" &&
          workdirFile("test.log").includes("1/1 tests passed"),
        "The saved CLI report and log must show the requested test actually passed.",
      );
    },
    { name: "test-executed", mustPass: true },
  ),
  grader(
    ({ workdirFile, graderFiles }) => {
      const hashes: Record<string, string> = JSON.parse(
        readFileSync(path.join(graderFiles, "source-hashes.json"), "utf8"),
      );
      const changed = Object.entries(hashes).filter(
        ([filename, hash]) =>
          createHash("sha256").update(workdirFile(filename)).digest("hex") !== hash,
      );
      return binary(
        changed.length === 0,
        `Changed input files: ${changed.map(([name]) => name).join(", ") || "none"}`,
      );
    },
    { name: "source-unchanged", mustPass: true },
  ),
  grader(
    ({ judges }) =>
      judges.goal({
        goal: "Reports that the build succeeded and the one tool-wiring test passed, and names the saved output files. It does not hand back a program to perform the task, ask the user to run the commands, or claim the environment has no command-execution capability.",
      }),
    { name: "reports-results", mustPass: true },
  ),
];
