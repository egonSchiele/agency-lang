import { describe, expect, it } from "vitest";

import type { ProbedRecord } from "@/logsViewer/session/registry.js";
import type { CommentsStore } from "@/runDirectory/commentsStore.js";

import { resolveTarget, type TargetDeps } from "./target.js";

const author = { kind: "agent" as const, id: "claude" };
const deps: TargetDeps = {
  socketPathFor: (record) => `/s/${record.pid}.sock`,
  openStore: (commentsPath) => ({ path: commentsPath }) as CommentsStore,
  author,
  cwd: "/work",
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
  });

  describe("choosing a trace and a row", () => {
    const session = [live(1, "/logs/a.jsonl", "/logs/a.comments")];

    it("an address names both", () => {
      expect(resolveTarget({ row: "k3Pq/round:s1:2" }, session, deps)).toMatchObject({
        traceId: "k3Pq",
        rowId: "round:s1:2",
      });
    });

    it("a bare row id takes --trace, else the viewer's trace, else nothing", () => {
      expect(resolveTarget({ row: "round:s1:2", traceId: "flag" }, session, deps)).toMatchObject({
        traceId: "flag",
        rowId: "round:s1:2",
      });
      expect(resolveTarget({ row: "round:s1:2" }, session, deps)).toMatchObject({
        traceId: "focused",
      });
      expect(resolveTarget({ row: "round:s1:2", log: "/logs/x.jsonl" }, [], deps)).toMatchObject({
        kind: "files",
        traceId: undefined,
        rowId: "round:s1:2",
      });
    });

    it("a malformed address is refused", () => {
      expect(resolveTarget({ row: "/round:s1:2" }, session, deps)).toMatchObject({
        kind: "refused",
      });
    });
  });
});
