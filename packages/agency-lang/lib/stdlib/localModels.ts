import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findFileUp } from "../importPaths.js";
import { loadProviderModuleByPath } from "../runtime/providerModules.js";

/** Categories let the CLI / future tooling group + filter without inspecting
 *  the description. Kept as a small string union so the set is self-documenting. */
export type ModelCategory =
  | "tiny"        // < 1 GB, sub-1B parameters; smoke tests, edge devices
  | "small"       // 1–3 GB, 1–3B parameters; cheap on-CPU general use
  | "medium"      // 4–6 GB, 7–9B parameters; the modern "sweet spot"
  | "large"       // 8–20 GB, 12–32B parameters; needs >=16 GB RAM or a GPU
  | "xl"          // > 20 GB, 70B+; needs a serious workstation
  | "coding"      // SWE-tuned specialists (any size)
  | "reasoning"   // R1-style chain-of-thought distills (any size)
  | "embedding";  // BERT-family; returns vectors, not text

export type ModelInfo = {
  /** Hugging Face URI passed to `node-llama-cpp`'s `resolveModelFile`. */
  uri: string;
  /** Human-readable parameter count, e.g. "1.7B" or "70B". */
  params: string;
  /** Approximate Q4_K_M download size in bytes. */
  sizeBytes: number;
  /** Bucket for filtering / display. */
  category: ModelCategory;
  /** One-line "what is it good for" — shown by `agency local alias list`. */
  description: string;
  /** Native context window in tokens. */
  contextWindow: number;
  /** License identifier (SPDX-ish): "apache-2.0", "llama3.1", "gemma", "mit", etc. */
  license: string;
};

/** Curated short-name → ModelInfo catalog. */
export const CURATED_LOCAL_MODELS: Record<string, ModelInfo> = {
  // ── Tiny (sub-1GB) ──────────────────────────────────────────────────────
  "smollm2-135m": {
    uri: "hf:HuggingFaceTB/SmolLM2-135M-Instruct-GGUF:Q4_K_M",
    params: "135M", sizeBytes: 88_000_000, category: "tiny",
    contextWindow: 8192, license: "apache-2.0",
    description: "Smallest practical chat model; used by our integration tests, runs anywhere.",
  },
  "qwen3.5-0.8b": {
    uri: "hf:unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M",
    params: "0.8B", sizeBytes: 500_000_000, category: "tiny",
    contextWindow: 131072, license: "apache-2.0",
    description: "Tiny model from Alibaba's current generation; good edge-device default.",
  },

  // ── Small (1–3GB) ───────────────────────────────────────────────────────
  "qwen3.5-2b": {
    uri: "hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
    params: "2B", sizeBytes: 1_280_000_000, category: "small",
    contextWindow: 131072, license: "apache-2.0",
    description: "Most popular modern small general model; runs on CPU comfortably.",
  },
  "gemma-3-4b": {
    uri: "hf:unsloth/gemma-3-4b-it-GGUF:Q4_K_M",
    params: "4B", sizeBytes: 2_500_000_000, category: "small",
    contextWindow: 131072, license: "gemma",
    description: "Google's small multimodal model (text + image input); 128K context.",
  },
  "qwen3.5-4b": {
    uri: "hf:unsloth/Qwen3.5-4B-GGUF:Q4_K_M",
    params: "4B", sizeBytes: 2_400_000_000, category: "small",
    contextWindow: 131072, license: "apache-2.0",
    description: "Strong multilingual small general workhorse from Alibaba.",
  },

  // ── Medium (3–7GB) ──────────────────────────────────────────────────────
  "deepseek-r1-distill-llama-8b": {
    uri: "hf:unsloth/DeepSeek-R1-Distill-Llama-8B-GGUF:Q4_K_M",
    params: "8B", sizeBytes: 4_920_000_000, category: "reasoning",
    contextWindow: 131072, license: "mit",
    description: "Chain-of-thought distill into Llama-8B; best small reasoning model.",
  },
  "qwen3.5-9b": {
    uri: "hf:unsloth/Qwen3.5-9B-GGUF:Q4_K_M",
    params: "9B", sizeBytes: 5_500_000_000, category: "medium",
    contextWindow: 131072, license: "apache-2.0",
    description: "Modern medium general model with strong tool use; 128K context.",
  },

  // ── Large (8–25GB) ──────────────────────────────────────────────────────
  "phi-4-reasoning": {
    uri: "hf:bartowski/Phi-4-reasoning-GGUF:Q4_K_M",
    params: "14B", sizeBytes: 9_050_000_000, category: "reasoning",
    contextWindow: 32768, license: "mit",
    description: "Microsoft's reasoning-tuned 14B; competitive with much larger models on math/logic.",
  },
  "gpt-oss-20b": {
    uri: "hf:unsloth/gpt-oss-20b-GGUF:Q4_K_M",
    params: "20B", sizeBytes: 12_000_000_000, category: "large",
    contextWindow: 131072, license: "apache-2.0",
    description: "OpenAI's open-weights release; balanced general model for ~16 GB machines.",
  },
  "devstral-small-2507": {
    uri: "hf:mistralai/Devstral-Small-2507_gguf:Q4_K_M",
    params: "24B", sizeBytes: 14_300_000_000, category: "coding",
    contextWindow: 131072, license: "apache-2.0",
    description: "Mistral's official coding-agent GGUF; #1 open-source on SWE-Bench at release.",
  },
  "mistral-small-3.1": {
    uri: "hf:unsloth/Mistral-Small-3.1-24B-Instruct-2503-GGUF:Q4_K_M",
    params: "24B", sizeBytes: 14_000_000_000, category: "large",
    contextWindow: 131072, license: "apache-2.0",
    description: "Mistral's general 24B base model (also Devstral's foundation); broad utility.",
  },
  "gemma-4-26b-a4b": {
    uri: "hf:unsloth/gemma-4-26B-A4B-it-GGUF:Q4_K_M",
    params: "26B (A4B)", sizeBytes: 16_000_000_000, category: "large",
    contextWindow: 131072, license: "gemma",
    description: "Google's MoE Gemma 4 with only 3.8B active params; local sweet spot for 24GB+ machines.",
  },
  "qwen3-coder-30b-a3b": {
    uri: "hf:unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M",
    params: "30B (A3B)", sizeBytes: 19_000_000_000, category: "coding",
    contextWindow: 262144, license: "apache-2.0",
    description: "Qwen's MoE coder (3.3B active); strong agentic coding + 256K context.",
  },
  "qwen3.5-27b": {
    uri: "hf:unsloth/Qwen3.5-27B-GGUF:Q4_K_M",
    params: "27B", sizeBytes: 16_000_000_000, category: "large",
    contextWindow: 131072, license: "apache-2.0",
    description: "Modern dense general 27B; the practical ceiling for most workstations.",
  },

  // ── XL (25GB+) ──────────────────────────────────────────────────────────
  "llama-4-scout": {
    uri: "hf:unsloth/Llama-4-Scout-17B-16E-Instruct-GGUF:Q4_K_M",
    params: "109B (A17B)", sizeBytes: 65_000_000_000, category: "xl",
    contextWindow: 10_000_000,
    license: "llama4",
    description: "Meta's long-context MoE (17B active); 10M-token context for whole-repo / huge-doc work.",
  },

  // ── Embedding ───────────────────────────────────────────────────────────
  "nomic-embed-text": {
    uri: "hf:nomic-ai/nomic-embed-text-v1.5-GGUF:Q4_K_M",
    params: "137M", sizeBytes: 89_000_000, category: "embedding",
    contextWindow: 8192, license: "apache-2.0",
    description: "Returns 768-dim embeddings; pair with a chat model for RAG.",
  },
};

export function defaultCacheDir(): string {
  return process.env.AGENCY_MODELS_DIR ?? path.join(os.homedir(), ".agency-agent", "models");
}

/** Treat empty string as "caller wants the default cache dir". */
function resolveCacheDir(cacheDir: string): string {
  return cacheDir === "" ? defaultCacheDir() : cacheDir;
}

function isGgufPath(v: string): boolean {
  return v.endsWith(".gguf");
}

function isModelUri(v: string): boolean {
  return /^(hf:|https?:)/.test(v);
}

/** The agency.json that owns aliases: nearest `agency.json` walking up from
 *  `startDir` (cwd by default); falls back to `~/agency.json` when none is
 *  found. Exported so the CLI can echo it on every write. */
export function resolveAliasConfigPath(startDir: string = process.cwd()): string {
  return findFileUp(startDir, "agency.json") ?? path.join(os.homedir(), "agency.json");
}

/** Treat empty string as "caller wants resolveAliasConfigPath()". */
function resolveAliasFile(file: string): string {
  return file === "" ? resolveAliasConfigPath() : file;
}

/** Read a JSON file as a plain object. */
function readJson(file: string): Record<string, any> {
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${(err as Error).message}`);
  }
}

/** Merge `client.modelAliases[name] = uri` (or remove it) into a config object using spread. */
function withAlias(
  cfg: Record<string, any>,
  name: string,
  uri: string | undefined,
): Record<string, any> {
  const existing = cfg.client?.modelAliases ?? {};
  const nextAliases = { ...existing };
  if (uri === undefined) {
    delete nextAliases[name];
  } else {
    nextAliases[name] = uri;
  }
  return {
    ...cfg,
    client: { ...(cfg.client ?? {}), modelAliases: nextAliases },
  };
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function readModelAliases(file: string = ""): Record<string, string> {
  const cfg = readJson(resolveAliasFile(file));
  return (cfg.client?.modelAliases ?? {}) as Record<string, string>;
}

/** Entry returned by `_listModelNames`. */
export type ModelNameEntry = {
  name: string;
  target: string;
  source: "curated" | "alias";
  params?: string;
  sizeBytes?: number;
  category?: ModelCategory;
  description?: string;
  contextWindow?: number;
  license?: string;
};

export function _resolveModelName(value: string, file: string = ""): string {
  if (isGgufPath(value) || isModelUri(value)) {
    return value;
  }
  const aliases = readModelAliases(file);
  const aliasTarget = aliases[value];
  const curated = CURATED_LOCAL_MODELS[value];
  const mapped = aliasTarget ?? curated?.uri;
  if (!mapped) {
    const names = [...Object.keys(CURATED_LOCAL_MODELS), ...Object.keys(aliases)].join(", ");
    throw new Error(
      `Unknown local model "${value}". Known names: ${names || "(none)"}; ` +
        `or pass a .gguf path or an "hf:" URI.`,
    );
  }
  return mapped;
}

export function _listModelNames(file: string = ""): ModelNameEntry[] {
  const curated: ModelNameEntry[] = Object.entries(CURATED_LOCAL_MODELS).map(
    ([name, info]) => ({
      name,
      target: info.uri,
      source: "curated",
      params: info.params,
      sizeBytes: info.sizeBytes,
      category: info.category,
      description: info.description,
      contextWindow: info.contextWindow,
      license: info.license,
    }),
  );
  const aliases: ModelNameEntry[] = Object.entries(readModelAliases(file)).map(
    ([name, target]) => ({ name, target, source: "alias" }),
  );
  return [...curated, ...aliases];
}

export function _aliasModel(name: string, uri: string, file: string = ""): string {
  const resolved = resolveAliasFile(file);
  writeJson(resolved, withAlias(readJson(resolved), name, uri));
  return resolved;
}

/** Outcome of `_unaliasModel`. `removed` distinguishes the actual mutation
 *  (true) from the "alias / file wasn't there, file untouched" no-op (false),
 *  so the CLI can print an accurate message instead of always saying
 *  "Removed alias …" even when nothing changed. */
export type UnaliasResult = { file: string; removed: boolean };

/** Remove an alias. Bails early (no write) if file or alias missing. */
export function _unaliasModel(name: string, file: string = ""): UnaliasResult {
  const resolved = resolveAliasFile(file);
  if (!fs.existsSync(resolved)) {
    return { file: resolved, removed: false };
  }
  const cfg = readJson(resolved);
  if (!cfg.client?.modelAliases || !(name in cfg.client.modelAliases)) {
    return { file: resolved, removed: false };
  }
  writeJson(resolved, withAlias(cfg, name, undefined));
  return { file: resolved, removed: true };
}

export function _listDownloadedModels(
  cacheDir: string = "",
): { name: string; path: string; sizeBytes: number }[] {
  const dir = resolveCacheDir(cacheDir);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".gguf"))
    .map((f) => {
      const p = path.join(dir, f);
      return { name: f, path: p, sizeBytes: fs.statSync(p).size };
    });
}

export function _removeModel(name: string, cacheDir: string = ""): boolean {
  const p = path.join(resolveCacheDir(cacheDir), name);
  if (!fs.existsSync(p)) {
    return false;
  }
  fs.rmSync(p);
  return true;
}

// Cached so we don't shell out repeatedly per process.
let cachedGlobalRoots: string[] | null = null;

/** Discover global `node_modules` roots reported by `npm` and `pnpm`, in that
 *  order. Each entry is the directory printed by `<tool> root -g` (which is
 *  itself a `node_modules` dir, e.g. `/opt/homebrew/lib/node_modules` for
 *  Homebrew npm, `~/Library/pnpm/global/5/node_modules` for pnpm). Failures
 *  (tool not installed, exit non-zero, dir missing) are silently skipped. */
function globalNodeModulesRoots(): string[] {
  if (cachedGlobalRoots !== null) {
    return cachedGlobalRoots;
  }
  const roots: string[] = [];
  for (const cmd of ["npm", "pnpm"]) {
    try {
      const out = execFileSync(cmd, ["root", "-g"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out && fs.existsSync(out) && !roots.includes(out)) {
        roots.push(out);
      }
    } catch {
      /* tool not installed or failed — skip */
    }
  }
  cachedGlobalRoots = roots;
  return roots;
}

/** Try to resolve `smoltalk-llama-cpp` from the given global `node_modules`
 *  roots. Each `root` is itself a `node_modules` directory (the convention
 *  `npm root -g` / `pnpm root -g` uses). Node's resolver looks for
 *  `<parent>/node_modules/<pkg>` for each parent dir it walks up, so the
 *  createRequire base must live in the root's PARENT directory — from
 *  `<root>/../_resolver.js` it correctly finds `<root>/smoltalk-llama-cpp/...`.
 *  Exported for unit-testing with a controllable list of roots. */
export function resolveSmoltalkLlamaCppFromRoots(roots: string[]): string | null {
  for (const root of roots) {
    try {
      const req = createRequire(path.join(root, "..", "_resolver.js"));
      return req.resolve("smoltalk-llama-cpp");
    } catch {
      /* not in this root — try the next */
    }
  }
  return null;
}

/** Resolve `smoltalk-llama-cpp` to the absolute path of its main entry,
 *  searching:
 *   1. The local `require` paths walking up from this file (covers in-workspace
 *      `pnpm add` and a user-project install).
 *   2. Each global `node_modules` root reported by `npm root -g` / `pnpm root -g`
 *      (covers `npm i -g` and `pnpm add -g` — the documented install methods).
 *
 *  Returns `null` if the package isn't reachable from any of those. */
export function resolveSmoltalkLlamaCppEntry(): string | null {
  try {
    return createRequire(import.meta.url).resolve("smoltalk-llama-cpp");
  } catch {
    /* not local — try global install roots */
  }
  return resolveSmoltalkLlamaCppFromRoots(globalNodeModulesRoots());
}

/** True if smoltalk-llama-cpp is reachable from the local require paths OR
 *  from a global node_modules root (npm or pnpm). */
export function _localModelsSupported(): boolean {
  return resolveSmoltalkLlamaCppEntry() !== null;
}

/** Whether the local-model commands should be allowed to run. True when
 *  smoltalk-llama-cpp is installed OR the caller has supplied their own
 *  provider module via AGENCY_LLAMA_PROVIDER_MODULE. Mirrors the gate inside
 *  `requireSupport()`; used by the CLI so `agency local download/list/remove`
 *  works in the override scenario (otherwise the CLI would exit 1 even though
 *  the underlying TS functions would happily run). */
export function hasLocalModelSupport(): boolean {
  if (process.env.AGENCY_LLAMA_PROVIDER_MODULE) {
    return true;
  }
  return _localModelsSupported();
}

/** Expose the resolved `smoltalk-llama-cpp` entry path to the bundled
 *  `llama-cpp.mjs` via the AGENCY_SMOLTALK_LLAMA_CPP_PATH env var, so that
 *  the bundled module can dynamically import it even when the package lives
 *  in a global `node_modules` that isn't on this file's resolution path.
 *  Idempotent. */
function exposeResolvedLlamaCppPath(): void {
  if (process.env.AGENCY_SMOLTALK_LLAMA_CPP_PATH) {
    return;
  }
  const entry = resolveSmoltalkLlamaCppEntry();
  if (entry !== null) {
    process.env.AGENCY_SMOLTALK_LLAMA_CPP_PATH = entry;
  }
}

type LlamaBundle = {
  resolveModel?: (uriOrPath: string, cacheDir: string) => Promise<string>;
};

/** Absolute fs path of the bundled llama-cpp provider module. Tests/advanced
 *  callers can override via AGENCY_LLAMA_PROVIDER_MODULE (also an fs path).
 *  The override is normalized to an absolute path so `_downloadModel`'s
 *  `pathToFileURL(...)` call works even when callers pass a relative path
 *  (which `loadProviderModuleByPath` would itself happily resolve, but the
 *  download path bypasses that helper). */
function bundledLlamaModule(): string {
  const override = process.env.AGENCY_LLAMA_PROVIDER_MODULE;
  if (override !== undefined && override !== "") {
    return path.isAbsolute(override) ? override : path.resolve(process.cwd(), override);
  }
  return fileURLToPath(new URL("./providers/llama-cpp.mjs", import.meta.url));
}

/** Guard the install-required commands. If the user set
 *  AGENCY_LLAMA_PROVIDER_MODULE they're supplying a provider module directly,
 *  so skip the smoltalk-llama-cpp resolve check. */
function requireSupport(): void {
  if (process.env.AGENCY_LLAMA_PROVIDER_MODULE) {
    return;
  }
  if (!_localModelsSupported()) {
    throw new Error("Local models need smoltalk-llama-cpp — run: npm i -g smoltalk-llama-cpp");
  }
}

/** Register the llama-cpp provider into agency's own smoltalk. */
export async function _registerLocalProvider(): Promise<void> {
  requireSupport();
  exposeResolvedLlamaCppPath();
  await loadProviderModuleByPath(bundledLlamaModule());
}

/** Resolve a name/uri/path to a local .gguf path, downloading if needed. */
export async function _downloadModel(value: string, cacheDir: string = ""): Promise<string> {
  requireSupport();
  exposeResolvedLlamaCppPath();
  const target = _resolveModelName(value);
  const fsPath = bundledLlamaModule();
  let mod: LlamaBundle;
  try {
    // eslint-disable-next-line no-restricted-syntax -- on-demand load of the optional provider module
    mod = (await import(pathToFileURL(fsPath).href)) as LlamaBundle;
  } catch (err) {
    throw new Error(`Failed to load the local-model provider: ${(err as Error).message}`);
  }
  if (typeof mod.resolveModel !== "function") {
    throw new Error(`Local-model provider module must export resolveModel().`);
  }
  return await mod.resolveModel(target, resolveCacheDir(cacheDir));
}

/** Convenience: register the provider + ensure the model is downloaded. */
export async function _registerLocalModel(value: string, cacheDir: string = ""): Promise<string> {
  await _registerLocalProvider();
  return await _downloadModel(value, cacheDir);
}
