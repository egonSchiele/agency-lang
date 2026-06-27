// Bundled llama-cpp provider module. Loaded on demand by localModels.ts
// (never statically imported by agency-lang), so smoltalk-llama-cpp stays a
// non-dependency. Plain .mjs: shipped via the Makefile copy, outside TS lint.
//
// All imports of `smoltalk-llama-cpp` / `node-llama-cpp` go through dynamic
// import paths. localModels.ts resolves smoltalk-llama-cpp (including from
// global node_modules roots — `npm i -g` and `pnpm add -g`) and exposes the
// absolute entry path via AGENCY_SMOLTALK_LLAMA_CPP_PATH. We honor that here
// so a globally-installed provider works even though the bare specifier
// `smoltalk-llama-cpp` isn't resolvable from this file's location.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { splitModelPath } from "./llamaModelConfig.js";

async function loadSmoltalkLlamaCpp() {
  const pkgPath = process.env.AGENCY_SMOLTALK_LLAMA_CPP_PATH;
  if (pkgPath) {
    return await import(pathToFileURL(pkgPath).href);
  }
  return await import("smoltalk-llama-cpp");
}

async function loadNodeLlamaCpp() {
  // Prefer the copy that ships with smoltalk-llama-cpp so we use the version
  // it was tested against. Fall back to a bare resolve.
  const pkgPath = process.env.AGENCY_SMOLTALK_LLAMA_CPP_PATH;
  if (pkgPath) {
    try {
      const url = import.meta.resolve("node-llama-cpp", pathToFileURL(pkgPath).href);
      return await import(url);
    } catch {
      /* fall through to a local resolve */
    }
  }
  try {
    const parent = import.meta.resolve("smoltalk-llama-cpp");
    return await import(import.meta.resolve("node-llama-cpp", parent));
  } catch {
    return await import("node-llama-cpp");
  }
}

// Cached so a second register() call doesn't re-import smoltalk-llama-cpp.
let _LocalLlamaCPP = null;

async function getLocalLlamaCPP() {
  if (_LocalLlamaCPP) {
    return _LocalLlamaCPP;
  }
  const { LlamaCPP } = await loadSmoltalkLlamaCpp();
  _LocalLlamaCPP = class extends LlamaCPP {
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
  };
  return _LocalLlamaCPP;
}

export async function register({ registerProvider }) {
  const cls = await getLocalLlamaCPP();
  registerProvider("llama-cpp", cls);
}

export async function resolveModel(uriOrPath, cacheDir) {
  if (uriOrPath.endsWith(".gguf") && existsSync(uriOrPath)) return uriOrPath;
  const { resolveModelFile } = await loadNodeLlamaCpp();
  return await resolveModelFile(uriOrPath, { directory: cacheDir, cli: true });
}
