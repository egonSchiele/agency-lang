// The std::statelog readers: logTraces, logOutline, logSearch, and logRow.
// Each is one of the `agency logs` query functions (lib/logsQuery/) called
// on the one log the Agency wrapper named, took the real path of, and got
// approved under `std::read`. A separate file from statelog.ts, which every
// program that uses safeBash or the REPL loads; the logs viewer modules
// these reach load only for a program that reads a log.
import path from "path";

import type { Host } from "../host/host.js";
import { logsOutline } from "../logsQuery/outline.js";
import { logsRow } from "../logsQuery/row.js";
import { logsSearch } from "../logsQuery/search.js";
import type { QueryDeps, QueryResult } from "../logsQuery/shared.js";
import { logsTraces } from "../logsQuery/traces.js";
import { currentRunOrNone } from "../runtime/asyncContext.js";
import { currentHost } from "../runtime/currentHost.js";
import { FIELD_NAMES, type TraceSelectionFlags } from "../runDirectory/traceSelection.js";
import { readTracesFromChunks } from "../runDirectory/traces.js";

/**
 * The log a reader's `log` argument names. A path is returned as given,
 * for the wrapper to take its real path. An empty string is the log this
 * run writes to, `log.logFile`: a failure when there is none, or when
 * observability is off, since then the file holds only what earlier runs
 * wrote.
 */
export function _logToRead(log: string): string {
  const frame = currentRunOrNone();
  if (log !== "") {
    return log;
  }
  const sink = frame?.ctx.getStatelogSink();
  if (sink?.logFile === undefined || sink.logFile === "") {
    throw new Error("This run has no log file. Pass a log path, or set log.logFile.");
  }
  if (!sink.observability) {
    throw new Error("This run is not writing its log: observability is off. Pass a log path.");
  }
  return sink.logFile;
}

/** The deps of a query on the approved log at `logPath`. The bytes are
 *  read through `fixedRoot` of the directory the approval named, so a link
 *  planted below it is refused (docs/dev/stdlib/contained-files.md). */
function approvedLogDeps(host: Host, logPath: string): QueryDeps {
  return {
    cwd: host.system.cwd(),
    loadLog: async () => {
      const root = await host.files.fixedRoot(path.dirname(logPath));
      const read = await readTracesFromChunks(host.files.readChunks(root, path.basename(logPath)));
      return { logPath, traces: read.traces };
    },
    now: () => host.clock.wallTime(),
    names: FIELD_NAMES,
  };
}

/** A query's result as the library returns it: its JSON and its text. A
 *  refusal throws, so the wrapper's `try` makes it the failure. */
function answerOf(result: QueryResult): Record<string, unknown> {
  if (result.exitCode !== 0) {
    throw new Error(result.text);
  }
  return { ...(result.json as Record<string, unknown>), text: result.text };
}

export async function _logTraces(
  logPath: string,
  select: TraceSelectionFlags,
  errorsOnly: boolean,
): Promise<Record<string, unknown>> {
  const deps = approvedLogDeps(currentHost(), logPath);
  return answerOf(await logsTraces({ ...select, json: true, errors: errorsOnly }, deps));
}

export async function _logOutline(
  logPath: string,
  select: TraceSelectionFlags,
  approvals: boolean,
  admin: boolean,
): Promise<Record<string, unknown>> {
  const deps = approvedLogDeps(currentHost(), logPath);
  return answerOf(await logsOutline({ ...select, json: true, approvals, admin }, deps));
}

export async function _logSearch(
  logPath: string,
  pattern: string,
  select: TraceSelectionFlags,
  kinds: string[],
  regex: boolean,
  caseSensitive: boolean,
  limit: number,
  context: number,
): Promise<Record<string, unknown>> {
  const deps = approvedLogDeps(currentHost(), logPath);
  // In Agency an empty list searches every kind.
  const searched = kinds.length === 0 ? undefined : kinds;
  return answerOf(
    await logsSearch(
      { ...select, pattern, json: true, kinds: searched, regex, caseSensitive, limit, context },
      deps,
    ),
  );
}

export async function _logRow(
  logPath: string,
  address: string,
  maxChars: number,
): Promise<Record<string, unknown>> {
  const deps = approvedLogDeps(currentHost(), logPath);
  return answerOf(await logsRow({ address, maxChars }, deps));
}
