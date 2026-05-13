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
import { transcribe } from "../src/transcribe.js";
import {
  _clearHandleCache,
  acquireHandle,
  isCached,
  handleCache,
} from "../src/handleCache.js";
import * as addonMod from "../src/addon.js";

type Mocked = ReturnType<typeof vi.fn>;

function newMockInstance(segments: string[] = ["hello ", "world"]) {
  return {
    transcribe: vi.fn().mockResolvedValue(segments),
    free: vi.fn(),
  };
}

describe("transcribe", () => {
  let mockInstance: ReturnType<typeof newMockInstance>;

  beforeEach(() => {
    _clearHandleCache();
    delete process.env.AGENCY_WHISPER_HANDLE_CACHE_MAX;
    vi.mocked(modelManager.ensureModel).mockResolvedValue(
      "/path/to/ggml-base.bin",
    );
    vi.mocked(ffmpeg.decodeToPcm).mockResolvedValue(
      new Float32Array([0.1, 0.2]),
    );
    mockInstance = newMockInstance();
    const { WhisperModel } = addonMod.loadAddon();
    (WhisperModel as unknown as Mocked).mockReset();
    (WhisperModel as unknown as Mocked).mockImplementation(() => mockInstance);
  });

  it("joins segments and returns the text", async () => {
    const out = await transcribe("audio.m4a", "en", "base.en");
    expect(out).toBe("hello world");
  });

  it("forwards language and uses default model", async () => {
    await transcribe("audio.m4a", "en");
    expect(modelManager.ensureModel).toHaveBeenCalledWith("base.en");
    expect(mockInstance.transcribe).toHaveBeenCalledWith(
      expect.any(Float32Array),
      { language: "en", translate: false },
    );
  });

  it("caches model handles across calls", async () => {
    await transcribe("audio1.m4a", "en", "base.en");
    await transcribe("audio2.m4a", "en", "base.en");
    const { WhisperModel } = addonMod.loadAddon();
    expect(WhisperModel).toHaveBeenCalledTimes(1);
  });

  it("rejects empty filepath", async () => {
    await expect(transcribe("", "en", "base.en")).rejects.toThrow(/filepath/);
  });

  it("does not cache when AGENCY_WHISPER_HANDLE_CACHE_MAX=0 (frees per call)", async () => {
    process.env.AGENCY_WHISPER_HANDLE_CACHE_MAX = "0";
    await transcribe("audio.m4a", "en", "base.en");
    expect(mockInstance.free).toHaveBeenCalledOnce();
    expect(isCached("/path/to/ggml-base.bin")).toBe(false);
  });
});

describe("handleCache LRU eviction", () => {
  beforeEach(() => {
    _clearHandleCache();
    delete process.env.AGENCY_WHISPER_HANDLE_CACHE_MAX;
  });

  it("evicts the least-recently-used entry when the cap is reached", () => {
    process.env.AGENCY_WHISPER_HANDLE_CACHE_MAX = "2";
    const a = newMockInstance();
    const b = newMockInstance();
    const c = newMockInstance();
    acquireHandle("A", () => a);
    acquireHandle("B", () => b);
    expect(Object.keys(handleCache)).toEqual(["A", "B"]);

    // Touch A so B becomes LRU.
    acquireHandle("A", () => a);
    expect(Object.keys(handleCache)).toEqual(["B", "A"]);

    // Inserting C should evict B (LRU), free B, and keep [A, C].
    acquireHandle("C", () => c);
    expect(b.free).toHaveBeenCalledOnce();
    expect(a.free).not.toHaveBeenCalled();
    expect(Object.keys(handleCache)).toEqual(["A", "C"]);
  });

  it("stays bounded across many distinct keys", () => {
    process.env.AGENCY_WHISPER_HANDLE_CACHE_MAX = "3";
    const made: ReturnType<typeof newMockInstance>[] = [];
    for (let i = 0; i < 50; i++) {
      const m = newMockInstance();
      made.push(m);
      acquireHandle(`K${i}`, () => m);
    }
    expect(Object.keys(handleCache).length).toBe(3);
    // The first 47 should have been freed; the last 3 should still be cached.
    for (let i = 0; i < 47; i++) {
      expect(made[i].free).toHaveBeenCalledOnce();
    }
    for (let i = 47; i < 50; i++) {
      expect(made[i].free).not.toHaveBeenCalled();
    }
  });

  it("logs a warning but still evicts when free() throws (busy)", () => {
    process.env.AGENCY_WHISPER_HANDLE_CACHE_MAX = "1";
    const busy = {
      transcribe: vi.fn(),
      free: vi.fn().mockImplementation(() => {
        throw new Error("WhisperModel busy");
      }),
    };
    const next = newMockInstance();
    acquireHandle("BUSY", () => busy);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    acquireHandle("NEXT", () => next);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/failed to free model.*BUSY.*WhisperModel busy/),
    );
    expect(Object.keys(handleCache)).toEqual(["NEXT"]);
    warnSpy.mockRestore();
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
    (WhisperModel as unknown as Mocked).mockReset();
    (WhisperModel as unknown as Mocked).mockImplementation(
      () => throwingInstance,
    );

    // Populate the cache.
    await transcribe("audio.m4a", "en", "base.en");
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
    (WhisperModel as unknown as Mocked).mockImplementation(
      () => freshInstance,
    );
    await transcribe("audio2.m4a", "en", "base.en");
    expect(freshInstance.transcribe).toHaveBeenCalled();
  });
});
