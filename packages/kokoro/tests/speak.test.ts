import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { speakWith, type SpeakRequest } from "../src/speak.js";
import { recordInstalledModel } from "./installedModel.js";
import { makeTempDir, removeTempDir } from "./tempDir.js";

const { generate, fromPretrained } = vi.hoisted(() => {
  const generate = vi.fn();
  return { generate, fromPretrained: vi.fn(async () => ({ generate })) };
});

vi.mock("kokoro-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("kokoro-js")>()),
  KokoroTTS: { from_pretrained: fromPretrained },
}));

describe("speakWith", () => {
  let workDir: string;
  let request: SpeakRequest;

  beforeEach(() => {
    workDir = makeTempDir("kokoro-speak-");
    vi.stubEnv("AGENCY_KOKORO_MODELS_DIR", path.join(workDir, "models"));
    recordInstalledModel("fp32");
    generate.mockReset();
    generate.mockResolvedValue({ audio: Float32Array.of(0.5, -0.5) });
    fromPretrained.mockClear();
    request = {
      text: "First sentence. Second sentence. Third sentence.",
      outputFile: path.join(workDir, "out.wav"),
      voice: "af_heart",
      model: "fp32",
      speed: 1,
      allowedPaths: [],
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    removeTempDir(workDir);
  });

  it("writes one WAV file from every sentence and returns its path", async () => {
    const written = await speakWith(request, new AbortController().signal);

    expect(written).toBe(request.outputFile);
    expect(generate).toHaveBeenCalledTimes(3);
    const bytes = fs.readFileSync(written);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.length).toBe(44 + 3 * 2 * 2);
  });

  it("refuses an existing file before loading the model", async () => {
    fs.writeFileSync(request.outputFile, "keep me");

    await expect(speakWith(request, new AbortController().signal)).rejects.toThrow(
      /already exists/,
    );
    expect(fromPretrained).not.toHaveBeenCalled();
    expect(fs.readFileSync(request.outputFile, "utf8")).toBe("keep me");
  });

  it("refuses to run without the model, and never downloads", async () => {
    await expect(
      speakWith({ ...request, model: "q8" }, new AbortController().signal),
    ).rejects.toThrow(/q8 model is not installed/);
    expect(fromPretrained).not.toHaveBeenCalled();
  });

  it("refuses a path outside allowedPaths", async () => {
    const allowed = { ...request, allowedPaths: [path.join(workDir, "reports")] };

    await expect(speakWith(allowed, new AbortController().signal)).rejects.toThrow();
    expect(fs.existsSync(request.outputFile)).toBe(false);
  });

  it("stops between sentences when cancelled, and writes nothing", async () => {
    const controller = new AbortController();
    generate.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled by test"));
      return { audio: Float32Array.of(0.5) };
    });

    await expect(speakWith(request, controller.signal)).rejects.toThrow("cancelled by test");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(request.outputFile)).toBe(false);
  });
});
