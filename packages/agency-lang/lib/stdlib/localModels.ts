import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";
import { findFileUp } from "../importPaths.js";
import { loadProviderModuleByPath } from "../runtime/providerModules.js";
import { ttyColor } from "../utils/termcolors.js";

/** What a model is FOR — a single axis, orthogonal to size (size is conveyed
 *  by `params` / `sizeBytes`). Lets the CLI group + filter without parsing the
 *  description. */
export type ModelCategory =
  | "general"     // general-purpose chat / instruct
  | "coding"      // SWE-tuned specialists
  | "reasoning"   // chain-of-thought / R1-style distills
  | "embedding";  // returns vectors, not text

export type ModelInfo = {
  /** Hugging Face URI passed to `node-llama-cpp`'s `resolveModelFile`. */
  uri: string;
  /** Human-readable parameter count, e.g. "1.7B" or "70B". */
  params: string;
  /** Approximate Q4_K_M download size in bytes. */
  sizeBytes: number;
  /** What the model is for (orthogonal to size). */
  category: ModelCategory;
  /** One-line "what is it good for" — shown by `agency local alias list`. */
  description: string;
  /** Native context window in tokens. */
  contextWindow: number;
  /** License identifier (SPDX-ish). Curated entries are permissive only
   *  (apache-2.0 / mit); restrictively-licensed models (gemma, llama) are
   *  intentionally excluded. */
  license: string;
  /** Pinned content SHA-256 (hex) of the resolved single-file GGUF, used to
   *  verify the download. Absent for sharded models (see issue #348). */
  sha256?: string;
};

/** Curated short-name → ModelInfo catalog. Permissive licenses only
 *  (apache-2.0 / mit). Ordered roughly by size within each grouping. */
export const CURATED_LOCAL_MODELS: Record<string, ModelInfo> = {
  // ── General ─────────────────────────────────────────────────────────────
  "smollm2-135m": {
    uri: "hf:unsloth/SmolLM2-135M-Instruct-GGUF:Q4_K_M",
    sha256: "ed5fa30c487b282ec156c29062f1222e5c20875a944ac98289dbd242e947f747",
    params: "135M", sizeBytes: 105_000_000, category: "general",
    contextWindow: 8192, license: "apache-2.0",
    description: "Smallest practical chat model; used by our integration tests, runs anywhere.",
  },
  "qwen3.5-0.8b": {
    uri: "hf:unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M",
    sha256: "bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517",
    params: "0.8B", sizeBytes: 500_000_000, category: "general",
    contextWindow: 131072, license: "apache-2.0",
    description: "Tiny model from Alibaba's current generation; good edge-device default.",
  },
  "qwen3.5-2b": {
    uri: "hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
    sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
    params: "2B", sizeBytes: 1_280_000_000, category: "general",
    contextWindow: 131072, license: "apache-2.0",
    description: "Most popular modern small general model; runs on CPU comfortably.",
  },
  "qwen3.5-4b": {
    uri: "hf:unsloth/Qwen3.5-4B-GGUF:Q4_K_M",
    sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
    params: "4B", sizeBytes: 2_400_000_000, category: "general",
    contextWindow: 131072, license: "apache-2.0",
    description: "Strong multilingual small general workhorse from Alibaba.",
  },
  "qwen3.5-9b": {
    uri: "hf:unsloth/Qwen3.5-9B-GGUF:Q4_K_M",
    sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
    params: "9B", sizeBytes: 5_500_000_000, category: "general",
    contextWindow: 131072, license: "apache-2.0",
    description: "Modern medium general model with strong tool use; 128K context.",
  },
  "gpt-oss-20b": {
    uri: "hf:unsloth/gpt-oss-20b-GGUF:Q4_K_M",
    sha256: "c27536640e410032865dc68781d80a08b98f8db5e93575919af8ccc0568aeb4f",
    params: "20B", sizeBytes: 12_000_000_000, category: "general",
    contextWindow: 131072, license: "apache-2.0",
    description: "OpenAI's open-weights release; balanced general model for ~16 GB machines.",
  },
  "mistral-small-3.1": {
    uri: "hf:unsloth/Mistral-Small-3.1-24B-Instruct-2503-GGUF:Q4_K_M",
    sha256: "6d670773c3908584349d41a5048d1472226b593c881fd394e8ac196c802e81e2",
    params: "24B", sizeBytes: 14_000_000_000, category: "general",
    contextWindow: 131072, license: "apache-2.0",
    description: "Mistral's general 24B base model (also Devstral's foundation); broad utility.",
  },
  "qwen3.5-27b": {
    uri: "hf:unsloth/Qwen3.5-27B-GGUF:Q4_K_M",
    sha256: "84b5f7f112156d63836a01a69dc3f11a6ba63b10a23b8ca7a7efaf52d5a2d806",
    params: "27B", sizeBytes: 16_000_000_000, category: "general",
    contextWindow: 131072, license: "apache-2.0",
    description: "Modern dense general 27B; the practical ceiling for most workstations.",
  },

  // ── Reasoning ───────────────────────────────────────────────────────────
  "deepseek-r1-distill-llama-8b": {
    uri: "hf:unsloth/DeepSeek-R1-Distill-Llama-8B-GGUF:Q4_K_M",
    sha256: "0addb1339a82385bcd973186cd80d18dcc71885d45eabd899781a118d03827d9",
    params: "8B", sizeBytes: 4_920_000_000, category: "reasoning",
    contextWindow: 131072, license: "mit",
    description: "Chain-of-thought distill into Llama-8B; best small reasoning model.",
  },
  "phi-4-reasoning": {
    uri: "hf:unsloth/Phi-4-reasoning-GGUF:Q4_K_M",
    sha256: "960d3870b218f91116c55bf81dc313e6cdbce31b1047bb2bc8bc7ea47899b032",
    params: "14B", sizeBytes: 9_050_000_000, category: "reasoning",
    contextWindow: 32768, license: "mit",
    description: "Microsoft's reasoning-tuned 14B; competitive with much larger models on math/logic.",
  },

  // ── Coding ──────────────────────────────────────────────────────────────
  "devstral-small-2507": {
    uri: "hf:mistralai/Devstral-Small-2507_gguf:Q4_K_M",
    sha256: "1bcc2b1b7b7ea3168ba2dbe782432c464f2240598bd193930122c41b117c1796",
    params: "24B", sizeBytes: 14_300_000_000, category: "coding",
    contextWindow: 131072, license: "apache-2.0",
    description: "Mistral's official coding-agent GGUF; #1 open-source on SWE-Bench at release.",
  },
  "qwen3-coder-30b-a3b": {
    uri: "hf:unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M",
    sha256: "fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad",
    params: "30B (A3B)", sizeBytes: 19_000_000_000, category: "coding",
    contextWindow: 262144, license: "apache-2.0",
    description: "Qwen's MoE coder (3.3B active); strong agentic coding + 256K context.",
  },

  // ── Embedding ───────────────────────────────────────────────────────────
  "nomic-embed-text": {
    uri: "hf:nomic-ai/nomic-embed-text-v1.5-GGUF:Q4_K_M",
    sha256: "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac",
    params: "137M", sizeBytes: 89_000_000, category: "embedding",
    contextWindow: 8192, license: "apache-2.0",
    description: "Returns 768-dim embeddings; pair with a chat model for RAG.",
  },
};

/** Where downloaded models live, in precedence order:
 *   1. `AGENCY_MODELS_DIR` env var (per-machine override).
 *   2. `client.modelsDir` in the nearest `agency.json` (read at runtime, like
 *      `modelAliases`), so the CLI and the agent share one configurable dir.
 *   3. `~/.agency-agent/models` (the default; shared with the agent so a CLI
 *      `agency local download` pre-populates what `agency agent --local-model`
 *      reuses). */
export function defaultCacheDir(): string {
  if (process.env.AGENCY_MODELS_DIR) {
    return process.env.AGENCY_MODELS_DIR;
  }
  const configured = readJson(resolveAliasConfigPath()).client?.modelsDir;
  if (typeof configured === "string" && configured.length > 0) {
    return configured;
  }
  return path.join(os.homedir(), ".agency-agent", "models");
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

/** A model URI we'll accept from the *remote catalog*. Stricter than
 *  `isModelUri`: any `scheme://` URL must be `https://` (so an overridden or
 *  untrusted catalog can't point a download at a plaintext, MITM-able
 *  endpoint — not even an `http://…/x.gguf`). Otherwise accept an `hf:` URI or
 *  a local `.gguf` path. */
function isCatalogUri(v: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) {
    return /^https:\/\//.test(v);
  }
  return v.startsWith("hf:") || isGgufPath(v);
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

/** A model alias value: either the bare URI (hand-edit shorthand) or an
 *  object carrying the URI plus optional display metadata. `source: "remote"`
 *  marks an entry written by `agency local refresh` (see `_refreshCatalog`);
 *  hand-added aliases have no `source`. */
export type AliasObject = {
  uri: string;
  source?: "remote";
  params?: string;
  sizeBytes?: number;
  category?: ModelCategory;
  contextWindow?: number;
  license?: string;
  description?: string;
  sha256?: string;
};

export type AliasValue = string | AliasObject;

/** The URI an alias points at, regardless of string/object form. */
export function aliasUri(value: AliasValue): string {
  return typeof value === "string" ? value : value.uri;
}

export function readModelAliases(file: string = ""): Record<string, AliasValue> {
  const cfg = readJson(resolveAliasFile(file));
  return (cfg.client?.modelAliases ?? {}) as Record<string, AliasValue>;
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
  sha256?: string;
};

export function _resolveModelName(value: string, file: string = ""): string {
  if (isGgufPath(value) || isModelUri(value)) {
    return value;
  }
  const aliases = readModelAliases(file);
  const aliasVal = aliases[value];
  const aliasTarget = aliasVal === undefined ? undefined : aliasUri(aliasVal);
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

type EntryMeta = Pick<
  ModelNameEntry,
  "params" | "sizeBytes" | "category" | "description" | "contextWindow" | "license" | "sha256"
>;

/** Project the optional display-metadata fields off any source shape
 *  (`ModelInfo`, or an alias which may be a bare URI string). A string alias
 *  carries no metadata, so it yields `{}` — which is why the call sites can
 *  pass an `AliasValue` directly without a `typeof` guard. Returns only
 *  defined fields so the spread doesn't introduce stray `undefined` keys. */
function metaFrom(src: string | Partial<EntryMeta>): EntryMeta {
  if (typeof src === "string") return {};
  const out: EntryMeta = {};
  if (src.params !== undefined) out.params = src.params;
  if (src.sizeBytes !== undefined) out.sizeBytes = src.sizeBytes;
  if (src.category !== undefined) out.category = src.category;
  if (src.description !== undefined) out.description = src.description;
  if (src.contextWindow !== undefined) out.contextWindow = src.contextWindow;
  if (src.license !== undefined) out.license = src.license;
  if (src.sha256 !== undefined) out.sha256 = src.sha256;
  return out;
}

export function _listModelNames(file: string = ""): ModelNameEntry[] {
  const curatedEntries: ModelNameEntry[] = Object.entries(CURATED_LOCAL_MODELS).map(
    ([name, info]) => ({ name, target: info.uri, source: "curated", ...metaFrom(info) }),
  );
  const aliasEntries: ModelNameEntry[] = Object.entries(readModelAliases(file)).map(
    ([name, value]) => ({
      name,
      target: aliasUri(value),
      source: "alias",
      ...metaFrom(value),
    }),
  );
  // Alias wins on name collision: the alias entry overwrites the curated one
  // in the object literal because it comes later. `Object.values` then yields
  // exactly one entry per name.
  return Object.values(
    Object.fromEntries([...curatedEntries, ...aliasEntries].map((e) => [e.name, e])),
  );
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

// =============================================================================
// Remote catalog — fetch + validate the GitHub-hosted model list.
// =============================================================================

export const DEFAULT_CATALOG_URL =
  "https://raw.githubusercontent.com/egonSchiele/agency-lang/main/packages/agency-lang/data/model-catalog.json";

const SUPPORTED_CATALOG_VERSION = 1;

/** A validated entry from the remote catalog. Mirrors `AliasObject` minus the
 *  `source` tag (which `_refreshCatalog` adds on write). */
export type CatalogModel = {
  uri: string;
  params?: string;
  sizeBytes?: number;
  category?: ModelCategory;
  contextWindow?: number;
  license?: string;
  description?: string;
  sha256?: string;
};

/** Resolve the catalog URL: explicit arg → env → config → built-in default. */
export function resolveCatalogUrl(explicit: string = "", file: string = ""): string {
  if (explicit !== "") return explicit;
  if (process.env.AGENCY_MODEL_CATALOG_URL) return process.env.AGENCY_MODEL_CATALOG_URL;
  const configured = readJson(resolveAliasFile(file)).client?.modelCatalogUrl;
  if (typeof configured === "string" && configured.length > 0) return configured;
  return DEFAULT_CATALOG_URL;
}

const CATALOG_CATEGORIES = ["general", "coding", "reasoning", "embedding"] as const;

/** Bound on how long the default fetcher will wait for the remote catalog
 *  before aborting. Long enough to tolerate slow CI mirrors; short enough
 *  that a hung server doesn't lock up the CLI. */
const CATALOG_FETCH_TIMEOUT_MS = 15_000;

/** Bound on catalog body size. The seed catalog is well under 10 KB; a
 *  5 MB cap guards against a misconfigured URL serving an arbitrary file. */
const CATALOG_MAX_BYTES = 5_000_000;

// One catalog entry. zod does the structural validation + coercion; the merge
// reassembles a canonical-order object from `.data` (see `parseCatalog`). The
// metadata fields are `.optional().catch(undefined)` so a wrongly-typed field
// is dropped rather than failing the whole entry (lenient metadata); a
// missing/insecure `uri` fails the entry (it's then skipped + warned).
const CatalogModelSchema = z.object({
  uri: z.string().refine(isCatalogUri, "uri must be an hf:/https: URI or a .gguf path"),
  params: z.string().optional().catch(undefined),
  sizeBytes: z.number().optional().catch(undefined),
  category: z.enum(CATALOG_CATEGORIES).optional().catch(undefined),
  contextWindow: z.number().optional().catch(undefined),
  license: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  // Must be a 64-hex SHA-256; normalized to lowercase. A malformed value (from
  // an untrusted catalog) is dropped via `.catch`, not stored as a bad pin.
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/)
    .transform((s) => s.toLowerCase())
    .optional()
    .catch(undefined),
});

// Top-level catalog shape: a supported version + a name→entry object. Entries
// are validated individually (below) so one bad entry is skipped, not fatal.
const CatalogTopSchema = z.object({
  version: z.literal(SUPPORTED_CATALOG_VERSION),
  models: z.record(z.string(), z.unknown()),
});

/** Strip keys whose value is `undefined` so the resulting object is JSON-clean
 *  (no `"params": undefined` after `JSON.stringify`) and in canonical order. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Parse + validate the catalog JSON. Throws on blob-level problems (bad JSON,
 *  unsupported version, `models` not an object) so refresh aborts without
 *  touching agency.json. Skips an individual entry (with a warning) when its
 *  `uri` is missing/invalid; metadata fields with the wrong type are dropped
 *  but the entry is kept. */
export function parseCatalog(text: string): Record<string, CatalogModel> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`catalog is not valid JSON: ${(err as Error).message}`);
  }
  const top = CatalogTopSchema.safeParse(raw);
  if (!top.success) {
    // Map zod's first issue to a precise, user-facing message.
    const path = top.error.issues[0]?.path[0];
    if (path === "version") {
      throw new Error(
        `unsupported catalog version ${JSON.stringify((raw as any)?.version)}; this ` +
          `agency supports version ${SUPPORTED_CATALOG_VERSION}. Upgrade agency.`,
      );
    }
    if (path === "models") {
      throw new Error("catalog.models must be an object keyed by model name");
    }
    throw new Error("catalog must be a JSON object");
  }
  // Validate each entry independently; a bad entry is skipped + warned, not
  // fatal. Rebuild a canonical-order `CatalogModel` from the validated data.
  const entries: ([string, CatalogModel] | null)[] = Object.entries(top.data.models).map(
    ([name, entry]) => {
      const parsed = CatalogModelSchema.safeParse(entry);
      if (!parsed.success) {
        console.warn(
          `[catalog] skipping "${name}": ${parsed.error.issues[0]?.message ?? "invalid entry"}`,
        );
        return null;
      }
      const d = parsed.data;
      const model: CatalogModel = {
        uri: d.uri,
        ...compact({
          params: d.params,
          sizeBytes: d.sizeBytes,
          category: d.category,
          contextWindow: d.contextWindow,
          license: d.license,
          description: d.description,
          sha256: d.sha256,
        }),
      };
      return [name, model];
    },
  );
  return Object.fromEntries(entries.filter((e): e is [string, CatalogModel] => e !== null));
}

/** If `url` names a local file (a `file://` URL or a plain filesystem path —
 *  i.e. not an `hf:`/`http(s)://` URL), return its path; else null. Lets refresh
 *  read a catalog from disk (`agency local refresh ./catalog.json`), which also
 *  makes the merge logic integration-testable without a network round-trip. */
function catalogLocalPath(url: string): string | null {
  if (url.startsWith("file://")) return fileURLToPath(url);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) || url.startsWith("hf:")) return null;
  return url;
}

/** Read a local catalog file, enforcing the byte cap up front via `stat`. */
function readCatalogFile(path: string): string {
  const size = fs.statSync(path).size;
  if (size > CATALOG_MAX_BYTES) {
    throw new Error(`catalog file too large (${size} bytes; cap ${CATALOG_MAX_BYTES} bytes)`);
  }
  return fs.readFileSync(path, "utf-8");
}

/** Stream a response body, enforcing the byte cap as chunks arrive so a
 *  large/malicious body can't be fully buffered first. Mirrors the capped
 *  reader in `lib/stdlib/http.ts`; counts raw bytes (`byteLength`), not
 *  UTF-16 code units. */
async function readBodyCapped(res: Response, url: string, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`catalog from ${url} exceeds ${maxBytes} bytes`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

/** Default fetcher: a local file path / `file://` URL is read from disk;
 *  otherwise an HTTPS-only GET with a bounded timeout and a streamed byte cap.
 *  `http:` (and other non-https URL schemes) are rejected. */
export async function fetchCatalog(url: string): Promise<string> {
  const localPath = catalogLocalPath(url);
  if (localPath !== null) {
    return readCatalogFile(localPath);
  }
  if (!url.startsWith("https://")) {
    throw new Error(`catalog URL must be https or a local file path: ${url}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`fetch failed: HTTP ${res.status} ${res.statusText}`);
    }
    return await readBodyCapped(res, url, CATALOG_MAX_BYTES);
  } finally {
    clearTimeout(timer);
  }
}

/** Merge a complete `modelAliases` map into a config object (spread, like
 *  `withAlias` but replaces the whole map). */
function withModelAliases(
  cfg: Record<string, any>,
  aliases: Record<string, AliasValue>,
): Record<string, any> {
  return { ...cfg, client: { ...(cfg.client ?? {}), modelAliases: aliases } };
}

export type SkippedAlias = { name: string; keptUri: string; remoteUri: string };

export type RefreshResult = {
  url: string;
  file: string;
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  skipped: SkippedAlias[];
  modelCount: number;
};

/** One verdict per catalog entry. The merge ("what to write, what to report")
 *  is a `map` from catalog entries to `Classification`s; everything else is a
 *  filter/project on the resulting array. This is the entire policy of
 *  refresh — keep it pure and testable in isolation. */
type Classification =
  | { kind: "skipped"; name: string; entry: SkippedAlias }
  | { kind: "added"; name: string; value: AliasObject }
  | { kind: "updated"; name: string; value: AliasObject }
  | { kind: "unchanged"; name: string; value: AliasObject };

/** Stable JSON for value-equality. The merge writes objects with consistent
 *  key order via the spread below (`{ ...model, source: "remote" }`), so a
 *  deep equality check via `JSON.stringify` is sufficient for managed-entry
 *  diffing without pulling in `node:util.isDeepStrictEqual`. */
function sameManagedValue(prev: AliasObject, next: AliasObject): boolean {
  return JSON.stringify(prev) === JSON.stringify(next);
}

/** Classify one catalog entry against the previous state. Pure: no I/O, no
 *  mutation, deterministic. Tested via `_refreshCatalog`'s end-to-end tests. */
function classifyEntry(
  name: string,
  model: CatalogModel,
  userAliases: Record<string, AliasValue>,
  oldManaged: Record<string, AliasObject>,
): Classification {
  // Own-property checks (not `name in ...` / bare index access): a catalog
  // model named like a prototype member (`toString`, `__proto__`, …) must not
  // be treated as a collision with — or a previous value from — an inherited
  // property the user never set.
  const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  if (has(userAliases, name)) {
    return {
      kind: "skipped",
      name,
      entry: { name, keptUri: aliasUri(userAliases[name]), remoteUri: model.uri },
    };
  }
  const value: AliasObject = { ...model, source: "remote" };
  const prev = has(oldManaged, name) ? oldManaged[name] : undefined;
  if (prev === undefined) {
    return { kind: "added", name, value };
  }
  if (sameManagedValue(prev, value)) {
    return { kind: "unchanged", name, value };
  }
  return { kind: "updated", name, value };
}

/** Predicate factory for declarative filtering by `Classification.kind`. */
function isKind<K extends Classification["kind"]>(k: K) {
  return (c: Classification): c is Extract<Classification, { kind: K }> => c.kind === k;
}

/** Fetch + validate the catalog, then rewrite the `source:"remote"` aliases in
 *  agency.json from it. User-owned aliases are preserved and win on name
 *  collisions (the remote entry is skipped). Throws (leaving the file
 *  untouched) on fetch/parse/validation failure. */
export async function _refreshCatalog(
  opts: { url?: string; fetcher?: (url: string) => Promise<string>; file?: string } = {},
): Promise<RefreshResult> {
  const file = resolveAliasFile(opts.file ?? "");
  const url = resolveCatalogUrl(opts.url ?? "", file);
  const fetcher = opts.fetcher ?? fetchCatalog;

  // Fetch + validate BEFORE reading/writing agency.json, so a failure leaves
  // the file untouched.
  const text = await fetcher(url);
  const models = parseCatalog(text);

  // Read aliases through the canonical helper (single source of truth for
  // "how aliases come out of agency.json"). `cfg` is needed separately to
  // round-trip non-alias fields back into the file on write.
  const cfg = readJson(file);
  const existing = readModelAliases(file);

  // Partition existing aliases by who manages them.
  const userAliases: Record<string, AliasValue> = Object.fromEntries(
    Object.entries(existing).filter(([, v]) => !(typeof v === "object" && v.source === "remote")),
  );
  const oldManaged: Record<string, AliasObject> = Object.fromEntries(
    Object.entries(existing).filter(
      (e): e is [string, AliasObject] => typeof e[1] === "object" && e[1].source === "remote",
    ),
  );

  // The entire merge policy: classify each catalog entry once. Everything
  // downstream is a filter/project on this array.
  const classifications: Classification[] = Object.entries(models).map(([name, model]) =>
    classifyEntry(name, model, userAliases, oldManaged),
  );

  const namesIn = <K extends Classification["kind"]>(k: K): string[] =>
    classifications.filter(isKind(k)).map((c) => c.name);

  const added = namesIn("added");
  const updated = namesIn("updated");
  const unchanged = namesIn("unchanged");
  const skipped = classifications.filter(isKind("skipped")).map((c) => c.entry);

  // What ends up in `client.modelAliases`: user aliases (untouched) plus
  // every non-skipped classification's value.
  const writtenManaged: Record<string, AliasValue> = Object.fromEntries(
    classifications.filter((c) => c.kind !== "skipped").map((c) => [c.name, (c as { value: AliasObject }).value]),
  );
  const next: Record<string, AliasValue> = { ...userAliases, ...writtenManaged };

  const surviving = [...added, ...updated, ...unchanged];
  const removed = Object.keys(oldManaged).filter((n) => !surviving.includes(n));

  writeJson(file, withModelAliases(cfg, next));
  return {
    url,
    file,
    added,
    updated,
    unchanged,
    removed,
    skipped,
    modelCount: Object.keys(models).length,
  };
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

/** Stream-hash a file's SHA-256 (hex), never buffering the whole file. The
 *  `update` is guarded so a synchronous throw in the data handler rejects the
 *  promise instead of escaping it. */
export function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => {
      try {
        hash.update(chunk);
      } catch (err) {
        stream.destroy();
        reject(err as Error);
      }
    });
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Verify `filePath` against the expected hex SHA-256. On mismatch, rename the
 *  file to `<filePath>.invalidSha` (kept for inspection; won't be picked up, so
 *  the next run re-downloads) and throw. A failed rename is logged (not
 *  swallowed) and reflected in the thrown message. */
export async function verifyModelFile(
  filePath: string,
  expected: string,
  name: string,
): Promise<void> {
  // `fileSha256` returns lowercase hex; normalize the expected pin so a
  // valid-but-uppercase hash (e.g. from a hand-written alias) still matches.
  const want = expected.toLowerCase();
  const actual = await fileSha256(filePath);
  if (actual === want) return;
  const quarantine = `${filePath}.invalidSha`;
  let moved = true;
  try {
    fs.renameSync(filePath, quarantine);
  } catch (err) {
    moved = false;
    console.warn(`Could not move "${filePath}" to "${quarantine}" after SHA-256 mismatch:`, err);
  }
  throw new Error(
    `SHA-256 verification failed for "${name}": expected ${expected}, got ${actual}. ` +
      (moved
        ? `The downloaded file was moved to ${quarantine} for inspection and will be re-downloaded next time.`
        : `The downloaded file at ${filePath} could NOT be moved aside — delete it manually before re-running.`),
  );
}

/** The pinned SHA-256 for a model name/alias, or undefined when none is known
 *  (raw uri/path, string alias, alias/curated without a hash, or a sharded
 *  model). An alias entry governs the name entirely — a user alias shadowing a
 *  curated name must NOT borrow the curated hash, but a user MAY opt in by
 *  setting their own `sha256` on the alias object. */
export function pinnedSha256(value: string, file: string = ""): string | undefined {
  if (isGgufPath(value) || isModelUri(value)) return undefined;
  const aliases = readModelAliases(file);
  if (Object.hasOwn(aliases, value)) {
    const v = aliases[value];
    return typeof v === "object" ? v.sha256 : undefined;
  }
  return CURATED_LOCAL_MODELS[value]?.sha256;
}

/** Was the resolved file freshly downloaded (not already cached)? */
export type FreshnessProbe = (resolved: string) => boolean;

/** Snapshot the cache dir, returning a probe that reports whether a resolved
 *  path is newly downloaded. node-llama-cpp stores models FLAT in `dir` with a
 *  prefixed filename — no per-repo subdirs (verified against its
 *  `buildHuggingFaceFilePrefix`) — so matching by basename is correct. */
export function snapshotFreshness(dir: string): FreshnessProbe {
  const present = fs.existsSync(dir)
    ? new Set(fs.readdirSync(dir).filter((f) => f.endsWith(".gguf")))
    : new Set<string>();
  return (resolved) => !present.has(path.basename(resolved));
}

/** Resolve a name/uri/path to a local .gguf path, downloading if needed. */
export async function _downloadModel(value: string, cacheDir: string = ""): Promise<string> {
  requireSupport();
  exposeResolvedLlamaCppPath();
  const target = _resolveModelName(value);
  const dir = resolveCacheDir(cacheDir);
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
  // Snapshot freshness BEFORE resolving so we verify the bytes only once, right
  // after a real download (a cache hit is skipped — the file can't change on
  // disk between runs).
  const wasFresh = snapshotFreshness(dir);
  const resolved = await mod.resolveModel(target, dir);
  const expected = pinnedSha256(value);
  if (expected !== undefined && wasFresh(resolved)) {
    await verifyModelFile(resolved, expected, value);
  }
  return resolved;
}

/** Convenience: register the provider + ensure the model is downloaded. */
export async function _registerLocalModel(value: string, cacheDir: string = ""): Promise<string> {
  await _registerLocalProvider();
  return await _downloadModel(value, cacheDir);
}

// =============================================================================
// Catalog rendering — shared by `agency local alias list` and the agent's
// bare `--local-model` discovery output, so both show an identical table.
// =============================================================================

const BYTES_PER_GB = 1e9;

export function formatGB(bytes: number): string {
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
}

/** Context window in compact units: 8192 → "8K", 131072 → "128K", 1e7 → "10M". */
export function formatCtx(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`;
  return `${tokens}`;
}

/** Width of a column: the longer of its header and its widest value. */
function colWidth(header: string, values: string[]): number {
  return Math.max(header.length, ...values.map((v) => v.length));
}

/** Render the usable-model list as an aligned table: a header row plus one
 *  fact row per curated model (params, category, size, context window,
 *  license), the description on a dimmed line below, a blank line between
 *  models. User aliases (which carry no metadata) follow in an ALIASES
 *  section as `name → target`. Returns the block as a string with no trailing
 *  newline (the caller's `console.log` adds exactly one). */
export function formatModelCatalog(): string {
  const entries = _listModelNames();
  const hasMetadata = (m: ModelNameEntry): boolean =>
    m.params !== undefined ||
    m.sizeBytes !== undefined ||
    m.category !== undefined ||
    m.contextWindow !== undefined ||
    m.license !== undefined ||
    m.description !== undefined;
  const curated = entries.filter(hasMetadata); // table rows: built-ins + rich aliases
  const aliases = entries.filter((m) => !hasMetadata(m)); // plain name→uri only
  const lines: string[] = [];

  if (curated.length > 0) {
    const rows = curated.map((m) => ({
      name: m.name,
      params: m.params ?? "",
      category: m.category ?? "",
      size: m.sizeBytes ? formatGB(m.sizeBytes) : "?",
      ctx: m.contextWindow ? formatCtx(m.contextWindow) : "",
      license: m.license ?? "",
      description: m.description ?? "",
    }));
    // Computed widths so columns fit the actual data (names range from ~10
    // to ~28 chars). SIZE and CTX are numeric, so they right-align.
    const w = {
      name: colWidth("NAME", rows.map((r) => r.name)),
      params: colWidth("PARAMS", rows.map((r) => r.params)),
      category: colWidth("CATEGORY", rows.map((r) => r.category)),
      size: colWidth("SIZE", rows.map((r) => r.size)),
      ctx: colWidth("CTX", rows.map((r) => r.ctx)),
    };
    const row = (
      name: string,
      params: string,
      category: string,
      size: string,
      ctx: string,
      license: string,
    ): string =>
      `${name.padEnd(w.name)}  ${params.padEnd(w.params)}  ${category.padEnd(
        w.category,
      )}  ${size.padStart(w.size)}  ${ctx.padStart(w.ctx)}  ${license}`;

    // LICENSE is the last column, so it needs no trailing pad.
    lines.push(ttyColor.bold(row("NAME", "PARAMS", "CATEGORY", "SIZE", "CTX", "LICENSE")));
    rows.forEach((r, i) => {
      // Blank line *between* models, not after the last one, so the joined
      // string has no trailing newline (console.log adds exactly one).
      if (i > 0) lines.push("");
      lines.push(row(r.name, r.params, r.category, r.size, r.ctx, r.license));
      if (r.description) lines.push(ttyColor.dim(`    ${r.description}`));
    });
  }

  if (aliases.length > 0) {
    if (lines.length > 0) lines.push(""); // separate the table from ALIASES
    lines.push(ttyColor.bold("ALIASES"));
    for (const a of aliases) {
      lines.push(`${a.name} → ${a.target}`);
    }
  }

  return lines.join("\n");
}

/** Print the model catalog to stdout. The agent's bare `--local-model`
 *  path calls this through `std::agency/local`. */
export function _printLocalCatalog(): void {
  console.log(formatModelCatalog());
}
