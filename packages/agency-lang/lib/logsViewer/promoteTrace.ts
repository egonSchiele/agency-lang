import { datasetWriter as defaultDatasetWriter, type DatasetWriter } from "@/eval/label/datasetWriter.js";
import { makeOutputId } from "@/eval/label/ids.js";
import type { LabelingHost } from "@/eval/label/labelingHost.js";
import {
  projectTrace,
  resolveTrace,
  type PrintCandidate,
  type ResolvedTrace,
  type TaskChoice,
} from "@/eval/label/load/statelog.js";
import { DEFAULT_MAX_INGEST_BYTES, type IngestSkipReason } from "@/eval/label/load/types.js";
import type { Annotator } from "@/eval/label/types.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";
import type { JsonValue } from "@/utils/canonicalize.js";

export type PromotionRequest = {
  traceId: string;
  events: readonly EventEnvelope[];
  sourceName: string;
  sourcePath: string;
  datasetDir: string;
  annotator: Annotator;
  checklistFile?: string;
};

/** The interactive decisions the orchestrator delegates to the surface. Every
 *  one returns `null` to mean "the user backed out". */
export type PromotionUI = {
  choosePrint(candidates: readonly PrintCandidate[]): Promise<number | null>;
  editTask(defaultTask: JsonValue | null): Promise<TaskChoice | null>;
  notify(message: string): void;
};

export type PromotionServices = {
  datasetWriter: DatasetWriter;
  labelingHost: LabelingHost;
};

export type PromotionOutcome =
  | { kind: "labeled"; outputId: string }
  | { kind: "cancelled" }
  | { kind: "rejected"; reason: IngestSkipReason | "missing-checklist" };

/**
 * Promote one already-scanned trace into a dataset and hand off to labeling.
 *
 * Pure of effects beyond the injected services: it resolves the trace, asks the
 * UI only for decisions it cannot make itself (which print, the task text),
 * projects, writes through the DatasetWriter, and labels through the
 * LabelingHost. No file reread, no lock, no controller, no terminal code — those
 * belong to the services it is given.
 */
export async function promoteFocusedTrace(
  request: PromotionRequest,
  ui: PromotionUI,
  services: PromotionServices,
): Promise<PromotionOutcome> {
  const resolution = resolveTrace(request.events, request.sourcePath);
  if (resolution.kind === "rejected") {
    ui.notify(`Nothing to label for this trace: ${resolution.reason}.`);
    return { kind: "rejected", reason: resolution.reason };
  }
  if (request.checklistFile === undefined) {
    ui.notify("Pass --checklist <file> to label promoted traces.");
    return { kind: "rejected", reason: "missing-checklist" };
  }

  const resolved = await selectResolvedTrace(resolution, ui);
  if (resolved === null) {
    return { kind: "cancelled" };
  }

  const taskChoice = await ui.editTask(resolved.taskDefault);
  if (taskChoice === null) {
    return { kind: "cancelled" };
  }

  const projected = projectTrace(request.traceId, resolved, taskChoice, {
    source: request.sourceName,
    constantFields: {},
    maxBytes: DEFAULT_MAX_INGEST_BYTES,
  });
  if (projected.kind === "skipped") {
    ui.notify(`Nothing to label for this trace: ${projected.skip.reason}.`);
    return { kind: "rejected", reason: projected.skip.reason };
  }

  // The id the dataset will derive for these fields, so the labeling session can
  // open focused on the example just written.
  const outputId = makeOutputId(projected.occurrence.fields);
  services.datasetWriter.ingest({
    datasetDir: request.datasetDir,
    batch: { occurrences: [projected.occurrence], skips: [] },
    reportWarning: (message) => ui.notify(message),
  });
  await services.labelingHost.run({
    datasetDir: request.datasetDir,
    checklistFile: request.checklistFile,
    annotator: request.annotator,
    focusOutputId: outputId,
  });
  return { kind: "labeled", outputId };
}

async function selectResolvedTrace(
  resolution: Exclude<ReturnType<typeof resolveTrace>, { kind: "rejected" }>,
  ui: PromotionUI,
): Promise<ResolvedTrace | null> {
  if (resolution.kind === "resolved") {
    return resolution.trace;
  }
  const chosenIndex = await ui.choosePrint(resolution.candidates);
  if (chosenIndex === null) {
    return null;
  }
  const candidate = resolution.candidates.find((entry) => entry.index === chosenIndex);
  if (candidate === undefined) {
    return null;
  }
  return {
    selection: { source: { kind: "print", index: candidate.index }, output: candidate.value },
    taskDefault: resolution.taskDefault,
  };
}

/** The production services: the shared writer and a host bound to the viewer's
 *  screen (supplied by the caller, since only it owns the terminal). */
export function promotionServices(labelingHost: LabelingHost): PromotionServices {
  return { datasetWriter: defaultDatasetWriter, labelingHost };
}
