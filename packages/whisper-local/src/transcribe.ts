import { decodeToPcm } from "./ffmpeg.js";
import { ensureModel } from "./modelManager.js";
import { loadAddon } from "./addon.js";
import { handleCache } from "./handleCache.js";
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
