import * as fs from "fs";

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
import { describeAvailableTraces, scanStatelog } from "./statelogScan.js";
import {
  IngestSourceError,
  type IngestSkip,
  type IngestSkipReason,
  type LoadedBatch,
  type LoadedOccurrence,
  type StatelogSelectionRequest,
} from "./types.js";

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

/** How much of a candidate print to show in a "which one?" error. */
const CANDIDATE_PREVIEW_CHARS = 60;

/**
 * Load one or more chosen traces from a statelog into a batch.
 *
 * Synchronous and non-interactive: every ambiguous trace must already have a
 * `--output` choice. The scan happens once; all requested ids are validated
 * before any projection, so a typo names the available traces instead of
 * silently promoting a subset.
 */
export function loadStatelog(args: {
  path: string;
  request: StatelogSelectionRequest;
  source: string;
  constantFields: Fields;
  includeTaskField: boolean;
  maxBytes: number;
}): LoadedBatch {
  const scan = scanStatelog(fs.readFileSync(args.path, "utf8"));

  if (args.request.traceIds.length === 0) {
    throw new IngestSourceError(
      `A statelog source needs at least one --trace <id>.\n${describeAvailableTraces(scan)}`,
    );
  }
  for (const traceId of args.request.traceIds) {
    if (!(traceId in scan.eventsByTrace)) {
      throw new IngestSourceError(
        `Trace "${traceId}" is not in ${args.path}.\n${describeAvailableTraces(scan)}`,
      );
    }
  }

  const occurrences: LoadedOccurrence[] = [];
  const skips: IngestSkip[] = [];
  const taskChoice: TaskChoice = args.includeTaskField ? { kind: "keep-default" } : { kind: "omit" };

  for (const traceId of args.request.traceIds) {
    const resolved = resolveSelectedTrace(traceId, scan.eventsByTrace[traceId], args.path, args.request.printSelections);
    if (resolved.kind === "rejected") {
      skips.push({ item: traceId, reason: resolved.reason });
      continue;
    }
    const projected = projectTrace(traceId, resolved.trace, taskChoice, {
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

/** Resolve one requested trace, applying its keyed print choice. A selector for
 *  a trace that needs no choice, or a missing/invalid choice for one that does,
 *  is a hard error — headless code never guesses. */
function resolveSelectedTrace(
  traceId: string,
  events: readonly EventEnvelope[],
  sourcePath: string,
  printSelections: Readonly<Record<string, number>>,
): { kind: "resolved"; trace: ResolvedTrace } | { kind: "rejected"; reason: IngestSkipReason } {
  const resolution = resolveTrace(events, sourcePath);
  if (resolution.kind === "rejected") {
    return resolution;
  }
  const selector = printSelections[traceId];
  if (resolution.kind === "resolved") {
    if (selector !== undefined) {
      throw new IngestSourceError(
        `--output was given for trace "${traceId}", but it already has a definite output; ` +
        `remove the selector.`,
      );
    }
    return { kind: "resolved", trace: resolution.trace };
  }
  // needs-selection
  if (selector === undefined) {
    const list = resolution.candidates
      .map((candidate) => `  print:${candidate.index}  ${candidate.value.slice(0, CANDIDATE_PREVIEW_CHARS)}`)
      .join("\n");
    throw new IngestSourceError(
      `Trace "${traceId}" has ${resolution.candidates.length} printed values and no recorded ` +
      `output. Pick one with --output ${traceId}=print:<index>:\n${list}`,
    );
  }
  const candidate = resolution.candidates.find((entry) => entry.index === selector);
  if (candidate === undefined) {
    throw new IngestSourceError(`Trace "${traceId}" has no printed value at index ${selector}.`);
  }
  return {
    kind: "resolved",
    trace: {
      selection: { source: { kind: "print", index: candidate.index }, output: candidate.value },
      taskDefault: resolution.taskDefault,
    },
  };
}
