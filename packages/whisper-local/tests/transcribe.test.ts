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
    // Clear call history on every mock so each test sees a clean slate.
    // Without this, `toHaveBeenCalledWith("base.en")` would pass spuriously
    // any time *any earlier test in this file* called transcribe with the
    // default model, regardless of what the current test does.
    vi.clearAllMocks();
    vi.mocked(modelManager.ensureModel).mockResolvedValue(
      "/path/to/ggml-base.bin",
    );
    vi.mocked(ffmpeg.decodeToPcm).mockResolvedValue(
      new Float32Array([0.1, 0.2]),
    );
    mockInstance = newMockInstance();
    const { WhisperModel } = addonMod.loadAddon();
    (WhisperModel as unknown as Mocked).mockImplementation(() => mockInstance);
  });

  it("joins segments and returns the text", async () => {
    const out = await transcribe("audio.m4a", "en", "base.en");
    expect(out).toBe("hello world");
  });

  it("forwards language and uses default model", async () => {
    await transcribe("audio.m4a", "en");
    // toHaveBeenLastCalledWith (not toHaveBeenCalledWith) so we verify the
    // call this test made, not that "base.en" appears anywhere in history.
    expect(modelManager.ensureModel).toHaveBeenLastCalledWith("base.en");
    expect(mockInstance.transcribe).toHaveBeenLastCalledWith(
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

  it("does not pollute the cache when the factory throws", () => {
    // If `new WhisperModel(...)` throws (corrupt model file, OOM, missing
    // GPU, etc.), acquireHandle must not leave a half-initialized entry
    // behind. Otherwise a subsequent transcribe() would reuse an
    // undefined/null instance and crash mysteriously.
    process.env.AGENCY_WHISPER_HANDLE_CACHE_MAX = "2";
    const boom = (): never => {
      throw new Error("model load failed");
    };
    expect(() => acquireHandle("FAIL", boom)).toThrow(/model load failed/);
    expect(Object.keys(handleCache)).toEqual([]);

    // After the failure, a successful acquire should work normally.
    const good = newMockInstance();
    const inst = acquireHandle("OK", () => good);
    expect(inst).toBe(good);
    expect(Object.keys(handleCache)).toEqual(["OK"]);
  });

  it("does not evict an existing entry when the factory for a new key throws", () => {
    // A transient model-load failure must not cost the user their already-
    // loaded models. acquireHandle is failure-atomic: it constructs the new
    // instance *first* and only then evicts to make room. If construction
    // throws, the cache is untouched.
    process.env.AGENCY_WHISPER_HANDLE_CACHE_MAX = "1";
    const a = newMockInstance();
    acquireHandle("A", () => a);
    expect(Object.keys(handleCache)).toEqual(["A"]);

    expect(() =>
      acquireHandle("B", () => {
        throw new Error("B failed");
      }),
    ).toThrow(/B failed/);
    // "A" must still be cached and not freed.
    expect(a.free).not.toHaveBeenCalled();
    expect(Object.keys(handleCache)).toEqual(["A"]);
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
