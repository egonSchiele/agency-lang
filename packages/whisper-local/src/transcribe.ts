import { decodeToPcm } from "./ffmpeg.js";
import { ensureModel } from "./modelManager.js";
import { loadAddon } from "./addon.js";
import { acquireHandle, isCached } from "./handleCache.js";
import type { ModelName } from "./types.js";

export async function transcribe(
  filepath: string,
  language: string = "",
  model: ModelName = "base.en",
): Promise<string> {
  if (!filepath) {
    throw new Error("transcribe: filepath is required");
  }
  const modelPath = await ensureModel(model);
  const instance = acquireHandle(modelPath, () => {
    const { WhisperModel } = loadAddon();
    return new WhisperModel(modelPath);
  });
  // If caching is disabled (AGENCY_WHISPER_HANDLE_CACHE_MAX=0), the instance
  // is not in the cache; we must free it ourselves once the transcribe
  // resolves so the underlying whisper_context isn't leaked.
  const owned = !isCached(modelPath);
  try {
    const pcm = await decodeToPcm(filepath);
    const segments = await instance.transcribe(pcm, {
      language,
      translate: false,
    });
    return segments.join("").trim();
  } finally {
    if (owned) {
      try {
        instance.free();
      } catch {
        // Best-effort; if the instance is still busy somehow, leave it for GC.
      }
    }
  }
}
