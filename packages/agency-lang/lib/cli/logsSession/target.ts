// The one place that decides what a `logs` command acts on. Takes the
// parsed flags and the probed session records, returns a plain value; the
// commands are functions of that value and never look at flags. `chooseLog`
// is the half every logs command shares: the `session` commands wrap its
// choice with a comments store, and `traces`, `outline`, and `search` read
// the log it names.
import * as path from "path";

import type { ProbedRecord } from "@/logsViewer/session/registry.js";
import type { FocusReply } from "@/logsViewer/session/protocol.js";
import type { SessionRecord } from "@/logsViewer/session/record.js";
import type { CommentAuthor } from "@/runDirectory/comments.js";
import { commentsPathFor, commentsSourceForStatelog } from "@/runDirectory/commentsPath.js";
import type { CommentsStore } from "@/runDirectory/commentsStore.js";
import { runDirPaths } from "@/runDirectory/runDir.js";

export type TargetArgs = {
  /** `--log`: the statelog to act on, which also picks the viewer on it. */
  log?: string;
  /** `--trace`, a full id or unique prefix; resolved by the command. */
  traceId?: string;
  /** A row argument: a full address, or a bare row id. */
  row?: string;
};

export type LiveSession = { record: SessionRecord; focus: FocusReply; socketPath: string };

export type Target =
  | {
      kind: "session";
      session: LiveSession;
      /** Undefined when the viewer has no comments file (stdin). */
      store: CommentsStore | undefined;
      /** `--trace`, else the viewer's current trace. A full address wins
       *  over both once the command reads the log. */
      traceId: string;
      /** The row argument as given: an address or a bare row id. Which it
       *  is can only be told against the log's trace ids, so the command
       *  decides (`locate` in commands.ts). */
      rowRef: string | undefined;
    }
  | {
      kind: "files";
      logPath: string;
      store: CommentsStore;
      traceId: string | undefined;
      rowRef: string | undefined;
    }
  | { kind: "refused"; reason: string };

export type LogDeps = {
  cwd: string;
  /** What `--log` names on disk, so a run directory can stand for its
   *  statelog and a typo is refused before anything reads it. */
  pathKind(absolutePath: string): "file" | "directory" | "missing";
  /** The run directories inside a directory that is not one itself, so a
   *  directory of runs is refused with a pointer to the explorer. */
  childRunDirectories(dir: string): string[];
  /** `log.logFile` from `agency.json`, read only when `--log` is absent,
   *  so a broken config cannot stop a command that named its log. An
   *  empty string counts as unset: `--log stdout` writes `""` there on
   *  purpose to cancel a configured file. */
  configuredLog(): string | undefined;
};

export type TargetDeps = LogDeps & {
  socketPathFor(record: SessionRecord): string;
  openStore(commentsPath: string, author: CommentAuthor): CommentsStore;
  author: CommentAuthor;
};

export type LogChoice =
  | { kind: "session"; session: LiveSession }
  | { kind: "files"; logPath: string }
  | { kind: "refused"; reason: string };

export const NO_LOG_GIVEN =
  "No log given. Pass --log <file>, set log.logFile in agency.json, or open a viewer with `agency logs <file>`.";

export function resolveTarget(
  args: TargetArgs,
  probed: readonly ProbedRecord[],
  deps: TargetDeps,
): Target {
  const live = liveSessions(probed, deps.socketPathFor);
  const chosen = chooseLog(args.log, live, deps);
  if (chosen.kind === "refused") {
    return chosen;
  }
  if (chosen.kind === "session") {
    const { session } = chosen;
    return {
      kind: "session",
      session,
      store:
        session.record.commentsPath === undefined
          ? undefined
          : deps.openStore(session.record.commentsPath, deps.author),
      traceId: args.traceId ?? session.focus.traceId,
      rowRef: args.row,
    };
  }
  const logPath = chosen.logPath;
  return {
    kind: "files",
    logPath,
    store: deps.openStore(commentsPathFor(commentsSourceForStatelog(logPath)), deps.author),
    traceId: args.traceId,
    rowRef: args.row,
  };
}

/** The viewers that answered the probe. */
export function liveSessions(
  probed: readonly ProbedRecord[],
  socketPathFor: (record: SessionRecord) => string,
): LiveSession[] {
  return probed.flatMap((entry) =>
    entry.result.state === "live"
      ? [
          {
            record: entry.record,
            focus: entry.result.focus,
            socketPath: socketPathFor(entry.record),
          },
        ]
      : [],
  );
}

/**
 * The log a command acts on, in this order:
 *
 * 1. `--log`, which also picks the viewer that has that log open.
 * 2. The one open viewer. Several open viewers are refused with "say
 *    which", and the configured log never overrides that.
 * 3. The log `agency.json` names, when no viewer is open.
 * 4. A refusal that says all three ways forward.
 *
 * A path is what `agency logs` takes: a statelog file or a run directory,
 * which stands for the `statelog.jsonl` inside it. A directory of run
 * directories is refused with a pointer to the runs explorer, and a path
 * that is not there is refused, so no command reads a log that does not
 * exist.
 */
export function chooseLog(log: string | undefined, live: LiveSession[], deps: LogDeps): LogChoice {
  if (log !== undefined) {
    const given = logAt(path.resolve(deps.cwd, log), deps);
    if ("refused" in given) {
      return { kind: "refused", reason: given.refused };
    }
    const session = live.find(
      (candidate) => path.resolve(candidate.record.logPath) === given.logPath,
    );
    return session === undefined
      ? { kind: "files", logPath: given.logPath }
      : { kind: "session", session };
  }
  if (live.length === 1) {
    return { kind: "session", session: live[0] };
  }
  if (live.length > 1) {
    const listed = live
      .map((session) => `  ${session.record.logPath} (pid ${session.record.pid})`)
      .join("\n");
    return {
      kind: "refused",
      reason: `${live.length} viewers are open; say which with --log <file>:\n${listed}`,
    };
  }
  const configured = deps.configuredLog();
  if (configured === undefined || configured === "") {
    return { kind: "refused", reason: NO_LOG_GIVEN };
  }
  const found = logAt(path.resolve(deps.cwd, configured), deps);
  if ("refused" in found) {
    return { kind: "refused", reason: `${found.refused} (log.logFile in agency.json)` };
  }
  return { kind: "files", logPath: found.logPath };
}

/** The statelog a path names, or why it names none. */
function logAt(absolutePath: string, deps: LogDeps): { logPath: string } | { refused: string } {
  const kind = deps.pathKind(absolutePath);
  if (kind === "missing") {
    return { refused: `no log at ${absolutePath}` };
  }
  if (kind === "file") {
    return { logPath: absolutePath };
  }
  const statelog = runDirPaths(absolutePath).statelog;
  if (deps.pathKind(statelog) !== "missing") {
    return { logPath: statelog };
  }
  if (deps.childRunDirectories(absolutePath).length > 0) {
    return {
      refused: `${absolutePath} holds several runs; open them with \`agency logs ${absolutePath} --csv\`, or pass one run directory`,
    };
  }
  return { refused: `no log at ${statelog}` };
}
