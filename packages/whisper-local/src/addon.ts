import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOutputPath,
  currentAddonTarget,
  packageVersion,
  resolveAddonPath,
} from "./addonPaths.js";
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

/**
 * The in-package build output wins when it exists, so editing addon.cc and
 * rebuilding inside this repo is always what runs; the durable copy (see
 * addonPaths.ts) is what an installed package finds after a reinstall has
 * emptied build/Release/.
 */
export function loadAddon(): { WhisperModel: WhisperModelCtor } {
  if (cached) return cached;
  const pkgRoot = findPackageRoot(__dirname);
  const durablePath = resolveAddonPath(currentAddonTarget(packageVersion(pkgRoot)));
  const buildPath = buildOutputPath(pkgRoot);
  const addonPath = [buildPath, durablePath].find((candidate) => existsSync(candidate));
  if (addonPath === undefined) {
    throw new Error(
      `whisper-local native addon not found at ${durablePath} (nor at ${buildPath}). ` +
        `Run \`npx -p @agency-lang/whisper-local agency-whisper build\` ` +
        `to compile it. (No postinstall hook runs this for you — by design.)`,
    );
  }
  cached = require(addonPath);
  return cached!;
}
