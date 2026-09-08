import * as fs from "node:fs";
import * as path from "node:path";
import { wholePath, stat } from "./contained.js";

/** Which engine runs a model. GGUF files run in-process through llama.cpp.
 *  MLX models run in mlx_lm.server, which the user starts. */
export type Backend = "llama-cpp" | "mlx";

export function isGgufPath(v: string): boolean {
  return v.endsWith(".gguf");
}

/** `mlx:<org>/<repo>` with an optional `@<revision>`. */
const MLX_URI = /^mlx:([^@\s/]+\/[^@\s/]+)(?:@([\w.-]+))?$/;

export function isMlxUri(v: string): boolean {
  return MLX_URI.test(v);
}

/** Split "mlx:org/repo@rev" into its parts. Throws on any other shape. */
export function parseMlxUri(v: string): { repo: string; revision: string | undefined } {
  const m = MLX_URI.exec(v);
  if (m === null) {
    throw new Error(
      `"${v}" is not an mlx: URI. Expected mlx:<org>/<repo> or mlx:<org>/<repo>@<revision>.`,
    );
  }
  return { repo: m[1], revision: m[2] };
}

export type ModelDirEntry = { name: string; size: number };

/** The files in a model directory, by name and size. This follows symlinks,
 *  which `contained.ts` does not, because a Hugging Face cache snapshot
 *  (`hf/hub/models--org--repo/snapshots/<sha>/`) is all links into
 *  `blobs/` and should work without copying. It reads names and sizes
 *  only. A dangling link is skipped. */
export function modelDirEntries(dir: string): ModelDirEntry[] {
  const out: ModelDirEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    let info: fs.Stats;
    try {
      info = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (info.isFile()) {
      out.push({ name, size: info.size });
    }
  }
  return out;
}

/** A Hugging Face model directory: config.json plus at least one weights
 *  file. This is the layout `mlx_lm.server` loads. A GGUF model is one file
 *  with that information inside it, so it never has a config.json. */
export function isModelDir(p: string): boolean {
  const located = wholePath(p);
  const info = stat(located.root, located.target);
  if (info === null || !info.isDirectory()) {
    return false;
  }
  const entries = modelDirEntries(p);
  const hasConfig = entries.some((e) => e.name === "config.json");
  const hasWeights = entries.some((e) => e.name.endsWith(".safetensors"));
  return hasConfig && hasWeights;
}

/** Which engine runs a resolved target. Throws for a path that is neither a
 *  GGUF file nor a model directory. */
export function backendOfTarget(target: string): Backend {
  if (isGgufPath(target) || /^(hf:|https?:)/.test(target)) {
    return "llama-cpp";
  }
  if (isMlxUri(target) || isModelDir(target)) {
    return "mlx";
  }
  throw new Error(
    `"${target}" is not a model: expected a .gguf file or a directory containing config.json.`,
  );
}
