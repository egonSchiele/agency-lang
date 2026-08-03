import * as fs from "fs";
import * as path from "path";

import { readEvalRun } from "@/eval/readRun.js";
import type { JsonValue } from "@/utils/canonicalize.js";

import { projectArtifactField } from "../project.js";
import { JsonValueSchema, type Fields } from "../types.js";

import { checkEligibility } from "./eligibility.js";
import type { IngestSkip, IngestSkipReason, LoadedBatch, LoadedOccurrence } from "./types.js";

export type LoadRunArgs = {
  sourceDir: string;
  source: string;
  constantFields: Fields;
  /** False drops the run's own task, so `--no-task-field --task "..."` can
   *  replace it with a constant. */
  includeTaskField: boolean;
  maxBytes: number;
  reportWarning(message: string): void;
};

export type FinalOutputSelection =
  | { kind: "missing" }
  | { kind: "legacy" }
  | { kind: "truncated"; index: number }
  | { kind: "selected"; value: JsonValue; index: number };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Choose the output a label applies to.
 *
 * The index is part of the answer, not an afterthought: it is recorded on the
 * occurrence, so selection and provenance can never disagree about which
 * output was judged.
 */
export function selectLabelingFinalOutput(record: unknown): FinalOutputSelection {
  // A corrupt record can parse to a string, a number or null. Using `in` on one
  // of those throws a TypeError and aborts the whole load instead of skipping
  // the single input that is broken.
  if (!isPlainObject(record)) {
    return { kind: "missing" };
  }
  const outputs = record.evalOutputs;
  if (!Array.isArray(outputs)) {
    // The legacy single-field shape cannot say which output was final, and
    // inventing a nullable index would weaken the provenance derived from it.
    return "finalResponse" in record ? { kind: "legacy" } : { kind: "missing" };
  }
  if (outputs.length === 0) {
    return { kind: "missing" };
  }
  const index = outputs.length - 1;
  const entry = outputs[index];
  if (!isPlainObject(entry)) {
    return { kind: "missing" };
  }
  if (entry.truncated === true) {
    return { kind: "truncated", index };
  }
  // An ABSENT value is not the value `null`. Coalescing the two would let a
  // malformed entry be captured and durably labelled as though the agent had
  // deliberately returned JSON null.
  if (!Object.hasOwn(entry, "value")) {
    return { kind: "missing" };
  }
  const parsed = JsonValueSchema.safeParse(entry.value);
  if (!parsed.success) {
    return { kind: "missing" };
  }
  return { kind: "selected", value: parsed.data, index };
}

function skipReasonFor(selection: FinalOutputSelection): IngestSkipReason {
  if (selection.kind === "truncated") {
    return "truncated-output";
  }
  if (selection.kind === "legacy") {
    return "legacy-record";
  }
  return "no-output";
}

/**
 * Every labellable output from an eval run.
 *
 * Eligibility is deliberately narrow, and every rejection is reported rather
 * than silently dropped: a placeholder in the corpus is worse than a gap,
 * because a placeholder can be labelled.
 */
export function loadRun(args: LoadRunArgs): LoadedBatch {
  const run = readEvalRun(args.sourceDir, args.reportWarning);
  const agent = readAgentProvenance(args.sourceDir);

  const occurrences: LoadedOccurrence[] = [];
  const skips: IngestSkip[] = [];
  const fieldNames: Record<string, true> = Object.create(null);

  for (const inputId of Object.keys(run.inputsById)) {
    const entry = run.inputsById[inputId];
    if (entry.status !== "ok") {
      skips.push({
        item: inputId,
        reason: entry.status === "failed" ? "run-failed" : "record-unreadable",
      });
      continue;
    }

    const record = readRecord(entry.recordPath);
    if (record === undefined) {
      skips.push({ item: inputId, reason: "record-unreadable" });
      continue;
    }

    const traceId = typeof record.traceId === "string" && record.traceId.length > 0
      ? record.traceId
      : undefined;
    if (traceId === undefined) {
      skips.push({ item: inputId, reason: "missing-trace-id" });
      continue;
    }

    const task = JsonValueSchema.safeParse(entry.input?.task);
    if (!task.success || task.data === undefined || task.data === null) {
      skips.push({ item: inputId, reason: "invalid-task" });
      continue;
    }

    const selection = selectLabelingFinalOutput(record);
    if (selection.kind !== "selected") {
      skips.push({ item: inputId, reason: skipReasonFor(selection) });
      continue;
    }

    const output = projectArtifactField(selection.value);
    const ineligible = checkEligibility(output, { maxBytes: args.maxBytes });
    if (ineligible !== undefined) {
      skips.push({ item: inputId, reason: ineligible });
      continue;
    }

    const fields: Fields = args.includeTaskField
      ? { task: projectArtifactField(task.data), ...args.constantFields, output }
      : { ...args.constantFields, output };
    for (const name of Object.keys(fields)) {
      fieldNames[name] = true;
    }

    occurrences.push({
      fields,
      source: args.source,
      origin: {
        kind: "run",
        traceId,
        inputId,
        finalOutputIndex: selection.index,
        runStartedAtMs: typeof record.startedAtMs === "number" ? record.startedAtMs : null,
        models: Array.isArray(record?.metrics?.models) ? record.metrics.models : [],
        agent,
        // The pre-projection task and output. Provenance, so a structured
        // output stays reconstructable even though the record holds its
        // rendering.
        rawTask: task.data,
        rawValue: selection.value,
      },
    });
  }

  return { occurrences, skips, discoveredFieldNames: Object.keys(fieldNames) };
}

function readRecord(recordPath: string | undefined): any | undefined {
  if (recordPath === undefined || !fs.existsSync(recordPath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch {
    return undefined;
  }
}

/** `config.json`'s `provenance.agent` carries file hashes; `agentLabel` is
 *  documented as a display label, so it is not what reproduction needs. */
function readAgentProvenance(sourceDir: string): JsonValue {
  const file = path.join(path.resolve(sourceDir), "config.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const parsed = JsonValueSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (
      !parsed.success || parsed.data === null || typeof parsed.data !== "object" ||
      Array.isArray(parsed.data)
    ) {
      return null;
    }
    const provenance = parsed.data.provenance;
    if (
      provenance === null || provenance === undefined || typeof provenance !== "object" ||
      Array.isArray(provenance)
    ) {
      return null;
    }
    return provenance.agent ?? null;
  } catch {
    return null;
  }
}
