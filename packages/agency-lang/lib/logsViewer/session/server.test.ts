import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { request } from "./client.js";
import type { SessionPort } from "./port.js";
import { listRecords, recordPaths } from "./registry.js";
import { isUnavailable, startSessionServer, type SessionServer } from "./server.js";

function fakePort(): SessionPort & { navigated: string[]; reloads: number } {
  const port = {
    navigated: [] as string[],
    reloads: 0,
    focus: () => ({ traceId: "abc", screen: "trace" as const, rowId: "round:s2:0" }),
    navigate: (traceId: string, rowId: string | undefined) => {
      port.navigated.push(`${traceId}/${rowId ?? ""}`);
      return rowId === "nope" ? ("no such row" as const) : ("ok" as const);
    },
    reloadComments: () => {
      port.reloads += 1;
    },
    notify: () => {},
  };
  return port;
}

describe("the session server", () => {
  let dir: string;
  let server: SessionServer | undefined;
  beforeEach(() => {
    // A short path: the socket path limit is 104 bytes on macOS.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-"));
  });
  afterEach(async () => {
    await server?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("answers get, navigate and reload through the port, and writes its record", async () => {
    const port = fakePort();
    const started = await startSessionServer(port, {
      dir,
      logPath: "/logs/run.jsonl",
      commentsPath: "/logs/run.jsonl.comments.jsonl",
      pid: 4242,
    });
    expect(isUnavailable(started)).toBe(false);
    if (isUnavailable(started)) return;
    server = started;
    expect(listRecords(dir)).toEqual([
      expect.objectContaining({ pid: 4242, logPath: "/logs/run.jsonl" }),
    ]);

    const got = await request(started.socketPath, { op: "get" });
    expect(got).toEqual({
      ok: true,
      focus: {
        traceId: "abc",
        screen: "trace",
        rowId: "round:s2:0",
        logPath: "/logs/run.jsonl",
        commentsPath: "/logs/run.jsonl.comments.jsonl",
      },
    });
    expect(
      await request(started.socketPath, { op: "navigate", traceId: "abc", rowId: "r" }),
    ).toEqual({ ok: true });
    expect(
      await request(started.socketPath, { op: "navigate", traceId: "abc", rowId: "nope" }),
    ).toEqual({ ok: false, error: "no such row" });
    expect(port.navigated).toEqual(["abc/r", "abc/nope"]);
    expect(await request(started.socketPath, { op: "reload" })).toEqual({ ok: true });
    expect(port.reloads).toBe(1);
  });

  it("rejects a malformed request and stays up; stop removes the record and socket", async () => {
    const started = await startSessionServer(fakePort(), {
      dir,
      logPath: "/logs/run.jsonl",
      commentsPath: undefined,
      pid: 4243,
    });
    if (isUnavailable(started)) throw new Error(started.unavailable);
    server = started;
    const sock = started.socketPath;
    expect(await request(sock, { op: "dance" } as never)).toMatchObject({ ok: false });
    expect(await request(sock, { op: "get" })).toMatchObject({ ok: true });

    await started.stop();
    server = undefined;
    expect(fs.existsSync(recordPaths(dir, 4243).json)).toBe(false);
    expect(fs.existsSync(sock)).toBe(false);
  });

  it("replaces a leftover socket at its own pid's path", async () => {
    fs.writeFileSync(recordPaths(dir, 4244).sock, "");
    fs.writeFileSync(recordPaths(dir, 4244).json, "{}");
    const started = await startSessionServer(fakePort(), {
      dir,
      logPath: "/logs/run.jsonl",
      commentsPath: undefined,
      pid: 4244,
    });
    if (isUnavailable(started)) throw new Error(started.unavailable);
    server = started;
    expect(await request(started.socketPath, { op: "get" })).toMatchObject({ ok: true });
  });

  it("refuses an over-long socket path with a message that says what to do", async () => {
    const long = path.join(dir, "x".repeat(120));
    const started = await startSessionServer(fakePort(), {
      dir: long,
      logPath: "/logs/run.jsonl",
      commentsPath: undefined,
      pid: 4245,
    });
    expect(isUnavailable(started)).toBe(true);
    if (isUnavailable(started)) {
      expect(started.unavailable).toContain("AGENCY_AGENT_HOME");
    }
  });
});
