import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFfmpegAvailable, buildTranscodeArgs, transcode } from "./ffmpeg.js";
import { wavFile } from "./wavFile.js";

const HEAD = ["-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0"];

describe("buildTranscodeArgs", () => {
  it("writes each format with its own codec arguments", () => {
    expect(buildTranscodeArgs("mp3", 1, "/tmp/x.mp3")).toEqual([
      ...HEAD,
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "96k",
      "-y",
      "/tmp/x.mp3",
    ]);
    expect(buildTranscodeArgs("m4a", 1, "/tmp/x.m4a")).toEqual([
      ...HEAD,
      "-codec:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      "-y",
      "/tmp/x.m4a",
    ]);
    expect(buildTranscodeArgs("wav", 1, "/tmp/x.wav")).toEqual([
      ...HEAD,
      "-codec:a",
      "pcm_s16le",
      "-bitexact",
      "-map_metadata",
      "-1",
      "-y",
      "/tmp/x.wav",
    ]);
    expect(buildTranscodeArgs("pcm", 1, "/tmp/x.pcm")).toEqual([
      ...HEAD,
      "-f",
      "s16le",
      "-codec:a",
      "pcm_s16le",
      "-y",
      "/tmp/x.pcm",
    ]);
  });

  it("adds the atempo filter before the output arguments only when the speed is not 1", () => {
    expect(
      buildTranscodeArgs("wav", 1.5, "/tmp/x.wav").slice(HEAD.length, HEAD.length + 3),
    ).toEqual(["-filter:a", "atempo=1.5", "-codec:a"]);
    expect(buildTranscodeArgs("pcm", 0.5, "/tmp/x.pcm")).toContain("atempo=0.5");
    expect(buildTranscodeArgs("mp3", 1, "/tmp/x.mp3")).not.toContain("-filter:a");
  });
});

describe("without ffmpeg on the PATH", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("assertFfmpegAvailable names the fix", () => {
    vi.stubEnv("PATH", "");
    expect(() => assertFfmpegAvailable()).toThrow(
      /ffmpeg is needed to write mp3 or m4a files, or to change the speed/,
    );
  });

  it("transcode fails instead of hanging", async () => {
    vi.stubEnv("PATH", "");
    const wav = wavFile([Uint8Array.of(0, 0, 1, 0)], 24000);
    await expect(transcode(wav, "mp3", 1, new AbortController().signal)).rejects.toThrow(
      /ffmpeg is not on PATH/,
    );
  });
});

it("transcode rejects with the abort reason when the signal already fired, before starting ffmpeg", async () => {
  vi.stubEnv("PATH", "");
  const controller = new AbortController();
  const reason = new Error("cancelled by test");
  controller.abort(reason);
  const wav = wavFile([Uint8Array.of(0, 0)], 24000);
  try {
    await expect(transcode(wav, "mp3", 1, controller.signal)).rejects.toBe(reason);
  } finally {
    vi.unstubAllEnvs();
  }
});
