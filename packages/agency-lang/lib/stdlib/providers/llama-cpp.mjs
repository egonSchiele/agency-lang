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
import { createRequire } from "node:module";
import { splitModelPath } from "./llamaModelConfig.js";

async function loadSmoltalkLlamaCpp() {
  const pkgPath = process.env.AGENCY_SMOLTALK_LLAMA_CPP_PATH;
  if (pkgPath) {
    return await import(pathToFileURL(pkgPath).href);
  }
  return await import("smoltalk-llama-cpp");
}

async function loadNodeLlamaCpp() {
  // node-llama-cpp is a dependency of smoltalk-llama-cpp, so resolve it
  // RELATIVE TO smoltalk-llama-cpp's entry (the path localModels.ts found and
  // exposed via AGENCY_SMOLTALK_LLAMA_CPP_PATH). This works for global installs
  // and nested/hoisted layouts alike. We use `createRequire(...).resolve` —
  // NOT `import.meta.resolve(spec, parent)`, whose two-arg form is experimental
  // and silently unavailable on stable Node (the bug this replaces). The CJS
  // resolver honors node-llama-cpp's "node" export condition; we then import
  // the resolved ESM file URL.
  const pkgPath = process.env.AGENCY_SMOLTALK_LLAMA_CPP_PATH;
  if (pkgPath) {
    try {
      const resolved = createRequire(pkgPath).resolve("node-llama-cpp");
      return await import(pathToFileURL(resolved).href);
    } catch {
      /* fall through to a bare import */
    }
  }
  // Last resort: a bare import, which only resolves when node-llama-cpp is
  // reachable from this module's own location (e.g. a local project install).
  return await import("node-llama-cpp");
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
