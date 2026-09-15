import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { speakWith, type SpeakRequest } from "../src/speak.js";
import { hasFfmpeg } from "./ffmpegPresent.js";
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
    const modelsDir = path.join(workDir, "models");
    recordInstalledModel("fp32", modelsDir);
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
      format: "wav",
      modelsDir,
    };
  });

  afterEach(() => {
    removeTempDir(workDir);
  });

  it("names a temp file after the format when no output file is given", async () => {
    const written = await speakWith({ ...request, outputFile: "" }, new AbortController().signal);

    expect(path.basename(written)).toMatch(/^agency-kokoro-.*\.wav$/);
    fs.unlinkSync(written);
  });

  describe.skipIf(!hasFfmpeg())("with ffmpeg", () => {
    it("writes an mp3", async () => {
      const mp3 = { ...request, outputFile: path.join(workDir, "out.mp3"), format: "mp3" as const };

      const written = await speakWith(mp3, new AbortController().signal);

      const bytes = fs.readFileSync(written);
      expect(bytes.subarray(0, 3).toString("ascii")).toBe("ID3");
    });

    it("writes an m4a, whatever the output file's extension says", async () => {
      const m4a = { ...request, format: "m4a" as const };

      const written = await speakWith(m4a, new AbortController().signal);

      expect(written).toBe(request.outputFile);
      const bytes = fs.readFileSync(written);
      expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");
    });
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

  it("looks for the model in the request's directory", async () => {
    const elsewhere = { ...request, modelsDir: path.join(workDir, "empty") };

    await expect(speakWith(elsewhere, new AbortController().signal)).rejects.toThrow(
      /fp32 model is not installed/,
    );
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
