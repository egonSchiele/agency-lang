import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageRoot } from "./packageRoot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

export type WhisperModelInstance = {
  transcribe(
    pcm: Float32Array,
    opts?: { language?: string; translate?: boolean },
  ): Promise<string[]>;
  free(): void;
};

export type WhisperModelCtor = new (modelPath: string) => WhisperModelInstance;

let cached: { WhisperModel: WhisperModelCtor } | null = null;

export function loadAddon(): { WhisperModel: WhisperModelCtor } {
  if (cached) return cached;
  const pkgRoot = findPackageRoot(__dirname);
  const addonPath = path.join(pkgRoot, "build", "Release", "whisper_addon.node");
  if (!existsSync(addonPath)) {
    throw new Error(
      `whisper-local native addon not found at ${addonPath}. ` +
        `Run \`npx -p @agency-lang/whisper-local agency-whisper build\` ` +
        `to compile it. (No postinstall hook runs this for you — by design.)`,
    );
  }
  cached = require(addonPath);
  return cached!;
}
