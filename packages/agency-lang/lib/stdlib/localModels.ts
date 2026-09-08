import {
  root,
  wholePath,
  stat,
  list,
  remove,
  readText,
  writeText,
  type Root,
} from "./contained.js";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { findFileUp } from "../importPaths.js";
import {
  loadLocalProvider,
  loadLocalProviderDetailed,
  resolveSmoltalkLlamaCppEntry,
} from "../runtime/localProvider.js";
import { __ctx } from "../runtime/asyncContext.js";
import { recordDownload, readDownloadManifest } from "./localModelManifest.js";
import { fileSha256, verifyModelFile } from "./modelVerify.js";
import {
  fetchHubSnapshot,
  downloadHubSnapshot,
  DEFAULT_CONCURRENCY,
  type DownloadOptions,
} from "./hubDownload.js";
export { fileSha256, verifyModelFile } from "./modelVerify.js";
import {
  type Backend,
  isGgufPath,
  isMlxUri,
  parseMlxUri,
  isModelDir,
  modelDirEntries,
  backendOfTarget,
} from "./modelBackend.js";
export {
  type Backend,
  isMlxUri,
  parseMlxUri,
  isModelDir,
  modelDirEntries,
  backendOfTarget,
} from "./modelBackend.js";
import {
  MLX_SUBDIR,
  mlxModelDir,
  mlxModelDirName,
  readMlxModelRecord,
  isMlxModelComplete,
} from "./mlxModelRecord.js";
import { ttyColor } from "../utils/termcolors.js";

import { CURATED_LOCAL_MODELS, type ModelCategory, type ModelInfo } from "./modelCatalog.js";
export { CURATED_LOCAL_MODELS, type ModelCategory, type ModelInfo } from "./modelCatalog.js";

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
  const configured = readClientConfig().modelsDir;
  if (typeof configured === "string" && configured.length > 0) {
    return configured;
  }
  return path.join(os.homedir(), ".agency-agent", "models");
}

/** Treat empty string as "caller wants the default cache dir". */
function resolveCacheDir(cacheDir: string): string {
  return cacheDir === "" ? defaultCacheDir() : cacheDir;
}

/** The resolved models cache dir (AGENCY_MODELS_DIR env → agency.json
 *  client.modelsDir → ~/.agency-agent/models). Exported so `agency local
 *  list` can name where downloads land. */
export function _modelsCacheDir(cacheDir: string = ""): string {
  return resolveCacheDir(cacheDir);
}

function isModelUri(v: string): boolean {
  return /^(hf:|https?:|mlx:)/.test(v);
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
  return v.startsWith("hf:") || isMlxUri(v) || isGgufPath(v);
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

/** Read a JSON file as a plain object. A missing file reads as `{}`. */
/** The `client` object of the nearest `agency.json`, or `{}` when there is
 *  none. For settings read at runtime rather than compiled in: the models
 *  directory, the MLX Python, the MLX base URL. */
export function readClientConfig(): Record<string, any> {
  return readJson(resolveAliasConfigPath()).client ?? {};
}

function readJson(file: string): Record<string, any> {
  const located = wholePath(file);
  if (stat(located.root, located.target) === null) {
    return {};
  }
  try {
    return JSON.parse(readText(located.root, located.target));
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
  const located = wholePath(file);
  writeText(located.root, located.target, JSON.stringify(value, null, 2) + "\n");
}

/** A model alias value: either the bare URI (hand-edit shorthand) or an
 *  object carrying the URI plus optional display metadata. `source: "remote"`
 *  marks an entry written by `agency local refresh` (see `_refreshCatalog`);
 *  hand-added aliases have no `source`. */
export type AliasObject = {
  backend: Backend;
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

/** Read `client.modelAliases`. An object alias must carry a `backend` that
 *  agrees with its uri; a string alias reads its backend from its prefix. */
export function readModelAliases(file: string = ""): Record<string, AliasValue> {
  const resolved = resolveAliasFile(file);
  const cfg = readJson(resolved);
  const aliases = (cfg.client?.modelAliases ?? {}) as Record<string, AliasValue>;
  for (const [name, value] of Object.entries(aliases)) {
    if (typeof value === "string") {
      continue;
    }
    if (value.backend === undefined) {
      throw new Error(
        `${path.basename(resolved)}: alias "${name}" has no "backend". ` +
          `Add "backend": "llama-cpp" or "backend": "mlx" to the entry in ${resolved}.`,
      );
    }
    const fromUri = backendOfTarget(value.uri);
    if (value.backend !== fromUri) {
      const what = fromUri === "llama-cpp" ? "a GGUF file" : "an MLX model";
      throw new Error(
        `${path.basename(resolved)}: alias "${name}" says backend "${value.backend}" ` +
          `but its uri "${value.uri}" is ${what}. Change one of them in ${resolved}.`,
      );
    }
  }
  return aliases;
}

/** Entry returned by `_listModelNames`. */
export type ModelNameEntry = {
  name: string;
  backend: Backend;
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

/** A model name resolved to the engine that runs it and the target that
 *  engine takes: an `hf:` URI or `.gguf` path for llama-cpp, an `mlx:` URI
 *  or a model directory for mlx. */
export type ResolvedModel = { backend: Backend; target: string };

export function _resolveModel(value: string, file: string = ""): ResolvedModel {
  if (isGgufPath(value) || isModelUri(value) || isModelDir(value)) {
    return { backend: backendOfTarget(value), target: value };
  }
  const aliases = readModelAliases(file);
  const aliasVal = aliases[value];
  if (aliasVal !== undefined) {
    const target = aliasUri(aliasVal);
    return { backend: backendOfTarget(target), target };
  }
  const curated = CURATED_LOCAL_MODELS[value];
  if (curated !== undefined) {
    return { backend: curated.backend, target: curated.uri };
  }
  const names = [...Object.keys(CURATED_LOCAL_MODELS), ...Object.keys(aliases)].join(", ");
  throw new Error(
    `Unknown local model "${value}". Known names: ${names || "(none)"}; ` +
      `or pass a .gguf path, an "hf:" URI, an "mlx:" URI, or a model directory.`,
  );
}

export function _resolveModelName(value: string, file: string = ""): string {
  return _resolveModel(value, file).target;
}

/** The model name to send to the MLX server for this model. `agency local
 *  serve` gives the server the same string, so a run against your own server
 *  never names a model it is not serving. A repo id for an `mlx:` URI; the
 *  absolute directory path for a model directory. */
export function _mlxServedName(resolved: ResolvedModel): string {
  if (isMlxUri(resolved.target)) {
    return parseMlxUri(resolved.target).repo;
  }
  return path.resolve(resolved.target);
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
    ([name, info]) => ({
      name,
      backend: info.backend,
      target: info.uri,
      source: "curated",
      ...metaFrom(info),
    }),
  );
  const aliasEntries: ModelNameEntry[] = Object.entries(readModelAliases(file)).map(
    ([name, value]) => ({
      name,
      backend: backendOfTarget(aliasUri(value)),
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
  const located = wholePath(resolved);
  if (stat(located.root, located.target) === null) {
    return { file: resolved, removed: false };
  }
  const cfg = readJson(resolved);
  if (!cfg.client?.modelAliases || !(name in cfg.client.modelAliases)) {
    return { file: resolved, removed: false };
  }
  writeJson(resolved, withAlias(cfg, name, undefined));
  return { file: resolved, removed: true };
}

/** One model on disk. For a GGUF file, `name` is the file name. For an MLX
 *  model, `name` is the repo id and `path` is its directory. */
export type DownloadedModel = {
  name: string;
  path: string;
  sizeBytes: number;
  backend: Backend;
  /** False for an MLX model whose download was interrupted. */
  complete: boolean;
  /** The commit an MLX model was downloaded from. Absent for GGUF. */
  revision?: string;
};

export function _listDownloadedModels(cacheDir: string = ""): DownloadedModel[] {
  const dir = resolveCacheDir(cacheDir);
  const gguf: DownloadedModel[] = ggufEntries(dir).map((entry) => ({
    name: entry.name,
    path: path.join(dir, entry.name),
    sizeBytes: entry.size,
    backend: "llama-cpp",
    complete: true,
  }));
  return [...gguf, ...mlxEntries(dir)];
}

/** The MLX model directories under `<dir>/mlx` that carry a record. */
function mlxEntries(dir: string): DownloadedModel[] {
  const mlxDir = path.join(dir, MLX_SUBDIR);
  const cache = root(dir);
  if (stat(cache, MLX_SUBDIR) === null) {
    return [];
  }
  const out: DownloadedModel[] = [];
  for (const entry of list(cache, MLX_SUBDIR)) {
    if (entry.type !== "dir") {
      continue;
    }
    const modelDir = path.join(mlxDir, entry.name);
    const record = readMlxModelRecord(modelDir);
    if (record === null) {
      continue;
    }
    const sizeBytes = treeSizeBytes(root(modelDir), ".");
    out.push({
      name: record.repo,
      path: modelDir,
      sizeBytes,
      backend: "mlx",
      complete: isMlxModelComplete(record),
      revision: record.revision,
    });
  }
  return out;
}

/** Every regular file under `target`, subdirectories included, summed. */
function treeSizeBytes(r: Root, target: string): number {
  let sum = 0;
  for (const entry of list(r, target)) {
    const child = path.join(target, entry.name);
    if (entry.type === "file") {
      sum += entry.size;
    } else if (entry.type === "dir") {
      sum += treeSizeBytes(r, child);
    }
  }
  return sum;
}

/** The `.gguf` files directly in `dir`, by name. A missing dir has none. */
function ggufEntries(dir: string): { name: string; size: number }[] {
  const cache = root(dir);
  if (stat(cache, ".") === null) {
    return [];
  }
  return list(cache, ".")
    .filter((entry) => entry.type === "file" && entry.name.endsWith(".gguf"))
    .map((entry) => ({ name: entry.name, size: entry.size }));
}

/** Delete one model file from the cache dir. `name` must be a plain file
 *  name inside it: `resolveUnder` refuses `..` and symlinks, and a missing
 *  file or a non-file returns false. */
export function _removeModel(name: string, cacheDir: string = ""): boolean {
  const cache = root(resolveCacheDir(cacheDir));
  const info = stat(cache, name);
  if (info === null || !info.isFile()) {
    return false;
  }
  remove(cache, name);
  return true;
}

/** Delete an MLX model directory from the cache. Only a directory under
 *  `<cacheDir>/mlx` is ever removed; `remove` refuses symlinks. */
export function _removeMlxModel(repo: string, cacheDir: string = ""): boolean {
  const cache = root(path.join(resolveCacheDir(cacheDir), MLX_SUBDIR));
  const name = mlxModelDirName(repo);
  const info = stat(cache, name);
  if (info === null || !info.isDirectory()) {
    return false;
  }
  remove(cache, name);
  return true;
}

/** Where a resolved model's files are on disk, or null when nothing is
 *  there. A GGUF model is found through the download manifest; an MLX model
 *  through its record under the cache, or the directory it points at. */
export function _modelFilesOnDisk(
  resolved: ResolvedModel,
  cacheDir: string = "",
): { path: string; sizeBytes: number; insideCache: boolean } | null {
  const dir = resolveCacheDir(cacheDir);
  const onDisk = _listDownloadedModels(dir);
  const found = (match: (f: DownloadedModel) => boolean) => {
    const f = onDisk.find(match);
    return f === undefined ? null : { path: f.path, sizeBytes: f.sizeBytes, insideCache: true };
  };
  if (resolved.backend === "llama-cpp") {
    if (isGgufPath(resolved.target)) {
      return found((f) => f.path === path.resolve(resolved.target));
    }
    const fileName = readDownloadManifest(dir)[resolved.target];
    return fileName === undefined ? null : found((f) => f.name === fileName);
  }
  if (isMlxUri(resolved.target)) {
    const modelDir = mlxModelDir(dir, parseMlxUri(resolved.target).repo);
    return found((f) => f.path === modelDir);
  }
  const target = path.resolve(resolved.target);
  const sizeBytes = modelDirEntries(target).reduce((sum, f) => sum + f.size, 0);
  return { path: target, sizeBytes, insideCache: onDisk.some((f) => f.path === target) };
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
  backend: Backend;
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

const CATALOG_CATEGORIES = [
  "general",
  "coding",
  "reasoning",
  "writing",
  "science",
  "uncensored",
  "embedding",
] as const;

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
const CatalogModelSchema = z
  .object({
    backend: z.enum(["llama-cpp", "mlx"]),
    uri: z.string().refine(isCatalogUri, "uri must be an hf:/mlx:/https: URI or a .gguf path"),
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
  })
  .refine((m) => !isCatalogUri(m.uri) || m.backend === backendOfTarget(m.uri), {
    message: "backend does not match the uri",
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
        backend: d.backend,
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
function readCatalogFile(file: string): string {
  const located = wholePath(file);
  const info = stat(located.root, located.target);
  if (info === null) {
    throw new Error(`catalog file not found: ${file}`);
  }
  if (info.size > CATALOG_MAX_BYTES) {
    throw new Error(`catalog file too large (${info.size} bytes; cap ${CATALOG_MAX_BYTES} bytes)`);
  }
  return readText(located.root, located.target);
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
      entry: {
        name,
        keptUri: aliasUri(userAliases[name]),
        remoteUri: model.uri,
      },
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
  opts: {
    url?: string;
    fetcher?: (url: string) => Promise<string>;
    file?: string;
  } = {},
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
    classifications
      .filter((c) => c.kind !== "skipped")
      .map((c) => [c.name, (c as { value: AliasObject }).value]),
  );
  const next: Record<string, AliasValue> = {
    ...userAliases,
    ...writtenManaged,
  };

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

/** Register the llama-cpp provider into agency's own smoltalk. When called
 *  from inside a run (the agent's --local path), emit the `localModelLoaded`
 *  statelog event saying where the provider package came from; the plain CLI
 *  has no runtime frame, so `__ctx()` is undefined there and nothing is
 *  emitted. */
export async function _registerLocalProvider(): Promise<void> {
  requireSupport();
  const { choice } = await loadLocalProviderDetailed();
  void __ctx()?.statelogClient.localModelLoaded({
    entryPath: choice.entryPath,
    entrySource: choice.source,
  });
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
  const present = ggufEntries(dir).map((entry) => entry.name);
  return (resolved) => !present.includes(path.basename(resolved));
}

/** `client.mlx.downloadConcurrency` from the nearest `agency.json`, else 8.
 *  The file is read raw here, so the value is checked by hand. */
export function configuredDownloadConcurrency(): number {
  const n: unknown = readClientConfig().mlx?.downloadConcurrency;
  if (n === undefined) {
    return DEFAULT_CONCURRENCY;
  }
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new Error(
      `client.mlx.downloadConcurrency in ${resolveAliasConfigPath()} must be a positive integer, got ${JSON.stringify(n)}`,
    );
  }
  return n;
}

/** Download a model and return where it is: the `.gguf` path, or the MLX
 *  model directory. `hubOptions` lets the CLI watch progress and lets tests
 *  point at a fake hub. */
export async function _downloadModel(
  value: string,
  cacheDir: string = "",
  hubOptions: DownloadOptions = {},
): Promise<string> {
  const model = _resolveModel(value);
  if (model.backend === "mlx") {
    if (isModelDir(model.target)) {
      return path.resolve(model.target);
    }
    const { repo, revision } = parseMlxUri(model.target);
    const opts: DownloadOptions = {
      concurrency: configuredDownloadConcurrency(),
      ...hubOptions,
      token: hubOptions.token ?? process.env.HF_TOKEN,
    };
    const snapshot = await fetchHubSnapshot(repo, revision, opts);
    return await downloadHubSnapshot(snapshot, mlxModelDir(resolveCacheDir(cacheDir), repo), opts);
  }
  requireSupport();
  const target = model.target;
  const dir = resolveCacheDir(cacheDir);
  const mod = await loadLocalProvider();
  // Snapshot freshness BEFORE resolving so we verify the bytes only once, right
  // after a real download (a cache hit is skipped — the file can't change on
  // disk between runs).
  const wasFresh = snapshotFreshness(dir);
  const resolved = await mod.resolveModel(target, dir);
  const expected = pinnedSha256(value);
  if (expected !== undefined && wasFresh(resolved)) {
    await verifyModelFile(resolved, expected, value);
  }
  // Record-after-verify: an invalid-hash file throws above and is never
  // written into the manifest.
  recordDownload(dir, target, path.basename(resolved));
  return resolved;
}

/** Convenience: register the provider + ensure the model is downloaded. */
export async function _registerLocalModel(value: string, cacheDir: string = ""): Promise<string> {
  const resolved = _resolveModel(value);
  if (resolved.backend === "mlx") {
    return _mlxServedName(resolved);
  }
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

/** The `agency local list` view: every usable model (curated + aliases) with
 *  a downloaded marker, then cache-dir files no catalog entry claims. A row
 *  is "downloaded" when the manifest maps its target URI to a file that still
 *  exists in the cache dir; its SIZE column then shows the on-disk size
 *  rather than the catalog estimate. Compact and operational by default;
 *  `long` (the `-l` flag) adds each model's description on its own dimmed
 *  line, with a blank line between models so the descriptions stay readable.
 *  Returns the block with no trailing newline (the caller's `console.log`
 *  adds exactly one). */
export function formatLocalList(args: {
  dir: string;
  entries: ModelNameEntry[];
  manifest: Record<string, string>;
  files: DownloadedModel[];
  long?: boolean;
}): string {
  const byName = Object.fromEntries(args.files.map((f) => [f.name, f]));
  const byPath = Object.fromEntries(args.files.map((f) => [f.path, f]));
  // The file on disk that backs a catalog row, if any. A GGUF row goes
  // through the manifest. An MLX row matches by repo id, or by directory
  // for an alias that points straight at one.
  const fileFor = (e: ModelNameEntry): DownloadedModel | undefined => {
    if (e.backend === "llama-cpp") {
      const manifestFile = args.manifest[e.target];
      return manifestFile === undefined ? undefined : byName[manifestFile];
    }
    if (!isMlxUri(e.target)) {
      const file = byPath[e.target];
      return file !== undefined && file.complete ? file : undefined;
    }
    // A pinned revision must match what was downloaded. The pin may be a
    // short prefix of the full commit hash.
    const { repo, revision } = parseMlxUri(e.target);
    const file = byName[repo];
    if (file === undefined || !file.complete) {
      return undefined;
    }
    if (revision !== undefined && !(file.revision ?? "").startsWith(revision)) {
      return undefined;
    }
    return file;
  };
  const rows = args.entries.map((e) => {
    const file = fileFor(e);
    return {
      mark: file !== undefined ? "✓" : "",
      name: e.name,
      backend: e.backend,
      params: e.params ?? "",
      size:
        file !== undefined
          ? formatGB(file.sizeBytes)
          : e.sizeBytes !== undefined
            ? formatGB(e.sizeBytes)
            : "",
      ctx: e.contextWindow !== undefined ? formatCtx(e.contextWindow) : "",
      license: e.license ?? "",
      category: e.category ?? "",
      description: e.description ?? "",
    };
  });
  // Only files claimed by a CATALOG row are excluded from OTHER FILES. The
  // manifest also records raw-URI downloads, which have no row here — their
  // files must stay visible.
  const claimedPaths: string[] = args.entries
    .map(fileFor)
    .filter((f): f is DownloadedModel => f !== undefined)
    .map((f) => f.path);
  const others = args.files.filter((f) => !claimedPaths.includes(f.path));
  const headers = ["", "NAME", "BACKEND", "PARAMS", "SIZE", "CONTEXT", "CATEGORY", "LICENSE"];
  const cols = [
    colWidth(
      headers[0],
      rows.map((r) => r.mark),
    ),
    colWidth(
      headers[1],
      rows.map((r) => r.name),
    ),
    colWidth(
      headers[2],
      rows.map((r) => r.backend),
    ),
    colWidth(
      headers[3],
      rows.map((r) => r.params),
    ),
    colWidth(
      headers[4],
      rows.map((r) => r.size),
    ),
    colWidth(
      headers[5],
      rows.map((r) => r.ctx),
    ),
    colWidth(
      headers[6],
      rows.map((r) => r.category),
    ),
    colWidth(
      headers[7],
      rows.map((r) => r.license),
    ),
  ];
  const render = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(cols[i]))
      .join("  ")
      .trimEnd();
  // Indent descriptions two past where NAME starts (mark column + its
  // separator), so they read as nested under the model they describe.
  const descIndent = " ".repeat(cols[0] + 2 + 2);
  const lines = [`Models directory: ${args.dir}`, "", render(headers)];
  rows.forEach((r, i) => {
    // Blank line *between* models, not after the last one, so the sections
    // below (which push their own leading "") aren't double-spaced.
    if (args.long === true && i > 0) lines.push("");
    lines.push(render([r.mark, r.name, r.backend, r.params, r.size, r.ctx, r.category, r.license]));
    if (args.long === true && r.description !== "") {
      lines.push(ttyColor.dim(`${descIndent}${r.description}`));
    }
  });
  if (others.length > 0) {
    lines.push("", "OTHER FILES");
    for (const f of others) {
      const tag = f.backend === "mlx" ? (f.complete ? "  (mlx)" : "  (mlx, incomplete)") : "";
      lines.push(`  ${f.name}${tag}  ${formatGB(f.sizeBytes)}`);
    }
  }
  const total = args.files.reduce((sum, f) => sum + f.sizeBytes, 0);
  lines.push("", `Total downloaded: ${formatGB(total)}`);
  return lines.join("\n");
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
      name: colWidth(
        "NAME",
        rows.map((r) => r.name),
      ),
      params: colWidth(
        "PARAMS",
        rows.map((r) => r.params),
      ),
      category: colWidth(
        "CATEGORY",
        rows.map((r) => r.category),
      ),
      size: colWidth(
        "SIZE",
        rows.map((r) => r.size),
      ),
      ctx: colWidth(
        "CTX",
        rows.map((r) => r.ctx),
      ),
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
