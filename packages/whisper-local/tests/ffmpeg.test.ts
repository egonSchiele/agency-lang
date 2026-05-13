import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

vi.mock("node:child_process");
import { spawn } from "node:child_process";

import { buildFfmpegArgs, decodeToPcm } from "../src/ffmpeg.js";

describe("buildFfmpegArgs", () => {
  it("emits the expected pipeline for a given input", () => {
    expect(buildFfmpegArgs("/path/to/input.m4a")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
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
  }) {
    const proc = new EventEmitter() as unknown as {
      stdout: Readable;
      stderr: Readable;
      stdin: Writable;
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
    setImmediate(() => {
      if (opts.emitError) proc.emit("error", opts.emitError);
      else proc.emit("close", opts.exitCode);
    });
    (spawn as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(proc);
    return proc;
  }

  beforeEach(() => {
    vi.mocked(spawn).mockReset();
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
});
