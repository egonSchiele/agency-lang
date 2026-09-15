import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadModel } from "../src/kokoroModel.js";
import { modelStatus } from "../src/modelStore.js";
import { speakWith, type SpeakRequest } from "../src/speak.js";
import { VOICES } from "../src/voices.js";
import { makeTempDir, removeTempDir } from "./tempDir.js";

// Needs the fp32 model on disk: run `agency-kokoro pull fp32` first.
const SLOW_TEST_MS = 300_000;

type WavInfo = {
  sampleRate: number;
  bitsPerSample: number;
  seconds: number;
};

function readWav(file: string): WavInfo {
  const view = new DataView(fs.readFileSync(file).buffer);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataBytes = view.getUint32(40, true);
  return { sampleRate, bitsPerSample, seconds: dataBytes / (sampleRate * (bitsPerSample / 8)) };
}

describe.skipIf(!process.env.AGENCY_RUN_SLOW)("kokoro with the real model", () => {
  let workDir: string;
  const signal = new AbortController().signal;
  const request = (name: string, text: string): SpeakRequest => ({
    text,
    outputFile: path.join(workDir, name),
    voice: "af_heart",
    model: "fp32",
    speed: 1,
    allowedPaths: [],
  });

  beforeAll(() => {
    expect(modelStatus("fp32").installed).toBe(true);
    workDir = makeTempDir("kokoro-integration-");
  });

  afterAll(() => {
    removeTempDir(workDir);
  });

  it("speaks one sentence", { timeout: SLOW_TEST_MS }, async () => {
    const info = readWav(
      await speakWith(request("short.wav", "Hello from Agency, running locally."), signal),
    );

    expect(info.sampleRate).toBe(24000);
    expect(info.bitsPerSample).toBe(16);
    expect(info.seconds).toBeGreaterThan(1);
    expect(info.seconds).toBeLessThan(10);
  });

  it("speaks all of a long passage", { timeout: SLOW_TEST_MS }, async () => {
    const text = Array.from(
      { length: 40 },
      (_, index) =>
        `This is sentence number ${index + 1} of a long passage meant to exceed the model's token limit.`,
    ).join(" ");
    const info = readWav(await speakWith(request("long.wav", text), signal));

    // One generate() call on this text returns 28.6 seconds of audio.
    expect(info.seconds).toBeGreaterThan(200);
  });

  it("never touches the network once the model is on disk", { timeout: SLOW_TEST_MS }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("network used"));
    try {
      await speakWith(request("offline.wav", "No network needed."), signal);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("lists the same voices as kokoro-js", { timeout: SLOW_TEST_MS }, async () => {
    const tts = await loadModel("fp32");
    expect(VOICES.map((voice) => voice.id).sort()).toEqual(Object.keys(tts.voices).sort());
  });
});
