import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/modelManager.js", () => ({
  ensureModel: vi.fn(),
  resolveModelPath: vi.fn(),
}));
vi.mock("../src/ffmpeg.js", () => ({
  decodeToPcm: vi.fn(),
}));
vi.mock("../src/addon.js", () => {
  const WhisperModel = vi.fn();
  return { loadAddon: () => ({ WhisperModel }) };
});

import * as modelManager from "../src/modelManager.js";
import * as ffmpeg from "../src/ffmpeg.js";
import { transcribe, _clearHandleCache } from "../src/transcribe.js";
import * as addonMod from "../src/addon.js";

describe("transcribe", () => {
  let mockInstance: { transcribe: ReturnType<typeof vi.fn>; free: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    _clearHandleCache();
    vi.mocked(modelManager.ensureModel).mockResolvedValue(
      "/path/to/ggml-base.bin",
    );
    vi.mocked(ffmpeg.decodeToPcm).mockResolvedValue(
      new Float32Array([0.1, 0.2]),
    );
    mockInstance = {
      transcribe: vi.fn().mockResolvedValue(["hello ", "world"]),
      free: vi.fn(),
    };
    const { WhisperModel } = addonMod.loadAddon();
    (WhisperModel as unknown as ReturnType<typeof vi.fn>).mockReset();
    (WhisperModel as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => mockInstance,
    );
  });

  it("joins segments and returns the text", async () => {
    const out = await transcribe("audio.m4a", "en", "base");
    expect(out).toBe("hello world");
  });

  it("forwards language and uses default model", async () => {
    await transcribe("audio.m4a", "en");
    expect(modelManager.ensureModel).toHaveBeenCalledWith("base");
    expect(mockInstance.transcribe).toHaveBeenCalledWith(
      expect.any(Float32Array),
      { language: "en", translate: false },
    );
  });

  it("caches model handles across calls", async () => {
    await transcribe("audio1.m4a", "en", "base");
    await transcribe("audio2.m4a", "en", "base");
    const { WhisperModel } = addonMod.loadAddon();
    expect(WhisperModel).toHaveBeenCalledTimes(1);
  });

  it("rejects empty filepath", async () => {
    await expect(transcribe("", "en", "base")).rejects.toThrow(/filepath/);
  });
});

describe("_clearHandleCache error handling", () => {
  beforeEach(() => {
    _clearHandleCache();
    vi.mocked(modelManager.ensureModel).mockResolvedValue(
      "/path/to/ggml-base.bin",
    );
    vi.mocked(ffmpeg.decodeToPcm).mockResolvedValue(
      new Float32Array([0.1, 0.2]),
    );
  });

  it("continues clearing the cache when free() throws (e.g. busy)", async () => {
    // Set up an instance whose free() throws (mimicking the C++ "busy" error).
    const throwingInstance = {
      transcribe: vi.fn().mockResolvedValue(["x"]),
      free: vi.fn().mockImplementation(() => {
        throw new Error("WhisperModel busy");
      }),
    };
    const { WhisperModel } = addonMod.loadAddon();
    (WhisperModel as unknown as ReturnType<typeof vi.fn>).mockReset();
    (WhisperModel as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => throwingInstance,
    );

    // Populate the cache.
    await transcribe("audio.m4a", "en", "base");
    expect(throwingInstance.free).not.toHaveBeenCalled();

    // _clearHandleCache should call free (which throws) but still clear the cache.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => _clearHandleCache()).not.toThrow();
    expect(throwingInstance.free).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/failed to free model.*WhisperModel busy/),
    );
    warnSpy.mockRestore();

    // After clearing, a subsequent transcribe should construct a fresh handle.
    const freshInstance = {
      transcribe: vi.fn().mockResolvedValue(["y"]),
      free: vi.fn(),
    };
    (WhisperModel as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => freshInstance,
    );
    await transcribe("audio2.m4a", "en", "base");
    expect(freshInstance.transcribe).toHaveBeenCalled();
  });
});
