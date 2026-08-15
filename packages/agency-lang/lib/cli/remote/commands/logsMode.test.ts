import { describe, it, expect } from "vitest";
import { resolveRemoteLogsMode, requireRemoteLogsEnvironment } from "./logsMode.js";

describe("resolveRemoteLogsMode", () => {
  it("bare → fetch viewer, no trace", () => {
    expect(resolveRemoteLogsMode(undefined, {})).toEqual({
      kind: "fetch",
      traceId: undefined,
      output: "viewer",
    });
  });

  it("--json → fetch json", () => {
    expect(resolveRemoteLogsMode(undefined, { json: true })).toEqual({
      kind: "fetch",
      traceId: undefined,
      output: "json",
    });
  });

  it("an explicit trace → fetch viewer for that trace", () => {
    expect(resolveRemoteLogsMode("t1", {})).toEqual({
      kind: "fetch",
      traceId: "t1",
      output: "viewer",
    });
  });

  it("--list → list; --list --json → list json", () => {
    expect(resolveRemoteLogsMode(undefined, { list: true })).toEqual({ kind: "list", json: false });
    expect(resolveRemoteLogsMode(undefined, { list: true, json: true })).toEqual({
      kind: "list",
      json: true,
    });
  });

  it("rejects a trace id combined with --list", () => {
    expect(() => resolveRemoteLogsMode("t1", { list: true })).toThrow();
  });

  it("rejects an explicit empty trace id", () => {
    expect(() => resolveRemoteLogsMode("", {})).toThrow();
  });
});

describe("requireRemoteLogsEnvironment", () => {
  const tty = { stdinIsTTY: true, stdoutIsTTY: true };
  const noStdin = { stdinIsTTY: false, stdoutIsTTY: true };
  const noStdout = { stdinIsTTY: true, stdoutIsTTY: false };

  it("viewer mode requires both stdin and stdout TTYs", () => {
    const viewer = resolveRemoteLogsMode(undefined, {});
    expect(() => requireRemoteLogsEnvironment(viewer, tty)).not.toThrow();
    expect(() => requireRemoteLogsEnvironment(viewer, noStdin)).toThrow(/--json/);
    expect(() => requireRemoteLogsEnvironment(viewer, noStdout)).toThrow(/--json/);
  });

  it("list and json modes accept any terminal", () => {
    expect(() =>
      requireRemoteLogsEnvironment(resolveRemoteLogsMode(undefined, { list: true }), noStdin),
    ).not.toThrow();
    expect(() =>
      requireRemoteLogsEnvironment(resolveRemoteLogsMode(undefined, { json: true }), noStdout),
    ).not.toThrow();
  });
});
