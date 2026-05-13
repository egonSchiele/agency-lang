import type { WhisperModelInstance } from "./addon.js";

// Internal: not re-exported from the package's public entrypoint
// (`src/transcribe.ts`). Tests and CLI code import this module directly.

type CachedHandle = { instance: WhisperModelInstance };

// Insertion-order map. Each call to acquireHandle() promotes the entry to
// most-recently-used. evictOldest() drops the least-recently-used entry.
export const handleCache: Record<string, CachedHandle> = {};

// Default cap of 2 loaded models. A typical Agency program uses one model;
// two leaves headroom for "switching from base.en to large-v3 mid-program"
// without thrashing. Each entry can hold hundreds of MB (a large-v3 context
// is ~3 GB), so an unbounded cache is dangerous in long-lived processes.
//
// Override via AGENCY_WHISPER_HANDLE_CACHE_MAX. Set to 0 to disable caching
// (every transcribe() loads + frees), or to a large value to opt out of LRU.
function configuredMax(): number {
  const raw = process.env.AGENCY_WHISPER_HANDLE_CACHE_MAX;
  if (raw === undefined) return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 2;
  return Math.floor(n);
}

function freeQuiet(key: string, instance: WhisperModelInstance): void {
  try {
    instance.free();
  } catch (err) {
    // free() throws "WhisperModel busy" if a transcribe is still in flight.
    // The Persistent ref in the addon keeps the model alive until the worker
    // finishes; we just drop our cache entry. Worst case we leak one model
    // until its in-flight transcribe completes and JS GC collects it.
    console.warn(
      `whisper-local: failed to free model "${key}": ${(err as Error).message}`,
    );
  }
}

// Touch an existing entry so it becomes most-recently-used. Implemented by
// delete + re-insert, which is O(1) on V8's hash map and preserves insertion
// order semantics for Object.keys().
function touch(key: string): void {
  const entry = handleCache[key];
  if (entry === undefined) return;
  delete handleCache[key];
  handleCache[key] = entry;
}

export function acquireHandle(
  key: string,
  factory: () => WhisperModelInstance,
): WhisperModelInstance {
  const existing = handleCache[key];
  if (existing) {
    touch(key);
    return existing.instance;
  }
  const max = configuredMax();
  // Failure-atomic: construct *first*, then evict + insert. If factory()
  // throws (corrupt model, OOM, missing GPU, …) we leave the existing
  // cache contents untouched. A transient load failure must not cost the
  // user the model they already had loaded.
  const instance = factory();
  if (max === 0) {
    // max=0 means "don't cache" — hand the instance back without storing.
    // The caller is responsible for free() (transcribe.ts wraps this path
    // so the model is freed after each call).
    return instance;
  }
  // Evict from the front (least-recently-used) until we have room. We only
  // need to evict 1 in steady state, but a runtime decrease in max via env
  // re-read could leave the cache larger than max — handle it generally.
  while (Object.keys(handleCache).length >= max) {
    const oldestKey = Object.keys(handleCache)[0];
    if (oldestKey === undefined) break;
    const oldest = handleCache[oldestKey];
    delete handleCache[oldestKey];
    freeQuiet(oldestKey, oldest.instance);
  }
  handleCache[key] = { instance };
  return instance;
}

// Whether a given key is currently cached (test helper).
export function isCached(key: string): boolean {
  return handleCache[key] !== undefined;
}

export function _clearHandleCache(): void {
  for (const key of Object.keys(handleCache)) {
    freeQuiet(key, handleCache[key].instance);
    delete handleCache[key];
  }
}
