import { describe, it, expect, beforeEach } from "vitest";
import { detectClipboard, resetClipboardCache } from "./clipboard.js";
import type { SpawnSyncReturns } from "node:child_process";

type SpawnArgs = { cmd: string; args: string[]; input?: string };

function makeSpawn(present: string[]) {
  const calls: SpawnArgs[] = [];
  const fakeSpawn = (cmd: string, args?: string[], opts?: any): SpawnSyncReturns<string> => {
    calls.push({ cmd, args: args ?? [], input: opts?.input as string | undefined });
    if (!present.includes(cmd)) {
      return {
        pid: 0,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: null,
        signal: null,
        error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      };
    }
    return {
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    };
  };
  return { fakeSpawn: fakeSpawn as any, calls };
}

describe("detectClipboard", () => {
  beforeEach(() => resetClipboardCache());

  it("returns null when no clipboard backend is available", () => {
    const { fakeSpawn } = makeSpawn([]);
    expect(detectClipboard(fakeSpawn)).toBeNull();
  });

  it("picks pbcopy when present", () => {
    const { fakeSpawn, calls } = makeSpawn(["pbcopy"]);
    const clip = detectClipboard(fakeSpawn);
    expect(clip).not.toBeNull();
    clip!.write("hello");
    const writeCall = calls.find((c) => c.input === "hello");
    expect(writeCall?.cmd).toBe("pbcopy");
  });

  it("picks xclip with the right args when only xclip is available", () => {
    const { fakeSpawn, calls } = makeSpawn(["xclip"]);
    const clip = detectClipboard(fakeSpawn);
    expect(clip).not.toBeNull();
    clip!.write("x");
    const writeCall = calls.find((c) => c.input === "x");
    expect(writeCall?.cmd).toBe("xclip");
    expect(writeCall?.args).toEqual(["-selection", "clipboard"]);
  });

  it("caches the chosen backend across calls", () => {
    const { fakeSpawn, calls } = makeSpawn(["pbcopy"]);
    detectClipboard(fakeSpawn);
    const probeCalls = calls.length;
    detectClipboard(fakeSpawn);
    // Second call should not re-probe.
    expect(calls.length).toBe(probeCalls);
  });
});
