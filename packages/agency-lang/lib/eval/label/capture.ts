import * as fs from "fs";
import * as path from "path";

import { readEvalRun } from "@/eval/readRun.js";
import type { JsonValue } from "@/utils/canonicalize.js";

import { contentHashOf, makeOutputId } from "./ids.js";
import type { OpenedJsonl } from "./jsonl.js";
import {
  CorpusRowSchema,
  JsonValueSchema,
  type CorpusRow,
  type ExecutionIdentity,
} from "./types.js";

/** Why an input could not be labelled. A code rather than prose so callers can
 *  branch on it and tests can assert it exactly; `describeCaptureSkip` renders
 *  the sentence a person reads. */
export type CaptureSkipReason =
  | "run-failed"
  | "record-unreadable"
  | "legacy-record"
  | "missing-trace-id"
  | "invalid-task"
  | "no-output"
  | "truncated-output";

export type CaptureSkip = { inputId: string; reason: CaptureSkipReason };

export type FinalOutputSelection =
  | { kind: "missing" }
  | { kind: "legacy" }
  | { kind: "truncated"; index: number }
  | { kind: "selected"; value: JsonValue; text: string; index: number };

export type CaptureResult = {
  /** Every labellable output in source order, replayed and new alike. */
  rows: CorpusRow[];
  newlyCaptured: CorpusRow[];
  skipped: CaptureSkip[];
};

export type CaptureSourceArgs = {
  sourceDir: string;
  corpus: OpenedJsonl<CorpusRow>;
  reportWarning(message: string): void;
};

const SKIP_DESCRIPTIONS: Record<CaptureSkipReason, string> = {
  "run-failed":
    "the run failed. A failed run's salvaged record is evidence for diagnosis, not a result to judge.",
  "record-unreadable":
    "no readable eval record for this input.",
  "legacy-record":
    "the record predates recorded eval outputs. Recapture the run; there is no way to say which output was final.",
  "missing-trace-id":
    "the record has no trace id, so this output has no stable identity across recapture.",
  "invalid-task":
    "the input's task is missing or is not JSON data.",
  "no-output":
    "no output was recorded, so there is nothing to judge. Filesystem-oriented runs legitimately have none.",
  "truncated-output":
    "the recorded output is truncated, and a label on a truncation is not a judgement of the output. " +
    "Recapture with a larger STATELOG_EVAL_MAX_VALUE_BYTES.",
};

export function describeCaptureSkip(skip: CaptureSkip): string {
  return `${skip.inputId}: ${SKIP_DESCRIPTIONS[skip.reason]}`;
}

/**
 * Choose the output a label applies to.
 *
 * The index is part of the answer, not an afterthought: it is one third of the
 * occurrence identity, so selection and identity can never disagree about
 * which output was judged. The projection matches
 * `lib/eval/judge/selectFinalResponse.ts` — strings pass through, everything
 * else is JSON — because `String(value)` renders an object as
 * "[object Object]" and merges unrelated structured outputs into one
 * meaningless string.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function selectLabelingFinalOutput(record: unknown): FinalOutputSelection {
  // A corrupt record can parse to a string, a number or null. Using `in` on
  // one of those throws a TypeError and aborts the whole capture instead of
  // skipping the single input that is broken.
  if (!isPlainObject(record)) {
    return { kind: "missing" };
  }
  const outputs = record.evalOutputs;
  if (!Array.isArray(outputs)) {
    // The legacy single-field shape cannot say which output was final, and
    // inventing a nullable index would weaken every identity derived from it.
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
  return { kind: "selected", value: parsed.data, text: projectText(parsed.data), index };
}

function projectText(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Copy every labellable output from a source run into the corpus.
 *
 * Eligibility is deliberately narrow, and every rejection is reported rather
 * than silently dropped: a placeholder in the corpus is worse than a gap,
 * because a placeholder can be labelled.
 */
export function captureSourceOccurrences(args: CaptureSourceArgs): CaptureResult {
  const run = readEvalRun(args.sourceDir, args.reportWarning);
  const existingById: Record<string, CorpusRow> = Object.create(null);
  for (const row of args.corpus.rows()) {
    existingById[row.outputId] = row as CorpusRow;
  }

  const rows: CorpusRow[] = [];
  const newlyCaptured: CorpusRow[] = [];
  const skipped: CaptureSkip[] = [];

  for (const inputId of Object.keys(run.inputsById)) {
    const entry = run.inputsById[inputId];
    if (entry.status !== "ok") {
      skipped.push({ inputId, reason: entry.status === "failed" ? "run-failed" : "record-unreadable" });
      continue;
    }

    const record = readRecord(entry.recordPath);
    if (record === undefined) {
      skipped.push({ inputId, reason: "record-unreadable" });
      continue;
    }
    const traceId = typeof record.traceId === "string" && record.traceId.length > 0
      ? record.traceId
      : undefined;
    if (traceId === undefined) {
      skipped.push({ inputId, reason: "missing-trace-id" });
      continue;
    }
    const task = JsonValueSchema.safeParse(entry.input?.task);
    if (!task.success || task.data === undefined || task.data === null) {
      skipped.push({ inputId, reason: "invalid-task" });
      continue;
    }

    const selection = selectLabelingFinalOutput(record);
    if (selection.kind !== "selected") {
      skipped.push({ inputId, reason: skipReasonFor(selection) });
      continue;
    }

    const execution: ExecutionIdentity = { traceId, inputId, finalOutputIndex: selection.index };
    const outputId = makeOutputId(execution);
    const contentHash = contentHashOf({ inputId, task: task.data }, selection.value);
    const existing = existingById[outputId];
    if (existing !== undefined) {
      assertSameOccurrence(existing, { outputId, contentHash, execution, text: selection.text });
      rows.push(existing);
      continue;
    }

    const row = CorpusRowSchema.parse({
      schemaVersion: 1,
      outputId,
      contentHash,
      capturedAt: new Date().toISOString(),
      execution,
      input: { inputId, task: task.data },
      value: selection.value,
      text: selection.text,
      provenance: {
        runStartedAtMs: typeof record.startedAtMs === "number" ? record.startedAtMs : null,
        agent: readAgentProvenance(args.sourceDir),
        models: Array.isArray(record?.metrics?.models) ? record.metrics.models : [],
      },
    });

    // Appending here is what makes reuse-with-different-content a hard error:
    // the log compares canonical content for an identity it already holds.
    args.corpus.appendExact(row);
    existingById[outputId] = row;
    rows.push(row);
    newlyCaptured.push(row);
  }

  return { rows, newlyCaptured, skipped };
}

/**
 * An output id is a promise that this is the same output as last time. If the
 * content has changed underneath it, something has gone wrong that silently
 * relabelling would hide — a rewritten record, a reused trace id, an edited
 * run. Refuse rather than let existing labels drift onto different text.
 *
 * `capturedAt` and provenance are excluded: they can legitimately differ
 * between two captures of the same execution without changing what was judged.
 */
function assertSameOccurrence(
  existing: CorpusRow,
  candidate: { outputId: string; contentHash: string; execution: ExecutionIdentity; text: string },
): void {
  const differences: string[] = [];
  if (existing.contentHash !== candidate.contentHash) {
    differences.push("content");
  }
  if (existing.text !== candidate.text) {
    differences.push("display text");
  }
  if (
    existing.execution.traceId !== candidate.execution.traceId ||
    existing.execution.inputId !== candidate.execution.inputId ||
    existing.execution.finalOutputIndex !== candidate.execution.finalOutputIndex
  ) {
    differences.push("execution identity");
  }
  if (differences.length === 0) {
    return;
  }
  throw new Error(
    `Output "${candidate.outputId}" is already in the corpus with different ` +
    `${differences.join(" and ")}. The same execution must always produce the same ` +
    `output; existing labels refer to what was captured first.`,
  );
}

function skipReasonFor(selection: FinalOutputSelection): CaptureSkipReason {
  if (selection.kind === "truncated") {
    return "truncated-output";
  }
  if (selection.kind === "legacy") {
    return "legacy-record";
  }
  return "no-output";
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
    if (!parsed.success || parsed.data === null || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
      return null;
    }
    const provenance = parsed.data.provenance;
    if (provenance === null || provenance === undefined || typeof provenance !== "object" || Array.isArray(provenance)) {
      return null;
    }
    return provenance.agent ?? null;
  } catch {
    return null;
  }
}
