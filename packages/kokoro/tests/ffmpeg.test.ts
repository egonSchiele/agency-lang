import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFfmpegAvailable, buildEncodeArgs, encodeWithFfmpeg } from "../src/ffmpeg.js";
import { encodeWav } from "../src/wav.js";
import { hasFfmpeg } from "./ffmpegPresent.js";

describe("buildEncodeArgs", () => {
  it("reads wav from stdin and writes the chosen codec", () => {
    expect(buildEncodeArgs("mp3", "/tmp/x.mp3")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "wav",
      "-i",
      "pipe:0",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "96k",
      "-y",
      "/tmp/x.mp3",
    ]);
    expect(buildEncodeArgs("m4a", "/tmp/x.m4a")).toContain("aac");
  });
});

describe("without ffmpeg on the PATH", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("assertFfmpegAvailable names the fix", () => {
    vi.stubEnv("PATH", "");
    expect(() => assertFfmpegAvailable()).toThrow(/ffmpeg is needed to write mp3 and m4a files/);
  });

  it("encodeWithFfmpeg fails instead of hanging", async () => {
    vi.stubEnv("PATH", "");
    const wav = encodeWav([Int16Array.of(0, 1000, -1000)], 24000);
    await expect(encodeWithFfmpeg(wav, "mp3", new AbortController().signal)).rejects.toThrow(
      /ffmpeg is not on PATH/,
    );
  });
});

describe.skipIf(!hasFfmpeg())("with ffmpeg", () => {
  // Five seconds of a flat tone. At 96 kbit/s each encoded file is about a
  // third of the WAV, whose 16-bit samples at 24 kHz cost 384 kbit/s.
  const wav = encodeWav([new Int16Array(5 * 24000).fill(3000)], 24000);

  it("encodes five seconds of audio to mp3 and m4a", async () => {
    const signal = new AbortController().signal;

    const mp3 = await encodeWithFfmpeg(wav, "mp3", signal);
    const m4a = await encodeWithFfmpeg(wav, "m4a", signal);

    expect(Buffer.from(mp3.subarray(0, 3)).toString("ascii")).toBe("ID3");
    expect(Buffer.from(m4a.subarray(4, 8)).toString("ascii")).toBe("ftyp");
    expect(mp3.length).toBeLessThan(wav.length / 2);
    expect(m4a.length).toBeLessThan(wav.length / 2);
  });

  it("reports a cancelled encode as cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));

    await expect(encodeWithFfmpeg(wav, "mp3", controller.signal)).rejects.toThrow(
      "cancelled by test",
    );
  });
});
