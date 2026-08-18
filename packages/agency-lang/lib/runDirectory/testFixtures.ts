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
  return statelogLine(traceId, "agentStart", {
    entryNode: "main",
    args: {},
    ...(code === undefined ? {} : { code }),
  });
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
