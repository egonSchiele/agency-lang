import * as fs from "fs";

import { extractEvalRecord } from "@/eval/extract.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";
import type { JsonValue } from "@/utils/canonicalize.js";

import { JsonValueSchema, OccurrenceOriginSchema, type Fields } from "../types.js";

import { projectOccurrenceFields, skipReasonFor } from "./occurrence.js";
import { selectLabelingFinalOutput } from "./run.js";
import { describeAvailableTraces, scanStatelog } from "./statelogScan.js";
import {
  IngestSourceError,
  type IngestSkip,
  type IngestSkipReason,
  type LoadedBatch,
  type LoadedOccurrence,
} from "./types.js";

/** A trace resolved to its labelable output and default task. Once extracted, a
 *  statelog trace is just a `{ task, output }` example — the same shape a run
 *  produces — so the output is resolved by the same helper runs use. */
export type ResolvedTrace = {
  output: JsonValue;
  /** Index of the chosen output among the trace's recorded outputs, so two
   *  `evalOutput()` values from one trace stay distinct observations. */
  finalOutputIndex: number;
  taskDefault: JsonValue | null;
};

export type TraceResolution =
  { kind: "resolved"; trace: ResolvedTrace } | { kind: "rejected"; reason: IngestSkipReason };

export type TaskChoice =
  { kind: "keep-default" } | { kind: "replace"; value: JsonValue } | { kind: "omit" };

export type ProjectionContext = {
  source: string;
  constantFields: Fields;
  maxBytes: number;
};

export type ProjectionResult =
  { kind: "accepted"; occurrence: LoadedOccurrence } | { kind: "skipped"; skip: IngestSkip };

/**
 * Extract one trace and choose its output: an `evalOutput()` value, else the
 * entry node's return value (via the same selection helper runs use). A
 * truncated or absent output is rejected — the last chat message is never a
 * stand-in. A trace that crashed or never finished is rejected too, so a
 * labelled output always comes from a successful run, exactly as
 * run-directory ingestion refuses a `failed` input. Pure: no prompting, no
 * writes.
 */
export function resolveTrace(
  events: readonly EventEnvelope[],
  sourcePath: string,
): TraceResolution {
  const outcome = terminalOutcome(events);
  if (outcome !== "ok") {
    return { kind: "rejected", reason: outcome === "failed" ? "run-failed" : "trace-unfinished" };
  }
  const record = extractEvalRecord(events as EventEnvelope[], sourcePath);
  const selection = selectLabelingFinalOutput(record);
  if (selection.kind !== "selected") {
    return { kind: "rejected", reason: skipReasonFor(selection) };
  }
  return {
    kind: "resolved",
    trace: {
      output: selection.value,
      finalOutputIndex: selection.index,
      taskDefault: taskDefaultFrom(record),
    },
  };
}

type TerminalOutcome = "ok" | "failed" | "unfinished";

/**
 * How a trace ended, read from raw events to mirror the eval runner's ok/failed
 * decision. On an unhandled failure the runtime emits a `runtimeError` and then
 * a result-less `agentEnd`; a clean run reaches an `agentEnd` carrying a
 * `result`. A run that ends via `evalOutput()` alone also has a result-less
 * `agentEnd`, so a result-less end is a crash only when a terminal
 * `runtimeError` is present — transient `llmError`/`toolError` are retried or
 * handled and a completed run can carry them. No `agentEnd` at all means the
 * trace was interrupted or killed before its footer: unfinished.
 */
function terminalOutcome(events: readonly EventEnvelope[]): TerminalOutcome {
  const ends = events.filter((e) => e.data.type === "agentEnd");
  const last = ends.at(-1);
  if (last === undefined) {
    return "unfinished";
  }
  if (last.data.result !== undefined && last.data.result !== null) {
    return "ok";
  }
  const crashed = events.some(
    (e) => e.data.type === "error" && e.data.errorType === "runtimeError",
  );
  return crashed ? "failed" : "ok";
}

/** Project a resolved trace and a task decision into a durable occurrence, or a
 *  skip when the output is ineligible. Pure. */
export function projectTrace(
  traceId: string,
  resolved: ResolvedTrace,
  taskChoice: TaskChoice,
  context: ProjectionContext,
): ProjectionResult {
  const projected = projectOccurrenceFields({
    taskValue: taskValueFor(taskChoice, resolved.taskDefault),
    outputValue: resolved.output,
    constantFields: context.constantFields,
    maxBytes: context.maxBytes,
  });
  if ("skipReason" in projected) {
    return { kind: "skipped", skip: { item: traceId, reason: projected.skipReason } };
  }
  const origin = OccurrenceOriginSchema.parse({
    kind: "statelog",
    traceId,
    finalOutputIndex: resolved.finalOutputIndex,
  });
  return {
    kind: "accepted",
    occurrence: { fields: projected.fields, source: context.source, origin },
  };
}

function taskValueFor(taskChoice: TaskChoice, taskDefault: JsonValue | null): JsonValue | null {
  if (taskChoice.kind === "omit") {
    return null;
  }
  if (taskChoice.kind === "replace") {
    return taskChoice.value;
  }
  return taskDefault;
}

/** The last recorded eval value, validated as JSON. Absent or malformed becomes
 *  null; a structured value is left structured until it is projected. */
function taskDefaultFrom(record: { evalValues?: readonly { value: unknown }[] }): JsonValue | null {
  const values = record.evalValues ?? [];
  const last = values.at(-1);
  if (last === undefined) {
    return null;
  }
  const parsed = JsonValueSchema.safeParse(last.value);
  return parsed.success ? parsed.data : null;
}

/**
 * Load one or more chosen traces from a statelog into a batch. Synchronous:
 * the scan happens once, and every requested id is validated before any
 * projection so a typo names the available traces instead of silently
 * promoting a subset.
 */
export function loadStatelog(args: {
  path: string;
  traceIds: readonly string[];
  source: string;
  constantFields: Fields;
  includeTaskField: boolean;
  maxBytes: number;
}): LoadedBatch {
  const scan = scanStatelog(fs.readFileSync(args.path, "utf8"));

  if (args.traceIds.length === 0) {
    throw new IngestSourceError(
      `A statelog source needs at least one --trace <id>.\n${describeAvailableTraces(scan)}`,
    );
  }
  for (const traceId of args.traceIds) {
    if (!(traceId in scan.eventsByTrace)) {
      throw new IngestSourceError(
        `Trace "${traceId}" is not in ${args.path}.\n${describeAvailableTraces(scan)}`,
      );
    }
  }

  const occurrences: LoadedOccurrence[] = [];
  const skips: IngestSkip[] = [];
  const taskChoice: TaskChoice = args.includeTaskField
    ? { kind: "keep-default" }
    : { kind: "omit" };

  for (const traceId of args.traceIds) {
    const resolution = resolveTrace(scan.eventsByTrace[traceId], args.path);
    if (resolution.kind === "rejected") {
      skips.push({ item: traceId, reason: resolution.reason });
      continue;
    }
    const projected = projectTrace(traceId, resolution.trace, taskChoice, {
      source: args.source,
      constantFields: args.constantFields,
      maxBytes: args.maxBytes,
    });
    if (projected.kind === "skipped") {
      skips.push(projected.skip);
    } else {
      occurrences.push(projected.occurrence);
    }
  }
  return { occurrences, skips };
}
