import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

vi.mock("node:child_process");
import { spawn } from "node:child_process";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  return {
    ...actual,
    stat: vi.fn(),
  };
});
import * as fsp from "node:fs/promises";

import { buildFfmpegArgs, decodeToPcm } from "../src/ffmpeg.js";

function fakeFileStat(): import("node:fs").Stats {
  return {
    isFile: () => true,
    isDirectory: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as unknown as import("node:fs").Stats;
}

describe("buildFfmpegArgs", () => {
  it("emits the expected pipeline for a given input", () => {
    expect(buildFfmpegArgs("/path/to/input.m4a")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-protocol_whitelist",
      "file",
      "-i",
      "/path/to/input.m4a",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "f32le",
      "-",
    ]);
  });
});

describe("decodeToPcm", () => {
  function mockSpawn(opts: {
    exitCode: number;
    stdoutChunks?: Buffer[];
    stderrText?: string;
    emitError?: Error;
    closeDelayMs?: number;
    neverClose?: boolean;
  }) {
    const proc = new EventEmitter() as unknown as {
      stdout: Readable;
      stderr: Readable;
      stdin: Writable;
      kill: (sig?: string) => void;
      emit: (event: string, ...args: unknown[]) => boolean;
    };
    (proc as unknown as { stdout: Readable }).stdout = Readable.from(
      opts.stdoutChunks ?? [],
    );
    (proc as unknown as { stderr: Readable }).stderr = Readable.from([
      Buffer.from(opts.stderrText ?? ""),
    ]);
    (proc as unknown as { stdin: Writable }).stdin = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    let killed = false;
    (proc as unknown as { kill: (sig?: string) => void }).kill = () => {
      if (killed) return;
      killed = true;
      // Mimic the real child_process behavior: a killed process eventually
      // fires "close" with a null exit code. The kill() handler in the
      // production code tags killReason; we just need the close to happen.
      setImmediate(() => proc.emit("close", null));
    };
    if (opts.emitError) {
      setImmediate(() => proc.emit("error", opts.emitError!));
    } else if (!opts.neverClose) {
      const fire = () => proc.emit("close", opts.exitCode);
      if (opts.closeDelayMs) setTimeout(fire, opts.closeDelayMs);
      else setImmediate(fire);
    }
    (spawn as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(proc);
    return proc;
  }

  beforeEach(() => {
    vi.mocked(spawn).mockReset();
    vi.mocked(fsp.stat).mockReset();
    vi.mocked(fsp.stat).mockResolvedValue(fakeFileStat());
  });

  it("returns a Float32Array from ffmpeg stdout", async () => {
    const f32 = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    mockSpawn({ exitCode: 0, stdoutChunks: [Buffer.from(f32.buffer)] });
    const out = await decodeToPcm("/in.wav");
    expect(Array.from(out)).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(-0.2, 6),
      expect.closeTo(0.3, 6),
      expect.closeTo(-0.4, 6),
    ]);
  });

  it("throws FfmpegError if ffmpeg is missing", async () => {
    mockSpawn({
      exitCode: 0,
      emitError: Object.assign(new Error("spawn ffmpeg ENOENT"), {
        code: "ENOENT",
      }),
    });
    await expect(decodeToPcm("/in.wav")).rejects.toThrow(/ffmpeg not found/);
  });

  it("throws FfmpegError with stderr on non-zero exit", async () => {
    mockSpawn({ exitCode: 1, stderrText: "ffmpeg: invalid file format\n" });
    await expect(decodeToPcm("/in.wav")).rejects.toThrow(/invalid file format/);
  });

  it("rejects when stdout byte length is not a multiple of 4", async () => {
    // 7 bytes is not a multiple of float-32 size. Real ffmpeg would never
    // produce this, but the guard exists in case ffmpeg is misconfigured or
    // the format flag changes.
    mockSpawn({ exitCode: 0, stdoutChunks: [Buffer.from([1, 2, 3, 4, 5, 6, 7])] });
    await expect(decodeToPcm("/in.wav")).rejects.toThrow(/multiple of 4/);
  });

  it("correctly reassembles a Float32Array split across multiple stdout chunks", async () => {
    // Real ffmpeg produces output in many chunks; Buffer.concat joins them.
    // Split a known Float32Array into two chunks at a non-aligned boundary.
    const f32 = new Float32Array([1.5, -2.5, 3.5, -4.5]);
    const full = Buffer.from(f32.buffer);
    const chunkA = full.subarray(0, 6); // 6 bytes — splits the second float
    const chunkB = full.subarray(6);
    mockSpawn({ exitCode: 0, stdoutChunks: [chunkA, chunkB] });
    const out = await decodeToPcm("/in.wav");
    expect(Array.from(out)).toEqual([1.5, -2.5, 3.5, -4.5]);
  });

  it("rejects paths starting with '-' before spawning ffmpeg", async () => {
    await expect(decodeToPcm("-version")).rejects.toThrow(/starts with '-'/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects when input is not a regular file (e.g. directory or device)", async () => {
    vi.mocked(fsp.stat).mockResolvedValueOnce({
      ...fakeFileStat(),
      isFile: () => false,
    } as unknown as import("node:fs").Stats);
    await expect(decodeToPcm("/tmp")).rejects.toThrow(/not a regular file/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects when input file does not exist", async () => {
    vi.mocked(fsp.stat).mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    await expect(decodeToPcm("/no/such/file.wav")).rejects.toThrow(
      /input file not found/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills ffmpeg and rejects on timeout", async () => {
    mockSpawn({ exitCode: 0, neverClose: true });
    await expect(decodeToPcm("/in.wav", { timeoutMs: 25 })).rejects.toThrow(
      /exceeded timeout of 25 ms/,
    );
  });

  it("kills ffmpeg and rejects when decoded output exceeds the cap", async () => {
    // Each chunk is 8 bytes (= 2 floats). Cap at 4 bytes so the first chunk
    // already trips the threshold; production code calls kill() which fires a
    // synthetic close with no exit code.
    const chunk = Buffer.from(new Float32Array([1.0, 2.0]).buffer);
    mockSpawn({ exitCode: 0, stdoutChunks: [chunk] });
    await expect(
      decodeToPcm("/in.wav", { maxPcmBytes: 4 }),
    ).rejects.toThrow(/exceeded cap of 4 bytes/);
  });
});
