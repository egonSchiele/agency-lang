import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageRoot } from "../src/packageRoot.js";

// These tests exercise the C++ memory-safety design directly:
//   - Persistent reference (JS GC cannot collect a busy model)
//   - Atomic inflight counter (free() refuses while busy)
//   - Per-context mutex (concurrent transcribe calls serialize cleanly)
//
// They require the native addon to be built and the tiny.en model to be on
// disk. Both are local prerequisites; on a fresh CI runner the integration
// test (Task 14) provisions them first. We skip if absent so a developer
// running `pnpm test:run` without having built the addon doesn't see noise.

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = findPackageRoot(path.dirname(__filename));
const ADDON_PATH = path.join(
  PKG_ROOT,
  "build",
  "Release",
  "whisper_addon.node",
);
const MODEL_PATH = path.join(
  os.homedir(),
  ".agency/models/whisper/ggml-tiny.en.bin",
);

const HAVE_ADDON = existsSync(ADDON_PATH);
const HAVE_MODEL = existsSync(MODEL_PATH);
const READY = HAVE_ADDON && HAVE_MODEL;

type WhisperModelInstance = {
  transcribe(
    pcm: Float32Array,
    opts?: { language?: string; translate?: boolean },
  ): Promise<string[]>;
  free(): void;
};
type WhisperModelCtor = new (modelPath: string) => WhisperModelInstance;

let WhisperModel: WhisperModelCtor;

// 1 second of silence at 16 kHz. Whisper is happy with this — it just emits
// no segments (or a single "[BLANK]" segment depending on the model). We
// don't care about transcript quality; we only care about lifecycle behavior.
const ONE_SECOND_SILENCE = new Float32Array(16000);

describe.skipIf(!READY)("addon: memory safety", () => {
  // Track instances per test so we can free them even if assertions throw.
  let toFree: WhisperModelInstance[] = [];

  beforeAll(() => {
    if (!READY) return;
    const require = createRequire(import.meta.url);
    const addon = require(ADDON_PATH);
    WhisperModel = addon.WhisperModel;
  });

  afterEach(async () => {
    for (const m of toFree) {
      try {
        m.free();
      } catch {
        // ignore — some tests intentionally leave a model in the busy state
      }
    }
    toFree = [];
  });

  it("loads and frees a model cleanly", () => {
    const m = new WhisperModel(MODEL_PATH);
    expect(typeof m.transcribe).toBe("function");
    expect(typeof m.free).toBe("function");
    m.free();
    // Calling free() a second time on a freed model is a no-op (does not throw).
    expect(() => m.free()).not.toThrow();
  });

  it("throws a clear error when constructed with a non-existent model path", () => {
    expect(() => new WhisperModel("/nonexistent/path/ggml-fake.bin")).toThrow(
      /whisper_init_from_file_with_params failed/,
    );
  });

  it("throws TypeError when transcribe is called without a Float32Array", async () => {
    const m = new WhisperModel(MODEL_PATH);
    toFree.push(m);
    // The C++ method's TypeError throws synchronously, before returning a
    // promise — wrap in a function and use `toThrow`, not `rejects.toThrow`.
    expect(() =>
      (m.transcribe as unknown as (...a: unknown[]) => Promise<unknown>)(),
    ).toThrow(/Float32Array/);
    expect(() =>
      (m.transcribe as unknown as (x: unknown) => Promise<unknown>)("not a typed array"),
    ).toThrow(/Float32Array/);
  });

  it("rejects free() while a transcribe is in flight (busy state)", async () => {
    const m = new WhisperModel(MODEL_PATH);
    toFree.push(m);

    // Start a transcribe but don't await; inflight_ is incremented
    // synchronously inside C++ Transcribe() before it returns the promise.
    const promise = m.transcribe(ONE_SECOND_SILENCE);

    // free() now should refuse with the "busy" error.
    expect(() => m.free()).toThrow(/busy/i);
    expect(() => m.free()).toThrow(/free\(\) called while transcribe\(\) is in flight/);

    // Once the transcribe completes, inflight_ goes back to 0 and free() works.
    await promise;
    expect(() => m.free()).not.toThrow();
    // We freed manually; remove from the cleanup list.
    toFree.pop();
  }, 30_000);

  it("serializes concurrent transcribe calls on the same model (mutex)", async () => {
    // Without the per-context mutex this test would either hang, return wrong
    // segments, or segfault under TSan. With the mutex, both calls complete.
    const m = new WhisperModel(MODEL_PATH);
    toFree.push(m);

    const results = await Promise.all([
      m.transcribe(ONE_SECOND_SILENCE),
      m.transcribe(ONE_SECOND_SILENCE),
      m.transcribe(ONE_SECOND_SILENCE),
    ]);
    expect(results).toHaveLength(3);
    for (const segments of results) {
      expect(Array.isArray(segments)).toBe(true);
      // Each call must return its own array (different identity).
      // (We don't assert content; silence transcription is model-dependent.)
    }
    // The three array references should be distinct objects.
    expect(results[0]).not.toBe(results[1]);
    expect(results[1]).not.toBe(results[2]);
  }, 60_000);

  it("transcribe after free() rejects/throws", async () => {
    const m = new WhisperModel(MODEL_PATH);
    m.free();
    expect(() => m.transcribe(ONE_SECOND_SILENCE)).toThrow(/freed/);
  });

  it.skipIf(typeof globalThis.gc !== "function")(
    "Persistent ref keeps the model alive after JS drops its reference (best-effort GC test)",
    async () => {
      // The C++ TranscribeWorker holds a Napi::Persistent (ObjectReference)
      // to its parent WhisperModel JS object. Without that ref, this
      // sequence is a use-after-free: drop the JS reference, force GC,
      // worker thread is still running whisper_full on a freed context.
      //
      // We can't test "without the ref" (the bug would crash the test
      // process), but we *can* test that *with* the ref the transcribe
      // resolves cleanly even after we drop our reference and force GC.
      //
      // This is a best-effort test:
      //   - global.gc is a hint, not a command. V8 may delay collection.
      //   - Run with `NODE_OPTIONS=--expose-gc pnpm vitest run` to enable.
      //   - Without --expose-gc this test is skipped (visibly) via skipIf.
      let m: WhisperModelInstance | null = new WhisperModel(MODEL_PATH);
      // Start a transcribe and immediately discard our JS reference.
      const promise = m.transcribe(ONE_SECOND_SILENCE);
      m = null;

      // Force GC several times and wait between cycles to give V8 every
      // opportunity to collect what we just orphaned. If the Persistent
      // ref were missing, the next call into the worker thread would
      // touch freed memory.
      for (let i = 0; i < 5; i++) {
        (globalThis as { gc?: () => void }).gc?.();
        await new Promise<void>((r) => setTimeout(r, 10));
      }

      const result = await promise;
      expect(Array.isArray(result)).toBe(true);
      // The model is freed automatically when the worker finishes and the
      // Persistent ref drops; nothing for us to push to toFree here.
    },
    30_000,
  );

  it("two separate model instances do not share state", async () => {
    // This guards against any accidental static / global state in the addon.
    const m1 = new WhisperModel(MODEL_PATH);
    const m2 = new WhisperModel(MODEL_PATH);
    toFree.push(m1, m2);

    const [r1, r2] = await Promise.all([
      m1.transcribe(ONE_SECOND_SILENCE),
      m2.transcribe(ONE_SECOND_SILENCE),
    ]);
    expect(Array.isArray(r1)).toBe(true);
    expect(Array.isArray(r2)).toBe(true);

    // Freeing one must not affect the other.
    m1.free();
    toFree.shift();
    expect(() => m2.transcribe(ONE_SECOND_SILENCE)).not.toThrow();
  }, 60_000);
});

describe.skipIf(READY)("addon: memory safety (skipped)", () => {
  it("skipped because addon or model is not present", () => {
    if (!HAVE_ADDON) {
      console.log(
        `Skipped: addon not built. Run \`node dist/src/cli.js build\` first.`,
      );
    }
    if (!HAVE_MODEL) {
      console.log(
        `Skipped: model not present at ${MODEL_PATH}. Run the slow integration test once to download it.`,
      );
    }
    expect(true).toBe(true);
  });
});
