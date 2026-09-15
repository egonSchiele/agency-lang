import { getRuntimeContext } from "agency-lang/runtime";
import { validateSpeakArguments } from "./argumentChecks.js";
import type { ModelName } from "./lockfile.js";
import { downloadModel, modelStatus, type ModelStatus } from "./modelStore.js";
import { speakWith } from "./speak.js";
import { VOICES, type Voice } from "./voices.js";

// The functions index.agency calls. `model` arrives as a string, and
// _validateSpeakArgs has already checked it by the time the others run.

export function _validateSpeakArgs(
  text: string,
  outputFile: string,
  voice: string,
  model: string,
  speed: number,
): void {
  validateSpeakArguments({ text, outputFile, voice, model, speed });
}

export function _modelStatus(model: string): ModelStatus {
  return modelStatus(model as ModelName);
}

export async function _download(model: string): Promise<void> {
  await downloadModel(model as ModelName);
}

export async function _speak(
  text: string,
  outputFile: string,
  voice: string,
  model: string,
  speed: number,
  allowedPaths: string[],
): Promise<string> {
  const { ctx, stack } = getRuntimeContext();
  const request = { text, outputFile, voice, model: model as ModelName, speed, allowedPaths };
  return speakWith(request, ctx.getAbortSignal(stack));
}

export function _voices(): Voice[] {
  return VOICES;
}
