import * as path from "node:path";
import { MODEL_NAMES, isModelName } from "./lockfile.js";
import { isVoiceId } from "./voices.js";

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
/** The whole audio file is held in memory until it is written. */
export const MAX_TEXT_CHARS = 50_000;

export type SpeakArguments = {
  text: string;
  outputFile: string;
  voice: string;
  model: string;
  speed: number;
};

type ArgumentRule = {
  holds: (args: SpeakArguments) => boolean;
  message: (args: SpeakArguments) => string;
};

const RULES: ArgumentRule[] = [
  {
    holds: (args) => args.text.trim() !== "",
    message: () => "text cannot be empty",
  },
  {
    holds: (args) => args.text.length <= MAX_TEXT_CHARS,
    message: (args) =>
      `text is ${args.text.length} characters, over the limit of ${MAX_TEXT_CHARS}. ` +
      "Split it across several calls.",
  },
  {
    holds: (args) => isVoiceId(args.voice),
    message: (args) => `unknown voice "${args.voice}". Call voices() for the list.`,
  },
  {
    holds: (args) => isModelName(args.model),
    message: (args) => `unknown model "${args.model}". Choices: ${MODEL_NAMES.join(", ")}`,
  },
  {
    holds: (args) => args.speed >= MIN_SPEED && args.speed <= MAX_SPEED,
    message: (args) => `speed must be between ${MIN_SPEED} and ${MAX_SPEED}, got ${args.speed}`,
  },
  {
    holds: (args) => ["", ".wav"].includes(path.extname(args.outputFile).toLowerCase()),
    message: (args) => `output file "${args.outputFile}" must end in .wav or have no extension`,
  },
];

/** Throws on the first argument that breaks a rule, before any interrupt. */
export function validateSpeakArguments(args: SpeakArguments): void {
  const broken = RULES.find((rule) => !rule.holds(args));
  if (broken !== undefined) {
    throw new Error(`kokoro: ${broken.message(args)}`);
  }
}
