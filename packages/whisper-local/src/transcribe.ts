import { decodeToPcm } from "./ffmpeg.js";
import { ensureModel } from "./modelManager.js";
import { loadAddon, type WhisperModelInstance } from "./addon.js";
import type { ModelName } from "./types.js";

type CachedHandle = { instance: WhisperModelInstance };

const handleCache: Record<string, CachedHandle> = {};

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

export async function transcribe(
  filepath: string,
  language: string = "",
  model: ModelName = "base",
): Promise<string> {
  if (!filepath) {
    throw new Error("transcribe: filepath is required");
  }
  const modelPath = await ensureModel(model);
  let entry = handleCache[modelPath];
  if (!entry) {
    const { WhisperModel } = loadAddon();
    entry = { instance: new WhisperModel(modelPath) };
    handleCache[modelPath] = entry;
  }
  const pcm = await decodeToPcm(filepath);
  const segments = await entry.instance.transcribe(pcm, {
    language,
    translate: false,
  });
  return segments.join("").trim();
}
