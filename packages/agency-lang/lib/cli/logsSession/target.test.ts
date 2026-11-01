import { describe, expect, it } from "vitest";

import type { ProbedRecord } from "@/logsViewer/session/registry.js";
import type { CommentsStore } from "@/runDirectory/commentsStore.js";

import {
  chooseLog,
  liveSessions,
  NO_LOG_GIVEN,
  resolveTarget,
  type LogDeps,
  type TargetDeps,
} from "./target.js";

const author = { kind: "agent" as const, id: "claude" };
const deps: TargetDeps = {
  socketPathFor: (record) => `/s/${record.pid}.sock`,
  openStore: (commentsPath) => ({ path: commentsPath }) as CommentsStore,
  author,
  cwd: "/work",
  pathKind: (absolutePath) =>
    absolutePath.endsWith("/missing.jsonl")
      ? "missing"
      : absolutePath.endsWith(".jsonl")
        ? "file"
        : "directory",
  childRunDirectories: () => [],
  configuredLog: () => undefined,
};

function live(pid: number, logPath: string, commentsPath?: string): ProbedRecord {
  return {
    record: { pid, logPath, commentsPath, cwd: "/", started: "" },
    result: {
      state: "live",
      focus: { traceId: "focused", screen: "trace", rowId: "round:s1:0", logPath, commentsPath },
    },
  };
}
const silent: ProbedRecord = {
  record: { pid: 9, logPath: "/logs/quiet.jsonl", cwd: "/", started: "" },
  result: { state: "not-responding" },
};

describe("resolveTarget", () => {
  describe("choosing a session", () => {
    it("none open and no --log is refused, with both ways forward", () => {
      const target = resolveTarget({}, [silent], deps);
      expect(target).toMatchObject({ kind: "refused" });
      if (target.kind === "refused") {
        expect(target.reason).toContain("--log");
        expect(target.reason).toContain("agency logs");
      }
    });

    it("the only live viewer is the target, with its comments store and current trace", () => {
      const target = resolveTarget({}, [live(1, "/logs/a.jsonl", "/logs/a.comments")], deps);
      expect(target).toMatchObject({
        kind: "session",
        traceId: "focused",
        store: { path: "/logs/a.comments" },
        session: { socketPath: "/s/1.sock" },
      });
    });

    it("a viewer without a comments file gives no store", () => {
      const target = resolveTarget({}, [live(1, "/logs/a.jsonl")], deps);
      expect(target).toMatchObject({ kind: "session", store: undefined });
    });

    it("two live viewers need --log, and the refusal lists them", () => {
      const target = resolveTarget({}, [live(1, "/logs/a.jsonl"), live(2, "/logs/b.jsonl")], deps);
      expect(target).toMatchObject({ kind: "refused" });
      if (target.kind === "refused") {
        expect(target.reason).toContain("/logs/a.jsonl (pid 1)");
        expect(target.reason).toContain("/logs/b.jsonl (pid 2)");
      }
    });

    it("--log picks the viewer on that log, else the files, resolved against cwd", () => {
      const sessions = [live(1, "/logs/a.jsonl"), live(2, "/logs/b.jsonl")];
      expect(resolveTarget({ log: "/logs/b.jsonl" }, sessions, deps)).toMatchObject({
        kind: "session",
        session: { record: { pid: 2 } },
      });
      expect(resolveTarget({ log: "runs/c/statelog.jsonl" }, sessions, deps)).toMatchObject({
        kind: "files",
        logPath: "/work/runs/c/statelog.jsonl",
        store: { path: "/work/runs/c/comments.jsonl" },
        traceId: undefined,
      });
      expect(resolveTarget({ log: "/logs/loose.jsonl" }, [], deps)).toMatchObject({
        kind: "files",
        store: { path: "/logs/loose.jsonl.comments.jsonl" },
      });
    });

    it("--log <run directory> stands for the statelog inside it, for a viewer or the files", () => {
      const sessions = [live(1, "/work/runs/a/statelog.jsonl")];
      expect(resolveTarget({ log: "runs/a" }, sessions, deps)).toMatchObject({
        kind: "session",
        session: { record: { pid: 1 } },
      });
      expect(resolveTarget({ log: "runs/b" }, sessions, deps)).toMatchObject({
        kind: "files",
        logPath: "/work/runs/b/statelog.jsonl",
        store: { path: "/work/runs/b/comments.jsonl" },
      });
    });

    it("--log on a path that is not there is refused, not read", () => {
      const target = resolveTarget({ log: "runs/missing.jsonl" }, [], deps);
      expect(target).toEqual({ kind: "refused", reason: "no log at /work/runs/missing.jsonl" });
    });
  });

  describe("choosing a trace", () => {
    const session = [live(1, "/logs/a.jsonl", "/logs/a.comments")];

    it("takes --trace, else the viewer's trace, else nothing; the row argument passes through", () => {
      expect(resolveTarget({ row: "round:s1:2", traceId: "flag" }, session, deps)).toMatchObject({
        traceId: "flag",
        rowRef: "round:s1:2",
      });
      expect(resolveTarget({ row: "k3Pq/round:s1:2" }, session, deps)).toMatchObject({
        traceId: "focused",
        rowRef: "k3Pq/round:s1:2",
      });
      expect(resolveTarget({ row: "round:s1:2", log: "/logs/x.jsonl" }, [], deps)).toMatchObject({
        kind: "files",
        traceId: undefined,
        rowRef: "round:s1:2",
      });
    });
  });
});

describe("chooseLog", () => {
  const files: Record<string, "file" | "directory"> = {
    "/work/log.jsonl": "file",
    "/work/runs/today": "directory",
    "/work/runs/today/statelog.jsonl": "file",
    "/work/runs": "directory",
    "/work/empty": "directory",
  };
  function logDeps(configured: string | undefined): LogDeps {
    return {
      cwd: "/work",
      pathKind: (absolutePath) => files[absolutePath] ?? "missing",
      childRunDirectories: (dir) => (dir === "/work/runs" ? ["/work/runs/today"] : []),
      configuredLog: () => configured,
    };
  }
  const viewer = (pid: number, logPath: string) =>
    liveSessions([live(pid, logPath)], (record) => `/s/${record.pid}.sock`);

  it("--log wins over the configured log", () => {
    expect(chooseLog("runs/today", [], logDeps("log.jsonl"))).toEqual({
      kind: "files",
      logPath: "/work/runs/today/statelog.jsonl",
    });
  });

  it("does not read the config when --log is given", () => {
    const deps: LogDeps = {
      ...logDeps(undefined),
      configuredLog: () => {
        throw new Error("agency.json is broken");
      },
    };
    expect(chooseLog("log.jsonl", [], deps)).toEqual({ kind: "files", logPath: "/work/log.jsonl" });
  });

  it("the one open viewer wins over the configured log", () => {
    const live = viewer(1, "/work/runs/today/statelog.jsonl");
    expect(chooseLog(undefined, live, logDeps("log.jsonl"))).toMatchObject({
      kind: "session",
      session: { record: { pid: 1 } },
    });
  });

  it("uses the configured log, resolved against cwd, when no viewer is open", () => {
    expect(chooseLog(undefined, [], logDeps("log.jsonl"))).toEqual({
      kind: "files",
      logPath: "/work/log.jsonl",
    });
  });

  it("two open viewers still need --log, whatever the config says", () => {
    const live = [...viewer(1, "/a.jsonl"), ...viewer(2, "/b.jsonl")];
    const choice = chooseLog(undefined, live, logDeps("log.jsonl"));
    expect(choice).toMatchObject({ kind: "refused" });
    if (choice.kind === "refused") {
      expect(choice.reason).toContain("2 viewers are open");
    }
  });

  it("an empty logFile counts as unset", () => {
    expect(chooseLog(undefined, [], logDeps(""))).toEqual({
      kind: "refused",
      reason: NO_LOG_GIVEN,
    });
  });

  it("a configured log that is not on disk is refused, naming agency.json", () => {
    expect(chooseLog(undefined, [], logDeps("gone.jsonl"))).toEqual({
      kind: "refused",
      reason: "no log at /work/gone.jsonl (log.logFile in agency.json)",
    });
  });

  it("a directory of run directories is refused with a pointer to the explorer", () => {
    const choice = chooseLog("runs", [], logDeps(undefined));
    expect(choice).toMatchObject({ kind: "refused" });
    if (choice.kind === "refused") {
      expect(choice.reason).toContain("agency logs /work/runs --csv");
    }
  });

  it("a directory with no statelog and no runs is refused as missing", () => {
    expect(chooseLog("empty", [], logDeps(undefined))).toEqual({
      kind: "refused",
      reason: "no log at /work/empty/statelog.jsonl",
    });
  });

  it("with nothing to go on, the refusal names all three ways forward", () => {
    expect(NO_LOG_GIVEN).toContain("--log <file>");
    expect(NO_LOG_GIVEN).toContain("log.logFile in agency.json");
    expect(NO_LOG_GIVEN).toContain("agency logs <file>");
    expect(chooseLog(undefined, [], logDeps(undefined))).toEqual({
      kind: "refused",
      reason: NO_LOG_GIVEN,
    });
  });
});
