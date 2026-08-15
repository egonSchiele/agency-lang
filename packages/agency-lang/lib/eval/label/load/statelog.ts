import { extractEvalRecord } from "@/eval/extract.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";
import type { JsonValue } from "@/utils/canonicalize.js";

import { projectArtifactField } from "../project.js";
import {
  JsonValueSchema,
  OccurrenceOriginSchema,
  type Fields,
  type StatelogOutputSource,
} from "../types.js";

import { checkEligibility } from "./eligibility.js";
import { selectLabelingFinalOutput } from "./run.js";
import type { IngestSkip, IngestSkipReason, LoadedOccurrence } from "./types.js";

/** One printed value a trace offers as a candidate output. `index` is the
 *  0-based ordinal among ALL of the trace's print events, so it stays stable
 *  whether or not earlier prints were dropped for being truncated. */
export type PrintCandidate = {
  index: number;
  value: string;
};

export type ResolvedOutputSelection = {
  source: StatelogOutputSource;
  output: JsonValue;
};

export type ResolvedTrace = {
  selection: ResolvedOutputSelection;
  taskDefault: JsonValue | null;
};

/** The outcome of resolving one trace's output, before any surface picks among
 *  ambiguous prints. Pure: no prompting, no writes. */
export type TraceResolution =
  | { kind: "resolved"; trace: ResolvedTrace }
  | { kind: "needs-selection"; candidates: readonly PrintCandidate[]; taskDefault: JsonValue | null }
  | { kind: "rejected"; reason: IngestSkipReason };

/** What the caller decided to do with the task field once it saw the default. */
export type TaskChoice =
  | { kind: "keep-default" }
  | { kind: "replace"; value: JsonValue }
  | { kind: "omit" };

export type ProjectionContext = {
  source: string;
  constantFields: Fields;
  maxBytes: number;
};

export type ProjectionResult =
  | { kind: "accepted"; occurrence: LoadedOccurrence }
  | { kind: "skipped"; skip: IngestSkip };

/**
 * Decide what output (and default task) a single trace offers, following a
 * strict precedence:
 *
 *   1. explicit evalOutput()      -> evalOutput, at the last explicit index
 *   2. entry-node return value    -> return
 *   3. a truncated explicit output-> rejected (never falls through to prints)
 *   4. no output, one clean print -> resolved automatically
 *   5. no output, several prints  -> needs-selection
 *   6. no output, only truncated prints -> rejected (truncated-output)
 *   7. no output, no prints       -> rejected (no-output)
 */
export function resolveTrace(
  events: readonly EventEnvelope[],
  sourcePath: string,
): TraceResolution {
  const record = extractEvalRecord(events as EventEnvelope[], sourcePath);
  const taskDefault = taskDefaultFrom(record);

  const selection = selectLabelingFinalOutput(record);
  if (selection.kind === "selected") {
    const source: StatelogOutputSource = hasExplicitEvalOutput(events)
      ? { kind: "evalOutput", index: selection.index }
      : { kind: "return" };
    return { kind: "resolved", trace: { selection: { source, output: selection.value }, taskDefault } };
  }
  if (selection.kind === "truncated") {
    return { kind: "rejected", reason: "truncated-output" };
  }
  if (selection.kind === "legacy") {
    return { kind: "rejected", reason: "legacy-record" };
  }

  // No usable eval output: consider printed values.
  const prints = collectPrints(events);
  const clean = prints.filter((print) => !print.truncated);
  if (clean.length === 1) {
    const only = clean[0];
    return {
      kind: "resolved",
      trace: { selection: { source: { kind: "print", index: only.index }, output: only.value }, taskDefault },
    };
  }
  if (clean.length > 1) {
    const candidates = clean.map((print) => ({ index: print.index, value: print.value }));
    return { kind: "needs-selection", candidates, taskDefault };
  }
  // No clean prints. All-truncated is a different signal from no-prints.
  return { kind: "rejected", reason: prints.length > 0 ? "truncated-output" : "no-output" };
}

/** Turn a resolved trace and a task decision into a durable occurrence, or a
 *  skip when the projected output is ineligible (e.g. too large). Pure. */
export function projectTrace(
  traceId: string,
  resolved: ResolvedTrace,
  taskChoice: TaskChoice,
  context: ProjectionContext,
): ProjectionResult {
  const output = projectArtifactField(resolved.selection.output);
  const ineligible = checkEligibility(output, { maxBytes: context.maxBytes });
  if (ineligible !== undefined) {
    return { kind: "skipped", skip: { item: traceId, reason: ineligible } };
  }

  const taskValue = taskValueFor(taskChoice, resolved.taskDefault);
  const fields: Fields = taskValue === null
    ? { ...context.constantFields, output }
    : { task: projectArtifactField(taskValue), ...context.constantFields, output };

  const origin = OccurrenceOriginSchema.parse({
    kind: "statelog",
    traceId,
    outputSource: resolved.selection.source,
  });
  return { kind: "accepted", occurrence: { fields, source: context.source, origin } };
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
 *  null; a structured value is left structured until `projectArtifactField`. */
function taskDefaultFrom(record: { evalValues?: readonly { value: unknown }[] }): JsonValue | null {
  const values = record.evalValues ?? [];
  const last = values.at(-1);
  if (last === undefined) {
    return null;
  }
  const parsed = JsonValueSchema.safeParse(last.value);
  return parsed.success ? parsed.data : null;
}

function hasExplicitEvalOutput(events: readonly EventEnvelope[]): boolean {
  return events.some((event) => event.data.type === "evalOutputRecorded");
}

type CollectedPrint = {
  index: number;
  value: string;
  truncated: boolean;
};

function collectPrints(events: readonly EventEnvelope[]): CollectedPrint[] {
  const prints: CollectedPrint[] = [];
  let ordinal = 0;
  for (const event of events) {
    if (event.data.type !== "print") {
      continue;
    }
    const index = ordinal;
    ordinal += 1;
    const value = event.data.value;
    if (typeof value !== "string") {
      continue;
    }
    prints.push({ index, value, truncated: event.data.truncated === true });
  }
  return prints;
}
