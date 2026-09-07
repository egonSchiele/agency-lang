import { root, wholePath, stat, list } from "./contained.js";

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

/** A Hugging Face model directory: config.json plus at least one weights
 *  file. This is the layout `mlx_lm.server` loads. A GGUF model is one file
 *  with that information inside it, so it never has a config.json. */
export function isModelDir(p: string): boolean {
  const located = wholePath(p);
  const info = stat(located.root, located.target);
  if (info === null || !info.isDirectory()) {
    return false;
  }
  const entries = list(root(p), ".");
  const hasConfig = entries.some((e) => e.type === "file" && e.name === "config.json");
  const hasWeights = entries.some((e) => e.type === "file" && e.name.endsWith(".safetensors"));
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
