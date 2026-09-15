import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { root } from "agency-lang/stdlib-lib/contained.js";
import { outputPath, pathExists, publishSpeechOutput } from "agency-lang/stdlib-lib/speech.js";
import type { AudioFormat } from "./audioFormat.js";
import { encodeWithFfmpeg } from "./ffmpeg.js";
import { SAMPLE_RATE, synthesize } from "./kokoroModel.js";
import type { ModelName } from "./lockfile.js";
import { modelStatus } from "./modelStore.js";
import { encodeWav } from "./wav.js";

export type SpeakRequest = {
  text: string;
  outputFile: string;
  voice: string;
  model: ModelName;
  speed: number;
  allowedPaths: string[];
  format: AudioFormat;
  modelsDir: string;
};

/** Writes speech for `request.text` to a new audio file and returns its
 *  path. Never downloads, and never overwrites a file. */
export async function speakWith(request: SpeakRequest, signal: AbortSignal): Promise<string> {
  const target = await outputTarget(request.outputFile, request.format, request.allowedPaths);
  if (await pathExists(target)) {
    throw new Error(`kokoro: output file already exists: ${target}`);
  }
  if (!modelStatus(request.model, request.modelsDir).installed) {
    throw new Error(
      `kokoro: the ${request.model} model is not installed. Call speak again to be asked ` +
        `to download it, or call download("${request.model}")`,
    );
  }
  const audio = await synthesize(request, signal);
  const wav = encodeWav(audio, SAMPLE_RATE);
  const bytes = request.format === "wav" ? wav : await encodeWithFfmpeg(wav, request.format, signal);
  await publishSpeechOutput(target, bytes, signal);
  return target;
}

/** The caller's file, checked against `allowedPaths`, or a new file in the
 *  temp directory named for the format. The temp directory is spelled
 *  without symlinks, which the publish step refuses. */
async function outputTarget(
  outputFile: string,
  format: AudioFormat,
  allowedPaths: string[],
): Promise<string> {
  if (outputFile === "") {
    return path.join(root(os.tmpdir()).real, `agency-kokoro-${randomUUID()}.${format}`);
  }
  return outputPath(outputFile, allowedPaths);
}
