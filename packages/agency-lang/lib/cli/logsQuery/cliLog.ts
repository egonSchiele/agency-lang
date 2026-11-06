// How the CLI finds the log a query reads: `--log`, the one open viewer's
// log, or `log.logFile`, by `chooseLog`, the rule the session commands use.
// The query functions take the result through `QueryDeps.loadLog` and know
// nothing about viewers or config; `std::statelog` gives them a log that
// was named and approved instead.
import * as path from "path";

import { chooseLog, type LiveSession, type LogDeps } from "@/cli/logsSession/target.js";
import type { Trace } from "@/runDirectory/traces.js";

import type { QueryDeps } from "@/logsQuery/shared.js";

export type CliLogDeps = LogDeps & {
  /** The open viewers, probed as the session commands probe them. A query
   *  never talks to the viewer itself. */
  probe(): Promise<LiveSession[]>;
  readLog(logPath: string): Trace[];
};

export function cliLoadLog(deps: CliLogDeps): QueryDeps["loadLog"] {
  return async (log) => {
    const choice = chooseLog(log, log === undefined ? await deps.probe() : [], deps);
    if (choice.kind === "refused") {
      return { refused: choice.reason };
    }
    const logPath =
      choice.kind === "session" ? path.resolve(choice.session.record.logPath) : choice.logPath;
    return { logPath, traces: deps.readLog(logPath) };
  };
}
