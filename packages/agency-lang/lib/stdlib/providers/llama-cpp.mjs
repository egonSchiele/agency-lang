// Bundled llama-cpp provider module. Loaded on demand by localModels.ts
// (never statically imported by agency-lang), so smoltalk-llama-cpp stays a
// non-dependency. Plain .mjs: shipped via the Makefile copy, outside TS lint.
import { LlamaCPP } from "smoltalk-llama-cpp";
import { existsSync } from "node:fs";
import { splitModelPath } from "./llamaModelConfig.js";

class LocalLlamaCPP extends LlamaCPP {
  constructor(config) {
    const metadata = { ...(config.metadata ?? {}) };
    if (config.model && !metadata.llamaCppModelDir) {
      const split = splitModelPath(config.model);
      metadata.llamaCppModelDir = split.llamaCppModelDir;
      super({ ...config, model: split.model, metadata });
      return;
    }
    super({ ...config, metadata });
  }
}

export function register({ registerProvider }) {
  registerProvider("llama-cpp", LocalLlamaCPP);
}

async function loadNodeLlamaCpp() {
  try {
    const parent = import.meta.resolve("smoltalk-llama-cpp");
    return await import(import.meta.resolve("node-llama-cpp", parent));
  } catch {
    return await import("node-llama-cpp");
  }
}

export async function resolveModel(uriOrPath, cacheDir) {
  if (uriOrPath.endsWith(".gguf") && existsSync(uriOrPath)) return uriOrPath;
  const { resolveModelFile } = await loadNodeLlamaCpp();
  return await resolveModelFile(uriOrPath, { directory: cacheDir, cli: true });
}
