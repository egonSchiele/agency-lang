import { getRuntimeContext } from "agency-lang/runtime";
import { validateSpeakArguments } from "./argumentChecks.js";
import { isAudioFormat, resolveFormat, type AudioFormat } from "./audioFormat.js";
import { assertFfmpegAvailable } from "./ffmpeg.js";
import { MODEL_NAMES, isModelName, type ModelName } from "./lockfile.js";
import { downloadModel, modelStatus, resolveModelsDir, type ModelStatus } from "./modelStore.js";
import { speakWith } from "./speak.js";
import { VOICES, type Voice } from "./voices.js";

// The functions index.agency calls. `model` arrives as a string, and
// `format` as whatever the caller wrote. `modelsDir` is null for the
// default. Each check throws before any interrupt is raised.

/** Checks every argument of `speak` and returns the format it will write.
 *  A format that needs ffmpeg is refused here when ffmpeg is missing. */
export function _validateSpeakArgs(
  text: string,
  outputFile: string,
  voice: string,
  model: string,
  speed: number,
  format: string,
): AudioFormat {
  validateSpeakArguments({ text, outputFile, voice, model, speed, format });
  const resolved = resolveFormat(format, outputFile);
  if (!isAudioFormat(resolved)) {
    throw new Error(`kokoro: unknown audio format "${resolved}"`);
  }
  if (resolved !== "wav") {
    assertFfmpegAvailable();
  }
  return resolved;
}

function checkedModel(model: string): ModelName {
  if (!isModelName(model)) {
    throw new Error(`kokoro: unknown model "${model}". Choices: ${MODEL_NAMES.join(", ")}`);
  }
  return model;
}

export function _modelStatus(model: string, modelsDir: string | null): ModelStatus {
  return modelStatus(checkedModel(model), resolveModelsDir(modelsDir));
}

export async function _download(model: string, modelsDir: string | null): Promise<void> {
  const { ctx, stack } = getRuntimeContext();
  await downloadModel(checkedModel(model), resolveModelsDir(modelsDir), {
    signal: ctx.getAbortSignal(stack),
  });
}

export async function _speak(
  text: string,
  outputFile: string,
  voice: string,
  model: string,
  speed: number,
  allowedPaths: string[],
  format: AudioFormat,
  modelsDir: string | null,
): Promise<string> {
  const { ctx, stack } = getRuntimeContext();
  const request = {
    text,
    outputFile,
    voice,
    model: checkedModel(model),
    speed,
    allowedPaths,
    format,
    modelsDir: resolveModelsDir(modelsDir),
  };
  return speakWith(request, ctx.getAbortSignal(stack));
}

export function _voices(): Voice[] {
  return VOICES;
}
