import { isDiffusersDir, modelDirEntries, readModelJson } from "./modelBackend.js";
import {
  architecture,
  kindOfFacts,
  VISION_FAMILIES,
  type DirFacts,
  type ModelKind,
  type VisionFamily,
} from "./modelKind.js";

/** The kind rules of `modelKind.ts` applied to a directory on disk. Kept
 *  apart from the rules so that `config.ts`, which lists the kinds, does
 *  not reach `fs` through them. */

/** What kind of model a directory holds, from its files alone, or null
 *  when no rule matches. */
export function kindOfModelDir(dir: string): ModelKind | null {
  const facts: DirFacts = {
    names: modelDirEntries(dir).map((entry) => entry.name),
    config: readModelJson(dir, "config.json"),
    diffusers: isDiffusersDir(dir),
  };
  return kindOfFacts(facts);
}

/** The transformers vision family of the model in `dir`, from its
 *  config.json, or undefined for a directory with no such config, such as
 *  the ONNX tagger. */
export function visionFamilyOf(dir: string): VisionFamily | undefined {
  return VISION_FAMILIES[architectureOfModelDir(dir)];
}

/** The first architecture in config.json, or an empty string when absent. */
export function architectureOfModelDir(dir: string): string {
  return architecture(readModelJson(dir, "config.json"));
}
