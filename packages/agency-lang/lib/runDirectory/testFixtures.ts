import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { CodeIdentity } from "./codeIdentity.js";
import { tracesFromText, type Trace } from "./traces.js";

/** Test helpers for run-directory modules: statelog lines, traces, temp dirs. */
export function statelogLine(
  traceId: string,
  type: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    format_version: 1,
    trace_id: traceId,
    project_id: "p",
    span_id: null,
    parent_span_id: null,
    data: { type, timestamp: "2026-08-18T00:00:00Z", ...extra },
  });
}

export function agentStartLine(traceId: string, code?: CodeIdentity): string {
  const data: Record<string, unknown> = { entryNode: "main", args: {} };
  if (code !== undefined) data.code = code;
  return statelogLine(traceId, "agentStart", data);
}

export function tracesOf(...lines: string[]): Trace[] {
  return tracesFromText(lines.join("\n") + "\n").traces;
}

export function tempDir(prefix = "rundir-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeProject(files: Record<string, string>): string {
  const dir = tempDir("proj-");
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/** A finished agent trace: agentStart, an optional evalOutputRecorded, agentEnd
 *  with the return value. `output` undefined → no output recorded and a
 *  result-less agentEnd (a clean run that returned nothing). */
export function finishedTraceLines(
  traceId: string,
  options: { output?: unknown; input?: unknown; code?: CodeIdentity; costUsd?: number } = {},
): string[] {
  const start: Record<string, unknown> = { entryNode: "main", args: {} };
  if (options.input !== undefined) start.input = options.input;
  if (options.code !== undefined) start.code = options.code;
  const lines = [statelogLine(traceId, "agentStart", start)];
  if (options.costUsd !== undefined) {
    lines.push(
      statelogLine(traceId, "promptCompletion", {
        model: "test-model",
        cost: { totalCost: options.costUsd },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
  }
  if (options.output !== undefined) {
    lines.push(
      statelogLine(traceId, "evalOutputRecorded", { value: options.output, threadId: "0" }),
    );
  }
  lines.push(
    statelogLine(traceId, "agentEnd", {
      timeTaken: 5,
      ...(options.output === undefined ? {} : { result: options.output }),
    }),
  );
  return lines;
}
