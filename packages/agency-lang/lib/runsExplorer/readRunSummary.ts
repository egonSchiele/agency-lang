// Phase-1 run reading for the cross-run explorer. Exactly two content
// reads per run — summary.json and config.json — so a directory of
// hundreds of runs shows a table in seconds. Everything else (records,
// statelogs, input specs) belongs to backfill. `readEvalRun` in
// lib/eval/readRun.ts stays the full-artifact reader for grading; it
// reads one input.json per input and must not be called here.
import * as fs from "fs";
import * as path from "path";

import type { EvalRunResult } from "../eval/runTypes.js";

/** The pre-run-directory config.json `provenance` block, as old runs on disk
 *  still carry it. Nothing writes this shape any more. */
export type LegacyRunProvenance = {
  inputsSource: { source: string; sha?: string };
  files: Record<string, { source: string; sha?: string }>;
  agent:
    | { entry: string; closure: { file: string; sha256: string }[] }
    | { command: string; harnessVersion: string; cliVersion?: string };
};

export type EvalRunConfig = {
  runId?: string;
  agentLabel?: string;
  startedAt?: string;
  provenance?: LegacyRunProvenance;
};

export type EvalRunPhaseOne = {
  summary: EvalRunResult;
  config: EvalRunConfig | null;
  warnings: string[];
};

export type EvalRunPhaseOneResult =
  { kind: "loaded"; value: EvalRunPhaseOne } | { kind: "failed"; runDir: string; warning: string };

export type ReadFileFn = (filePath: string) => string;

function defaultReadFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

export function readEvalRunPhaseOne(
  runDir: string,
  readFile: ReadFileFn = defaultReadFile,
): EvalRunPhaseOneResult {
  const summaryPath = path.join(runDir, "summary.json");
  const summaryRead = readJsonObject(summaryPath, readFile);
  if (summaryRead.kind === "failed") {
    return { kind: "failed", runDir, warning: summaryRead.warning };
  }

  const configPath = path.join(runDir, "config.json");
  const configRead = readJsonObject(configPath, readFile);
  if (configRead.kind === "failed") {
    return {
      kind: "loaded",
      value: {
        summary: summaryRead.value as EvalRunResult,
        config: null,
        warnings: [configRead.warning],
      },
    };
  }

  return {
    kind: "loaded",
    value: {
      summary: summaryRead.value as EvalRunResult,
      config: configRead.value as EvalRunConfig,
      warnings: [],
    },
  };
}

type JsonObjectRead =
  { kind: "object"; value: Record<string, unknown> } | { kind: "failed"; warning: string };

function readJsonObject(filePath: string, readFile: ReadFileFn): JsonObjectRead {
  let text: string;
  try {
    text = readFile(filePath);
  } catch (error) {
    return { kind: "failed", warning: `could not read ${filePath}: ${errText(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: "failed", warning: `could not parse ${filePath}: ${errText(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "failed", warning: `${filePath} is not a JSON object` };
  }
  return { kind: "object", value: parsed as Record<string, unknown> };
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
