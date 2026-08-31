import * as path from "path";

import {
  createEvalUploadClient,
  EVENTS_PER_REQUEST,
  type EvalUploadClient,
  type RemoteTraceState,
  type SequencedEvent,
} from "@/cli/statelog/evalUploadClient.js";
import type { Annotation } from "@/runDirectory/annotations.js";
import { findRunDirectories, uniqueRunDirectories } from "@/runDirectory/findRuns.js";
import { summarizeRunDirectory, type RunSummary } from "@/runDirectory/list.js";
import { readRunDirectory } from "@/runDirectory/runDir.js";
import { mapInParallel } from "@/utils/parallelMap.js";
import type { EventEnvelope } from "@/statelog/wireTypes.js";

/**
 * `agency eval upload`: send finished run directories, with their grades, to
 * the linked statelog project. Per run: ask the server what it already holds
 * for the trace, send only what is safe (all of it, the missing tail of an
 * earlier bulk upload, or nothing), then upsert every annotation row. A run
 * that fails never stops the next one. Statelog dedupes per trace, so running
 * this twice is harmless.
 */
export type EvalUploadTarget = { origin: string; projectSlug: string; apiKey: string };

export type EvalUploadDependencies = {
  client?: EvalUploadClient;
  reportWarning?: (message: string) => void;
  /** Called with one formatted line as each run finishes. */
  reportProgress?: (line: string) => void;
};

export type UploadRunOutcome =
  | { dir: string; traceId: string; status: "uploaded"; events: number; annotations: number }
  | {
      dir: string;
      traceId: string;
      status: "present";
      serverEvents: number;
      fileEvents: number;
      annotations: number;
    }
  | {
      dir: string;
      traceId: string;
      status: "resumed";
      from: number;
      events: number;
      annotations: number;
    }
  | { dir: string; traceId: string | null; status: "failed"; error: string };

export type EvalUploadResult = {
  runs: UploadRunOutcome[];
  /** The batch page on statelog, when every uploaded run belongs to one
   *  batch; null otherwise. */
  batchUrl: string | null;
};

const UPLOAD_PARALLELISM = 6;

export async function evalUpload(
  targets: string[],
  target: EvalUploadTarget,
  dependencies: EvalUploadDependencies = {},
): Promise<EvalUploadResult> {
  const client =
    dependencies.client ?? createEvalUploadClient(target.origin, target.projectSlug, target.apiKey);
  const reportWarning = dependencies.reportWarning ?? ((message) => console.warn(message));
  const dirs = uniqueRunDirectories(findRunDirectories(targets));
  // Runs are independent traces, so they upload through a bounded pool —
  // unbounded, a 69-run group is hundreds of concurrent requests and the
  // host sheds them with 429s. Results keep input order.
  const records = await mapInParallel(dirs, UPLOAD_PARALLELISM, async (dir) => {
    const record = await uploadRun(dir, client, reportWarning);
    dependencies.reportProgress?.(formatRunLine(record.outcome));
    return record;
  });
  return { runs: records.map((record) => record.outcome), batchUrl: batchUrlFor(records, target) };
}

/** One run's summary (when it could be read) beside what happened to it. */
type RunRecord = { summary: RunSummary | null; outcome: UploadRunOutcome };

/** What to do with a trace's events, given what the server holds and how
 *  many events the file has. Pure, so every branch is testable. */
export type EventPlan =
  | { kind: "create-empty" }
  | { kind: "upload-all" }
  | { kind: "skip"; serverEvents: number }
  | { kind: "resume"; from: number }
  | { kind: "refuse"; reason: string };

export function eventPlan(state: RemoteTraceState, fileEvents: number): EventPlan {
  switch (state.kind) {
    case "missing":
      return fileEvents === 0 ? { kind: "create-empty" } : { kind: "upload-all" };
    case "empty":
      return fileEvents === 0 ? { kind: "skip", serverEvents: 0 } : { kind: "upload-all" };
    case "live":
      if (state.eventCount === fileEvents) {
        return { kind: "skip", serverEvents: state.eventCount };
      }
      return {
        kind: "refuse",
        reason:
          `the server holds ${state.eventCount} live-streamed events and the file has ` +
          `${fileEvents}; a live trace cannot be completed by upload`,
      };
    case "bulk-prefix":
      if (state.eventCount === fileEvents) {
        return { kind: "skip", serverEvents: state.eventCount };
      }
      if (state.eventCount < fileEvents) {
        return { kind: "resume", from: state.nextSequence };
      }
      return {
        kind: "refuse",
        reason: `the server holds ${state.eventCount} events but the file has only ${fileEvents}`,
      };
    case "invalid":
      return { kind: "refuse", reason: `the server reports an unusable trace: ${state.reason}` };
  }
}

async function uploadRun(
  dir: string,
  client: EvalUploadClient,
  reportWarning: (message: string) => void,
): Promise<RunRecord> {
  let summary: RunSummary | null;
  let events: readonly EventEnvelope[];
  let rows: Annotation[];
  try {
    const snapshot = readRunDirectory(dir, { reportWarning });
    summary = summarizeRunDirectory(snapshot);
    if (summary === null) {
      return failed(dir, null, null, "not a run: the directory has no trace and no run row");
    }
    const traceId = summary.traceId;
    events = snapshot.traces.find((trace) => trace.traceId === traceId)?.events ?? [];
    rows = snapshot.annotationRows.filter((row) => row.traceId === traceId);
  } catch (error) {
    return failed(dir, null, null, messageOf(error));
  }
  const traceId = summary.traceId;
  try {
    const plan = eventPlan(await client.traceUploadState(traceId), events.length);
    if (plan.kind === "refuse") {
      // No annotations either: they would summarize a trace the server
      // cannot complete.
      return failed(dir, traceId, summary, plan.reason);
    }
    if (plan.kind === "create-empty") {
      await client.postEvents(traceId, []);
    }
    const from = plan.kind === "resume" ? plan.from : 0;
    if (plan.kind === "upload-all" || plan.kind === "resume") {
      for (const chunk of chunked(sequencedFrom(events, from), EVENTS_PER_REQUEST)) {
        await client.postEvents(traceId, chunk);
      }
    }
    if (rows.length > 0) {
      await client.postAnnotations(rows);
    }
    return { summary, outcome: outcomeOf(dir, traceId, plan, events.length, rows.length) };
  } catch (error) {
    return failed(dir, traceId, summary, messageOf(error));
  }
}

function outcomeOf(
  dir: string,
  traceId: string,
  plan: Exclude<EventPlan, { kind: "refuse" }>,
  fileEvents: number,
  annotations: number,
): UploadRunOutcome {
  switch (plan.kind) {
    case "create-empty":
      return { dir, traceId, status: "uploaded", events: 0, annotations };
    case "upload-all":
      return { dir, traceId, status: "uploaded", events: fileEvents, annotations };
    case "skip":
      return {
        dir,
        traceId,
        status: "present",
        serverEvents: plan.serverEvents,
        fileEvents,
        annotations,
      };
    case "resume":
      return {
        dir,
        traceId,
        status: "resumed",
        from: plan.from,
        events: fileEvents - plan.from,
        annotations,
      };
  }
}

function failed(
  dir: string,
  traceId: string | null,
  summary: RunSummary | null,
  error: string,
): RunRecord {
  return { summary, outcome: { dir, traceId, status: "failed", error } };
}

function sequencedFrom(events: readonly EventEnvelope[], from: number): SequencedEvent[] {
  return events.slice(from).map((envelope, offset) => ({ sequence: from + offset, envelope }));
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** The batch page, only when it would show exactly these runs: every run
 *  that made it shares one batch id. Statelog keys the page by project and
 *  batch alone; agent names are labels there, not part of the URL. */
function batchUrlFor(records: readonly RunRecord[], target: EvalUploadTarget): string | null {
  const summaries = records.flatMap((record) =>
    record.outcome.status === "failed" || record.summary === null ? [] : [record.summary],
  );
  if (summaries.length === 0) {
    return null;
  }
  const batch = summaries[0].batch;
  if (batch === null || summaries.some((summary) => summary.batch !== batch)) {
    return null;
  }
  const url = new URL("/projects/evals/batch", target.origin);
  url.searchParams.set("id", target.projectSlug);
  url.searchParams.set("batch", batch);
  return url.toString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One run's outcome as the line the CLI prints. */
export function formatRunLine(run: UploadRunOutcome, cwd: string = process.cwd()): string {
  return `${shownDir(run.dir, cwd)}: ${describeOutcome(run)}`;
}

/** The closing lines: a count line, and the batch page when there is one. */
export function formatUploadSummary(result: EvalUploadResult): string[] {
  const counts = ["uploaded", "present", "resumed", "failed"].flatMap((status) => {
    const count = result.runs.filter((run) => run.status === status).length;
    return count === 0 ? [] : [`${count} ${status}`];
  });
  const lines = [counts.join(" · ")];
  if (result.batchUrl !== null) {
    lines.push(`batch: ${result.batchUrl}`);
  }
  return lines;
}

/** Every output line at once: per-run lines, then the summary. */
export function formatUploadResult(
  result: EvalUploadResult,
  cwd: string = process.cwd(),
): string[] {
  return [...result.runs.map((run) => formatRunLine(run, cwd)), ...formatUploadSummary(result)];
}

function describeOutcome(run: UploadRunOutcome): string {
  switch (run.status) {
    case "uploaded":
      return `uploaded ${run.events} events, ${run.annotations} annotations`;
    case "present":
      return `already present (${run.serverEvents} events); ${run.annotations} annotations upserted`;
    case "resumed":
      return `resumed at event ${run.from}: ${run.events} events, ${run.annotations} annotations`;
    case "failed":
      return `failed: ${run.error}`;
  }
}

function shownDir(dir: string, cwd: string): string {
  const relative = path.relative(cwd, dir);
  return relative === "" || relative.startsWith("..") ? dir : relative;
}
