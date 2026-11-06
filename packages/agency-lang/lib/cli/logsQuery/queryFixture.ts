// Test helpers for the logs query commands: a temp log of several traces
// whose lines arrive interleaved, and deps that read it with no viewer open.
import * as fs from "fs";
import * as path from "path";

import { pathKind } from "@/cli/logsSession/index.js";
import type { ProbedRecord } from "@/logsViewer/session/registry.js";
import { errorEvent } from "@/logsViewer/traceFixture.js";
import { loopEvents } from "@/logsViewer/storyFixture.js";
import type { EventEnvelope } from "@/logsViewer/types.js";
import { readTraces } from "@/runDirectory/traces.js";
import { tempDir } from "@/runDirectory/testFixtures.js";

import type { QueryDeps } from "./shared.js";

export const FIXTURE_NOW = Date.parse("2026-10-31T12:00:00Z");

export type FixtureTrace = {
  traceId: string;
  /** When the trace starts, as minutes before `FIXTURE_NOW`. */
  minutesAgo: number;
  /** Add an error event outside any tool, so the trace has `hasError`. */
  error?: boolean;
  /** Add this many tool calls that failed, each a tool span with an
   *  `error` event inside it, as a real log records one. */
  failedTools?: number;
  /** The trace's events; `loopEvents()` when left out. */
  events?: EventEnvelope[];
};

/** The events of one fixture trace, renamed and moved in time. */
export function traceEventsFor(trace: FixtureTrace): EventEnvelope[] {
  const events = trace.events ?? loopEvents();
  const first = Math.min(...events.map((event) => Date.parse(event.data.timestamp)));
  const shift = FIXTURE_NOW - trace.minutesAgo * 60_000 - first;
  const moved = events.map((event) => ({
    ...event,
    trace_id: trace.traceId,
    data: {
      ...event.data,
      timestamp: new Date(Date.parse(event.data.timestamp) + shift).toISOString(),
    },
  }));
  const last = moved[moved.length - 1].data.timestamp;
  const failedTools = Array.from({ length: trace.failedTools ?? 0 }, (_, n) =>
    failedToolEvents(trace.traceId, `failed-${n}`, last),
  ).flat();
  if (!trace.error) {
    return [...moved, ...failedTools];
  }
  const failure = errorEvent(trace.traceId);
  return [...moved, ...failedTools, { ...failure, data: { ...failure.data, timestamp: last } }];
}

/** A tool call that started and logged an error in its own span. */
function failedToolEvents(traceId: string, spanId: string, timestamp: string): EventEnvelope[] {
  return [
    { type: "toolCallStart", toolName: "grep" },
    { type: "error", errorType: "toolError", message: "grep failed", functionName: "grep" },
  ].map((data) => ({
    format_version: 1,
    trace_id: traceId,
    project_id: "",
    span_id: spanId,
    parent_span_id: null,
    data: { ...data, timestamp },
  }));
}

/** A log of the traces with their lines interleaved one by one, the way
 *  concurrent runs write them, in the order the traces are given. */
export function writeLog(dir: string, name: string, traces: FixtureTrace[]): string {
  const perTrace = traces.map(traceEventsFor);
  const longest = Math.max(...perTrace.map((events) => events.length));
  const lines: string[] = [];
  for (let position = 0; position < longest; position++) {
    for (const events of perTrace) {
      if (position < events.length) {
        lines.push(JSON.stringify(events[position]));
      }
    }
  }
  const logPath = path.join(dir, name);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, lines.join("\n") + "\n");
  return logPath;
}

export function queryDir(): string {
  return tempDir("logs-query-");
}

/** Deps over the real files in `cwd`, with no viewer open and no config. */
export function queryDeps(cwd: string, overrides: Partial<QueryDeps> = {}): QueryDeps {
  return {
    cwd,
    pathKind,
    childRunDirectories: () => [],
    configuredLog: () => undefined,
    probe: async () => [],
    readLog: (logPath) => readTraces(logPath).traces,
    now: () => FIXTURE_NOW,
    ...overrides,
  };
}

/** A probed viewer that answers, open on `logPath` at `traceId`. */
export function liveViewer(logPath: string, traceId: string): ProbedRecord {
  return {
    record: { pid: 7, logPath, cwd: path.dirname(logPath), started: "" },
    result: {
      state: "live",
      focus: { traceId, screen: "trace", rowId: undefined, logPath, commentsPath: undefined },
    },
  };
}
