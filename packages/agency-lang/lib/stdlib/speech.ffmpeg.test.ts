// Runs the real ffmpeg. The cases skip when ffmpeg is missing, unless
// AGENCY_REQUIRE_FFMPEG=1 is set, as it is in the CI job that installs it.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agencyStore } from "../runtime/asyncContext.js";
import { InvocationUsageMeter } from "../runtime/invocationUsage.js";
import { transcode } from "./ffmpeg.js";
import { _speakLocal } from "./speech.js";
import { wavFile } from "./wavFile.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error === undefined;
const required = process.env.AGENCY_REQUIRE_FFMPEG === "1";

it("ffmpeg is on the PATH when AGENCY_REQUIRE_FFMPEG=1", () => {
  if (required) {
    expect(hasFfmpeg).toBe(true);
  }
});

const SAMPLE_RATE = 24000;
const WAV_HEADER_BYTES = 44;

/** Two seconds of a 440 Hz tone, as 16-bit little-endian mono PCM. */
function tone(): Uint8Array {
  const samples = new Int16Array(2 * SAMPLE_RATE);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
  }
  return new Uint8Array(samples.buffer);
}

/** The length of a wav file's `data` chunk. */
function dataChunkBytes(wav: Uint8Array): number {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = String.fromCharCode(...wav.slice(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      return size;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

describe.skipIf(!hasFfmpeg && !required)("with ffmpeg", () => {
  const pcm = tone();
  const wav = wavFile([pcm], SAMPLE_RATE);
  const signal = new AbortController().signal;

  it("encodes mp3 and m4a", async () => {
    const mp3 = await transcode(wav, "mp3", 1, signal);
    const m4a = await transcode(wav, "m4a", 1, signal);
    const mp3Start = ascii(mp3, 0, 3) === "ID3" || (mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0);
    expect(mp3Start).toBe(true);
    expect(ascii(m4a, 4, 8)).toBe("ftyp");
    expect(mp3.length).toBeLessThan(wav.length / 2);
  });

  it("writes a plain wav, and halves its samples at speed 2", async () => {
    const same = await transcode(wav, "wav", 1, signal);
    expect(ascii(same, 0, 4)).toBe("RIFF");
    expect(dataChunkBytes(same)).toBe(pcm.length);
    expect(same.length).toBe(WAV_HEADER_BYTES + pcm.length);

    const fast = await transcode(wav, "wav", 2, signal);
    const ratio = dataChunkBytes(fast) / pcm.length;
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });

  it("writes raw pcm with no header at speed 1.5", async () => {
    const out = await transcode(wav, "pcm", 1.5, signal);
    expect(ascii(out, 0, 4)).not.toBe("RIFF");
    expect(out.length % 2).toBe(0);
    const ratio = out.length / pcm.length;
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(0.73);
  });

  describe("_speakLocal", () => {
    let root = "";
    beforeEach(async () => {
      root = await mkdtemp(path.join(realpathSync(os.tmpdir()), "agency-speech-ffmpeg-"));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("writes an mp3 from the server's pcm", async () => {
      const store = {
        ctx: {
          llmClient: {
            speak: async () => ({
              success: true,
              value: {
                audio: pcm,
                mimeType: "application/octet-stream",
                pcm: { sampleRateHz: SAMPLE_RATE, sampleFormat: "s16le", channels: 1 },
                cost: { inputCost: 0, outputCost: 0, totalCost: 0, currency: "USD" },
              },
            }),
          },
          statelogClient: { speechSynthesis: async () => undefined },
          invocationUsage: new InvocationUsageMeter(),
          getAbortSignal: () => signal,
        },
        stack: {
          localCost: 0,
          localTokens: 0,
          billCharge: () => undefined,
          chargeGuards: () => undefined,
          enforceGuards: () => undefined,
        },
        threads: {},
        globals: {},
        callsite: { moduleId: "test", scopeName: "main", stepPath: "" },
      } as any;
      const out = path.join(root, "hello.mp3");
      await agencyStore.run(store, () =>
        _speakLocal("Hello there.", out, "qwen3-tts-mlx", "", "", "", [root], 1),
      );
      const bytes = new Uint8Array(await readFile(out));
      expect(bytes.length).toBeGreaterThan(1000);
      expect(ascii(bytes, 0, 3) === "ID3" || bytes[0] === 0xff).toBe(true);
    });
  });
});
