import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { root } from "agency-lang/stdlib-lib/contained.js";
import { outputPath, pathExists, publishSpeechOutput } from "agency-lang/stdlib-lib/speech.js";
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
};

/** Writes speech for `request.text` to a new WAV file and returns its
 *  path. Never downloads, and never overwrites a file. */
export async function speakWith(request: SpeakRequest, signal: AbortSignal): Promise<string> {
  const target = await outputTarget(request.outputFile, request.allowedPaths);
  if (await pathExists(target)) {
    throw new Error(`kokoro: output file already exists: ${target}`);
  }
  if (!modelStatus(request.model).installed) {
    throw new Error(
      `kokoro: the ${request.model} model is not installed. Call speak again to be asked ` +
        `to download it, or run: agency-kokoro pull ${request.model}`,
    );
  }
  const audio = await synthesize(request, signal);
  await publishSpeechOutput(target, encodeWav(audio, SAMPLE_RATE), signal);
  return target;
}

/** The caller's file, checked against `allowedPaths`, or a new file in the
 *  temp directory. The temp directory is spelled without symlinks, which
 *  the publish step refuses. */
async function outputTarget(outputFile: string, allowedPaths: string[]): Promise<string> {
  if (outputFile === "") {
    return path.join(root(os.tmpdir()).real, `agency-kokoro-${randomUUID()}.wav`);
  }
  return outputPath(outputFile, allowedPaths);
}
