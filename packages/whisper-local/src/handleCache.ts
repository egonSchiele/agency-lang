import type { WhisperModelInstance } from "./addon.js";

// Internal: not re-exported from the package's public entrypoint
// (`src/transcribe.ts`). Tests and CLI code import this module directly.

type CachedHandle = { instance: WhisperModelInstance };

export const handleCache: Record<string, CachedHandle> = {};

export function _clearHandleCache(): void {
  for (const key of Object.keys(handleCache)) {
    try {
      handleCache[key].instance.free();
    } catch (err) {
      // free() can throw "WhisperModel busy" if a transcribe is still in
      // flight. Log but continue clearing — the Persistent ref in the addon
      // will keep the model alive until the worker finishes; we just drop
      // our handle cache entry so the next transcribe creates a fresh one.
      console.warn(
        `whisper-local: failed to free model "${key}": ${(err as Error).message}`,
      );
    }
    delete handleCache[key];
  }
}
