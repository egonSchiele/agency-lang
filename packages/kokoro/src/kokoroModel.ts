// Keep these three imports in this order, and keep this the only module
// that imports kokoro-js. See listenersAfter.ts.
import "./listenersBefore.js";
import { KokoroTTS, TextSplitterStream } from "kokoro-js";
import "./listenersAfter.js";
import { env } from "@huggingface/transformers";
import * as path from "node:path";
import { throwAbortReason } from "agency-lang/stdlib-lib/speech.js";
import { LOCKFILE, type ModelName } from "./lockfile.js";
import { modelDir } from "./modelStore.js";
import { sentenceWindows, splitToFit } from "./textChunks.js";
import { toPcm16 } from "./wav.js";

export const SAMPLE_RATE = 24000;

export type SynthesisRequest = {
  text: string;
  voice: string;
  speed: number;
  model: ModelName;
};

type LoadedModel = {
  dir: string;
  tts: Promise<KokoroTTS>;
};

let loaded: LoadedModel | null = null;
let previousCall: Promise<unknown> = Promise.resolve();

/** 16-bit audio for `request.text`, one sentence at a time, so no piece
 *  reaches the length at which the model truncates. Calls run one at a
 *  time. `signal` is checked before each sentence. */
export function synthesize(request: SynthesisRequest, signal: AbortSignal): Promise<Int16Array[]> {
  return oneAtATime(async () => {
    const tts = await loadModel(request.model);
    const chunks: Int16Array[] = [];
    for (const piece of textPieces(request.text)) {
      if (signal.aborted) {
        throwAbortReason(signal);
      }
      const audio = await tts.generate(piece, {
        voice: request.voice as never,
        speed: request.speed,
      });
      chunks.push(toPcm16(audio.audio));
    }
    return chunks;
  });
}

/** Sentences from kokoro-js's own splitter, with any sentence too long
 *  for the model split further. */
export function textPieces(text: string): string[] {
  return sentenceWindows(text)
    .flatMap((window) => {
      const splitter = new TextSplitterStream();
      splitter.push(window);
      return [...splitter];
    })
    .flatMap((sentence) => splitToFit(sentence));
}

/** Keeps one model loaded. A different model or models directory replaces
 *  it, and a failed load is forgotten so the next call tries again. */
export async function loadModel(model: ModelName): Promise<KokoroTTS> {
  const dir = modelDir(model);
  if (loaded === null || loaded.dir !== dir) {
    loaded = { dir, tts: loadFrom(model, dir) };
  }
  const current = loaded;
  try {
    return await current.tts;
  } catch (err) {
    if (loaded === current) {
      loaded = null;
    }
    throw err;
  }
}

function loadFrom(model: ModelName, dir: string): Promise<KokoroTTS> {
  env.allowRemoteModels = false;
  env.localModelPath = dir + path.sep;
  return KokoroTTS.from_pretrained(LOCKFILE.repo, { dtype: model, device: "cpu" });
}

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const result = previousCall.then(work, work);
  // The caller of `result` sees its failure. The chain only waits for it.
  previousCall = result.catch(() => undefined);
  return result;
}
