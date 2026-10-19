// The one place that decides what a `logs session` command acts on. Takes
// the parsed flags and the probed session records, returns a plain value;
// the commands are functions of that value and never look at flags.
import * as path from "path";

import { isAddress, parseAddress } from "@/logsViewer/address.js";
import type { ProbedRecord } from "@/logsViewer/session/registry.js";
import type { FocusReply } from "@/logsViewer/session/protocol.js";
import type { SessionRecord } from "@/logsViewer/session/record.js";
import type { CommentAuthor } from "@/runDirectory/comments.js";
import { commentsPathFor, commentsSourceForStatelog } from "@/runDirectory/commentsPath.js";
import type { CommentsStore } from "@/runDirectory/commentsStore.js";

export type TargetArgs = {
  /** `--log`: the statelog to act on, which also picks the viewer on it. */
  log?: string;
  /** `--trace-id`, a full id or unique prefix; resolved by the command. */
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
      traceId: string;
      rowId: string | undefined;
    }
  | {
      kind: "files";
      logPath: string;
      store: CommentsStore;
      traceId: string | undefined;
      rowId: string | undefined;
    }
  | { kind: "refused"; reason: string };

export type TargetDeps = {
  socketPathFor(record: SessionRecord): string;
  openStore(commentsPath: string, author: CommentAuthor): CommentsStore;
  author: CommentAuthor;
  cwd: string;
};

export function resolveTarget(
  args: TargetArgs,
  probed: readonly ProbedRecord[],
  deps: TargetDeps,
): Target {
  const row = args.row === undefined ? undefined : parseRowArgument(args.row);
  if (row !== undefined && "error" in row) {
    return { kind: "refused", reason: row.error };
  }
  const live = liveSessions(probed, deps);
  const chosen = chooseSession(args.log, live, deps.cwd);
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
      traceId: row?.traceId ?? args.traceId ?? session.focus.traceId,
      rowId: row?.rowId,
    };
  }
  const logPath = chosen.logPath;
  return {
    kind: "files",
    logPath,
    store: deps.openStore(commentsPathFor(commentsSourceForStatelog(logPath)), deps.author),
    traceId: row?.traceId ?? args.traceId,
    rowId: row?.rowId,
  };
}

/** A full address names its trace; a bare row id leaves it to the flag or
 *  the viewer. Row ids never contain a slash, so the slash decides. */
function parseRowArgument(
  text: string,
): { traceId: string | undefined; rowId: string } | { error: string } {
  if (!text.includes("/")) {
    return { traceId: undefined, rowId: text };
  }
  const parsed = parseAddress(text);
  return isAddress(parsed) ? parsed : { error: parsed.error };
}

function liveSessions(probed: readonly ProbedRecord[], deps: TargetDeps): LiveSession[] {
  return probed.flatMap((entry) =>
    entry.result.state === "live"
      ? [
          {
            record: entry.record,
            focus: entry.result.focus,
            socketPath: deps.socketPathFor(entry.record),
          },
        ]
      : [],
  );
}

/**
 * `--log` picks the viewer on that log, else the files; with no `--log`, the
 * only open viewer; several open viewers need `--log`; none open and no
 * `--log` is a refusal that says both ways forward.
 */
function chooseSession(
  log: string | undefined,
  live: LiveSession[],
  cwd: string,
): { kind: "session"; session: LiveSession } | { kind: "files"; logPath: string } | Target {
  if (log !== undefined) {
    const logPath = path.resolve(cwd, log);
    const session = live.find((candidate) => path.resolve(candidate.record.logPath) === logPath);
    return session === undefined ? { kind: "files", logPath } : { kind: "session", session };
  }
  if (live.length === 1) {
    return { kind: "session", session: live[0] };
  }
  if (live.length === 0) {
    return {
      kind: "refused",
      reason:
        "no viewer is open: open one with `agency logs <file>`, or pass --log <file> to work on the files",
    };
  }
  const listed = live
    .map((session) => `  ${session.record.logPath} (pid ${session.record.pid})`)
    .join("\n");
  return {
    kind: "refused",
    reason: `${live.length} viewers are open; say which with --log <file>:\n${listed}`,
  };
}
