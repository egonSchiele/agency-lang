import {
  root,
  wholePath,
  stat,
  list,
  remove,
  readText,
  writeText,
  isContained,
  type Root,
} from "./contained.js";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgencyConfig } from "../config/config.js";
import {
  CONFIG_FILE,
  configFiles,
  fileTarget,
  findProjectRoot,
  projectTarget,
  readConfig,
  writeTarget,
  type ConfigTarget,
} from "../config/target.js";
import {
  loadLocalProvider,
  loadLocalProviderDetailed,
  resolveSmoltalkLlamaCppEntry,
} from "../runtime/localProvider.js";
import { currentRunOrNone } from "../runtime/asyncContext.js";
import { recordDownload, readDownloadManifest } from "./localModelManifest.js";
import { fileSha256, verifyModelFile } from "./modelVerify.js";
import {
  fetchHubSnapshot,
  downloadHubSnapshot,
  DEFAULT_CONCURRENCY,
  type DownloadOptions,
} from "./hubDownload.js";
import { fetchHubFileText, type HubFile, type HubSnapshot } from "./hubClient.js";
import { diffusersFiles, hasModelIndex, MODEL_INDEX } from "./diffusersFiles.js";
import { visionFiles } from "./visionFiles.js";
export { fileSha256, verifyModelFile } from "./modelVerify.js";
import {
  type Backend,
  type ServedBackend,
  isGgufPath,
  isMlxUri,
  isServedUri,
  parseServedUri,
  isServedModelDir,
  servedDirBackend,
  modelDirSizeBytes,
  backendOfTarget,
  hubRepoOfDirName,
  hubSnapshotDir,
  hubSnapshotRevision,
  isHubSnapshotPath,
  hubDirNameOfRepo,
} from "./modelBackend.js";
export {
  type Backend,
  type ServedBackend,
  isMlxUri,
  parseMlxUri,
  isServedUri,
  parseServedUri,
  isModelDir,
  isDiffusersDir,
  modelDirEntries,
  backendOfTarget,
  hubRepoOfDirName,
  hubSnapshotDir,
} from "./modelBackend.js";
import {
  SUBDIR_FOR_BACKEND,
  servedModelDir,
  mlxModelDirName,
  readMlxModelRecord,
  writeMlxModelRecord,
  isMlxModelComplete,
} from "./mlxModelRecord.js";
import { ttyColor } from "../utils/termcolors.js";

import {
  CURATED_LOCAL_MODELS,
  type ModelCategory,
  type ModelInfo,
  type ModelTag,
} from "./modelCatalog.js";
export {
  CURATED_LOCAL_MODELS,
  type ModelCategory,
  type ModelInfo,
  type ModelTag,
} from "./modelCatalog.js";
import { isModelKind, kindOfModelDir, MODEL_KINDS, type ModelKind } from "./modelKind.js";
export { MODEL_KINDS, isModelKind, type ModelKind } from "./modelKind.js";

/** A folder the config names under `client`, or null when it is not set.
 *  A relative path is taken from the folder the config file is in, not the
 *  working directory: `"./adapters"` in `myproject/agency.json` is
 *  `myproject/adapters` even when `agency local serve` runs in
 *  `myproject/src`. */
function configuredFolder(key: "adaptersDir" | "controlnetsDir", startDir: string): string | null {
  const target = defaultAliasTarget(startDir);
  const configured = readAliasConfig(target).client?.[key];
  if (typeof configured !== "string" || configured.length === 0) {
    return null;
  }
  const configDir = target.kind === "file" ? path.dirname(target.path) : target.dir;
  return path.resolve(configDir, configured);
}

/** The folder LoRA adapters come from, `client.adaptersDir`. */
export function configuredAdaptersDir(startDir: string = process.cwd()): string | null {
  return configuredFolder("adaptersDir", startDir);
}

/** The folder ControlNets come from, `client.controlnetsDir`. */
export function configuredControlnetsDir(startDir: string = process.cwd()): string | null {
  return configuredFolder("controlnetsDir", startDir);
}

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
  return /^(hf:|https?:|mlx:|diffusers:)/.test(v);
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
  return v.startsWith("hf:") || isServedUri(v) || isGgufPath(v);
}

/** Where alias reads and writes go when the caller names no file: the nearest
 *  project at or above `startDir`, or `~/agency.json` alone. */
export function defaultAliasTarget(startDir: string = process.cwd()): ConfigTarget {
  const root = findProjectRoot(startDir);
  return root === null ? fileTarget(path.join(os.homedir(), CONFIG_FILE)) : projectTarget(root);
}

/** The file alias writes go to. Exported so the CLI can echo it. */
export function resolveAliasConfigPath(startDir: string = process.cwd()): string {
  return writeTarget(defaultAliasTarget(startDir));
}

/** The config at `target`, for reading. Throws when a file is invalid. */
function readAliasConfig(target: ConfigTarget): AgencyConfig {
  const { config, error } = readConfig(target);
  if (error !== undefined) {
    throw new Error(error);
  }
  return config;
}

function describeTarget(target: ConfigTarget): string {
  return configFiles(target).join(" or ");
}

/** Read a JSON file as a plain object. A missing file reads as `{}`. */
/** The merged `client` object of the default target, or `{}`. For settings
 *  read at runtime rather than compiled in: the models directory, the MLX
 *  Python, the MLX base URL. */
export function readClientConfig(): Record<string, any> {
  return (readAliasConfig(defaultAliasTarget()).client ?? {}) as Record<string, any>;
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
  kind?: ModelKind;
  tags?: ModelTag[];
  /** An alias written before kinds and tags. Read as both. */
  category?: ModelCategory;
  contextWindow?: number;
  license?: string;
  description?: string;
  sha256?: string;
  /** Repos this model loads by name at runtime, as mlx: URIs. */
  companions?: string[];
};

export type AliasValue = string | AliasObject;

/** The URI an alias points at, regardless of string/object form. */
export function aliasUri(value: AliasValue): string {
  return typeof value === "string" ? value : value.uri;
}

/** Read `client.modelAliases`. An object alias must carry a `backend` that
 *  agrees with its uri; a string alias reads its backend from its prefix. */
export function readModelAliases(
  target: ConfigTarget = defaultAliasTarget(),
): Record<string, AliasValue> {
  return checkedAliases(readAliasConfig(target), describeTarget(target));
}

/** The aliases in `config`, after checking each object alias's backend.
 *  `source` names where the config came from, for error messages. */
function checkedAliases(config: Record<string, any>, source: string): Record<string, AliasValue> {
  const aliases = (config.client?.modelAliases ?? {}) as Record<string, AliasValue>;
  for (const [name, value] of Object.entries(aliases)) {
    if (typeof value === "string") {
      continue;
    }
    if (value.backend === undefined) {
      throw new Error(
        `alias "${name}" has no "backend". ` +
          `Add "backend": "llama-cpp" or "backend": "mlx" to the entry in ${source}.`,
      );
    }
    const fromUri = backendOfTarget(value.uri);
    if (value.backend !== fromUri) {
      const what = fromUri === "llama-cpp" ? "a GGUF file" : "an MLX model";
      throw new Error(
        `alias "${name}" says backend "${value.backend}" ` +
          `but its uri "${value.uri}" is ${what}. Change one of them in ${source}.`,
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
  kind?: ModelKind;
  tags?: ModelTag[];
  description?: string;
  contextWindow?: number;
  license?: string;
  sha256?: string;
};

/** A model name resolved to the engine that runs it and the target that
 *  engine takes: an `hf:` URI or `.gguf` path for llama-cpp, an `mlx:` URI
 *  or a model directory for mlx. */
export type ResolvedModel = { backend: Backend; target: string };

/** A Hugging Face cache folder stands for the snapshot it points at, so
 *  `…/models--org--repo` and `…/models--org--repo/snapshots/<sha>` name the
 *  same model. Anything else is returned unchanged. */
function asModelDir(value: string): string {
  if (isGgufPath(value) || isModelUri(value) || isServedModelDir(value)) {
    return value;
  }
  return hubSnapshotDir(value) ?? value;
}

/** A bare Hugging Face repo id, `org/repo`. Accepted only when a model with
 *  that id is on disk, so it can never be confused with a relative path. */
function isRepoId(value: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(value);
}

export function _resolveModel(
  value: string,
  configTarget: ConfigTarget = defaultAliasTarget(),
): ResolvedModel {
  const target = asModelDir(value);
  if (isGgufPath(target) || isModelUri(target) || isServedModelDir(target)) {
    return { backend: backendOfTarget(target), target };
  }
  const aliases = readModelAliases(configTarget);
  const aliasVal = aliases[value];
  if (aliasVal !== undefined) {
    const aliasTarget = asModelDir(aliasUri(aliasVal));
    return { backend: backendOfTarget(aliasTarget), target: aliasTarget };
  }
  const curated = CURATED_LOCAL_MODELS[value];
  if (curated !== undefined) {
    return { backend: curated.backend, target: curated.uri };
  }
  // A repo id you already have needs no `mlx:` or `diffusers:` prefix. The
  // prefix stays the spelling that always works, including for a model you
  // have not downloaded, which is why messages print it.
  if (isRepoId(value)) {
    // One scan of the models directory, searched for either backend.
    const downloaded = _listDownloadedModels().filter((m) => m.name === value && m.complete);
    const found = SERVED_BACKENDS.find((backend) => downloaded.some((m) => m.backend === backend));
    if (found !== undefined) {
      return { backend: found, target: `${found}:${value}` };
    }
  }
  const names = [...Object.keys(CURATED_LOCAL_MODELS), ...Object.keys(aliases)].join(", ");
  throw new Error(
    `Unknown local model "${value}". Known names: ${names || "(none)"}; ` +
      `or pass a .gguf path, an "hf:" URI, an "mlx:" or "diffusers:" URI, or a model directory.`,
  );
}

export function _resolveModelName(
  value: string,
  target: ConfigTarget = defaultAliasTarget(),
): string {
  return _resolveModel(value, target).target;
}

/** The model name to send to the server `agency local serve` runs. `serve`
 *  gives the server the same string, so a run against your own server never
 *  names a model it is not serving. A repo id for an `mlx:` or `diffusers:`
 *  URI; the absolute directory path for a model directory. */
export function _mlxServedName(resolved: ResolvedModel): string {
  if (isServedUri(resolved.target)) {
    return parseServedUri(resolved.target).repo;
  }
  return path.resolve(resolved.target);
}

type EntryMeta = Pick<
  ModelNameEntry,
  "params" | "sizeBytes" | "kind" | "tags" | "description" | "contextWindow" | "license" | "sha256"
>;

/** A source of entry metadata: a catalog entry, an alias, or a remote
 *  catalog model, any of which may still say `category`. */
type MetaSource = Partial<EntryMeta> & { category?: ModelCategory };

/** Project the optional display-metadata fields off any source shape
 *  (`ModelInfo`, or an alias which may be a bare URI string). A string alias
 *  carries no metadata, so it yields `{}` — which is why the call sites can
 *  pass an `AliasValue` directly without a `typeof` guard. Returns only
 *  defined fields so the spread doesn't introduce stray `undefined` keys. */
function metaFrom(src: string | MetaSource): EntryMeta {
  if (typeof src === "string") return {};
  const out: EntryMeta = {};
  if (src.params !== undefined) out.params = src.params;
  if (src.sizeBytes !== undefined) out.sizeBytes = src.sizeBytes;
  const kind = isModelKind(src.kind) ? src.kind : kindOfCategory(src.category);
  if (kind !== undefined) out.kind = kind;
  const tags = src.tags ?? tagsOfCategory(src.category);
  if (tags !== undefined) out.tags = tags;
  if (src.description !== undefined) out.description = src.description;
  if (src.contextWindow !== undefined) out.contextWindow = src.contextWindow;
  if (src.license !== undefined) out.license = src.license;
  if (src.sha256 !== undefined) out.sha256 = src.sha256;
  return out;
}

export function _listModelNames(target: ConfigTarget = defaultAliasTarget()): ModelNameEntry[] {
  const curatedEntries: ModelNameEntry[] = Object.entries(CURATED_LOCAL_MODELS).map(
    ([name, info]) => ({
      name,
      backend: info.backend,
      target: info.uri,
      source: "curated",
      ...metaFrom(info),
    }),
  );
  const aliasEntries: ModelNameEntry[] = Object.entries(readModelAliases(target)).map(
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

export function _aliasModel(
  name: string,
  uri: string,
  target: ConfigTarget = defaultAliasTarget(),
): string {
  const file = writeTarget(target);
  writeJson(file, withAlias(readJson(file), name, uri));
  return file;
}

/** Outcome of `_unaliasModel`. `removed` distinguishes the actual mutation
 *  (true) from the "alias / file wasn't there, file untouched" no-op (false),
 *  so the CLI can print an accurate message instead of always saying
 *  "Removed alias …" even when nothing changed. */
export type UnaliasResult = { file: string; removed: boolean };

/** Remove an alias. Bails early (no write) if file or alias missing. */
export function _unaliasModel(
  name: string,
  target: ConfigTarget = defaultAliasTarget(),
): UnaliasResult {
  const file = writeTarget(target);
  const located = wholePath(file);
  if (stat(located.root, located.target) === null) {
    return { file, removed: false };
  }
  const cfg = readJson(file);
  if (!cfg.client?.modelAliases || !(name in cfg.client.modelAliases)) {
    return { file, removed: false };
  }
  writeJson(file, withAlias(cfg, name, undefined));
  return { file, removed: true };
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
  /** Which directory shape holds the files. `agency` is our own
   *  `<modelsDir>/mlx/<org>--<repo>` or `<modelsDir>/diffusers/<org>--<repo>`
   *  with a record. `hub` is a Hugging Face cache written by another tool,
   *  which we read but never write. `directory` is any other model
   *  directory, such as the target of an alias. */
  layout: "gguf" | "agency" | "hub" | "directory";
  /** What the model is, when the record, the catalog, or the files say. */
  kind?: ModelKind;
};

export function _listDownloadedModels(cacheDir: string = ""): DownloadedModel[] {
  const dir = resolveCacheDir(cacheDir);
  const gguf: DownloadedModel[] = ggufEntries(dir).map((entry) => ({
    name: entry.name,
    path: path.join(dir, entry.name),
    sizeBytes: entry.size,
    backend: "llama-cpp",
    complete: true,
    layout: "gguf",
    kind: "chat",
  }));
  return [
    ...gguf,
    ...servedEntries(dir, "mlx"),
    ...servedEntries(dir, "diffusers"),
    ...hubEntries(dir),
    ...controlnetEntries(),
  ];
}

/** The ControlNets in `client.controlnetsDir`: every subfolder with a
 *  record. They are listed with the models because they are downloaded
 *  like them, though they are loaded by an image server rather than
 *  served. */
function controlnetEntries(): DownloadedModel[] {
  const folder = configuredControlnetsDir();
  if (folder === null) {
    return [];
  }
  const parent = root(folder);
  if (stat(parent, ".") === null) {
    return [];
  }
  const out: DownloadedModel[] = [];
  for (const entry of list(parent, ".")) {
    const modelDir = path.join(folder, entry.name);
    const record = entry.type === "dir" ? readMlxModelRecord(modelDir) : null;
    if (record === null) {
      continue;
    }
    out.push({
      name: record.repo,
      path: modelDir,
      sizeBytes: Object.values(record.files).reduce((sum, f) => sum + f.size, 0),
      backend: "diffusers",
      complete: isMlxModelComplete(record),
      revision: record.revision,
      layout: "directory",
      kind: "controlnet",
    });
  }
  return out;
}

/** The Hugging Face cache directories under `dir`, and under `dir/hub` —
 *  the shape `HF_HOME` has. These are models another tool downloaded; we
 *  read them where they lie and never write to them. */
function hubEntries(dir: string): DownloadedModel[] {
  return [...hubEntriesIn(dir), ...hubEntriesIn(path.join(dir, "hub"))];
}

function hubEntriesIn(dir: string): DownloadedModel[] {
  const parent = root(dir);
  if (stat(parent, ".") === null) {
    return [];
  }
  const out: DownloadedModel[] = [];
  for (const entry of list(parent, ".")) {
    const repo = entry.type === "dir" ? hubRepoOfDirName(entry.name) : null;
    if (repo === null) {
      continue;
    }
    const modelDir = hubSnapshot(path.join(dir, entry.name));
    const backend = modelDir === null ? null : servedDirBackend(modelDir);
    if (modelDir === null || backend === null) {
      continue;
    }
    const model: DownloadedModel = {
      name: repo,
      path: modelDir,
      sizeBytes: modelDirSizeBytes(modelDir),
      backend,
      complete: true,
      revision: hubSnapshotRevision(modelDir),
      layout: "hub",
    };
    const kind = _modelKind(`${backend}:${repo}`, modelDir);
    if (kind !== null) {
      model.kind = kind;
    }
    out.push(model);
  }
  return out;
}

/** `hubSnapshotDir`, with the ambiguous-snapshots error turned into "not a
 *  model here". A scan over a whole cache must not fail because one repo in
 *  it has two revisions; naming that repo directly still reports it. */
function hubSnapshot(dir: string): string | null {
  try {
    return hubSnapshotDir(dir);
  } catch {
    return null;
  }
}

/** The downloaded model with this backend and repo id, in whichever layout
 *  holds it. This is what makes `mlx:org/repo` or `diffusers:org/repo` mean
 *  the model rather than one place it might live.
 *
 *  With a `revision`, only a copy at that commit counts. The prefix is
 *  matched, the way a pin in an `mlx:` URI is written. A cache keeps every
 *  revision it has fetched, and lists only the one `refs/main` names, so a
 *  pinned revision is looked for among the others too. */
export function _findDownloadedServedModel(
  backend: ServedBackend,
  repo: string,
  cacheDir: string = "",
  revision?: string,
): DownloadedModel | null {
  const dir = resolveCacheDir(cacheDir);
  const copies = _listDownloadedModels(dir).filter(
    (m) => m.backend === backend && m.name === repo && m.complete,
  );
  if (revision === undefined) {
    return copies[0] ?? null;
  }
  const pinned = copies.find((m) => (m.revision ?? "").startsWith(revision));
  return pinned ?? hubSnapshotAtRevision(dir, backend, repo, revision);
}

/** Every backend `agency local serve` runs, in the order a bare repo id is
 *  looked up. */
const SERVED_BACKENDS: ServedBackend[] = ["mlx", "diffusers"];

/** A snapshot of `repo` at `revision` in a Hugging Face cache, even when it is
 *  not the revision `refs/main` names. */
function hubSnapshotAtRevision(
  dir: string,
  backend: ServedBackend,
  repo: string,
  revision: string,
): DownloadedModel | null {
  for (const base of [dir, path.join(dir, "hub")]) {
    const folder = path.join(base, hubDirNameOfRepo(repo));
    const holder = root(folder);
    if (stat(holder, "snapshots") === null) {
      continue;
    }
    for (const entry of list(holder, "snapshots")) {
      if (entry.type !== "dir" || !entry.name.startsWith(revision)) {
        continue;
      }
      const modelDir = path.join(folder, "snapshots", entry.name);
      if (servedDirBackend(modelDir) !== backend) {
        continue;
      }
      return {
        name: repo,
        path: modelDir,
        sizeBytes: modelDirSizeBytes(modelDir),
        backend,
        complete: true,
        revision: entry.name,
        layout: "hub",
      };
    }
  }
  return null;
}

/** The model directories under the backend's folder (`<dir>/mlx` or
 *  `<dir>/diffusers`) that carry a record. */
function servedEntries(dir: string, backend: ServedBackend): DownloadedModel[] {
  const subdir = SUBDIR_FOR_BACKEND[backend];
  const backendDir = path.join(dir, subdir);
  const cache = root(dir);
  if (stat(cache, subdir) === null) {
    return [];
  }
  const out: DownloadedModel[] = [];
  for (const entry of list(cache, subdir)) {
    if (entry.type !== "dir") {
      continue;
    }
    const modelDir = path.join(backendDir, entry.name);
    const record = readMlxModelRecord(modelDir);
    if (record === null) {
      continue;
    }
    // A finished model is the size its record says, which is the size the
    // repo has; a half-downloaded one is what is on disk so far, so `list`
    // can show how far it got.
    const complete = isMlxModelComplete(record);
    const sizeBytes = complete
      ? Object.values(record.files).reduce((sum, f) => sum + f.size, 0)
      : treeSizeBytes(root(modelDir), ".");
    const model: DownloadedModel = {
      name: record.repo,
      path: modelDir,
      sizeBytes,
      backend,
      complete,
      revision: record.revision,
      layout: "agency",
    };
    const kind = _modelKind(`${backend}:${record.repo}`, modelDir);
    if (kind !== null) {
      model.kind = kind;
    }
    out.push(model);
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

/** Delete a served model's directory from the cache. Only a directory under
 *  `<cacheDir>/mlx` or `<cacheDir>/diffusers` is ever removed; `remove`
 *  refuses symlinks. */
export function _removeServedModel(
  backend: ServedBackend,
  repo: string,
  cacheDir: string = "",
): boolean {
  const cache = root(path.join(resolveCacheDir(cacheDir), SUBDIR_FOR_BACKEND[backend]));
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
 *  through its record under the cache, or the directory it points at.
 *  `insideCache` is false for a ControlNet, whose files are listed with the
 *  models but live in `client.controlnetsDir`, where remove cannot reach. */
export function _modelFilesOnDisk(
  resolved: ResolvedModel,
  cacheDir: string = "",
): {
  path: string;
  sizeBytes: number;
  insideCache: boolean;
  layout: DownloadedModel["layout"];
} | null {
  const dir = resolveCacheDir(cacheDir);
  const onDisk = _listDownloadedModels(dir);
  const found = (match: (f: DownloadedModel) => boolean) => {
    const f = onDisk.find(match);
    return f === undefined
      ? null
      : {
          path: f.path,
          sizeBytes: f.sizeBytes,
          insideCache: isContained(f.path, dir),
          layout: f.layout,
        };
  };
  if (resolved.backend === "llama-cpp") {
    if (isGgufPath(resolved.target)) {
      return found((f) => f.path === path.resolve(resolved.target));
    }
    const fileName = readDownloadManifest(dir)[resolved.target];
    return fileName === undefined ? null : found((f) => f.name === fileName);
  }
  if (isServedUri(resolved.target)) {
    const { backend, repo } = parseServedUri(resolved.target);
    return found((f) => f.backend === backend && f.name === repo);
  }
  const target = path.resolve(resolved.target);
  const sizeBytes = modelDirSizeBytes(target);
  const known = onDisk.find((f) => f.path === target);
  return {
    path: target,
    sizeBytes,
    insideCache: known !== undefined,
    layout: known?.layout ?? (isHubSnapshotPath(target) ? "hub" : "directory"),
  };
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
  kind?: ModelKind;
  tags?: ModelTag[];
  contextWindow?: number;
  license?: string;
  description?: string;
  sha256?: string;
  /** Repos this model loads by name at runtime, as mlx: URIs. Carried into
   *  the alias `agency local refresh` writes, so a refreshed model can
   *  download them too. */
  companions?: string[];
};

/** Resolve the catalog URL: explicit arg → env → config → built-in default. */
export function resolveCatalogUrl(
  explicit: string = "",
  target: ConfigTarget = defaultAliasTarget(),
): string {
  if (explicit !== "") return explicit;
  if (process.env.AGENCY_MODEL_CATALOG_URL) return process.env.AGENCY_MODEL_CATALOG_URL;
  const configured = readAliasConfig(target).client?.modelCatalogUrl;
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
  "speech",
  "image",
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
    backend: z.enum(["llama-cpp", "mlx", "diffusers"]),
    uri: z.string().refine(isCatalogUri, "uri must be an hf:/mlx:/https: URI or a .gguf path"),
    params: z.string().optional().catch(undefined),
    sizeBytes: z.number().optional().catch(undefined),
    kind: z
      .enum(MODEL_KINDS as [ModelKind, ...ModelKind[]])
      .optional()
      .catch(undefined),
    tags: z.array(z.string()).optional().catch(undefined),
    // What a catalog said before kinds and tags. Read as both.
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
    // Repos the model loads by name at runtime. Only mlx: URIs, because
    // that is what the companion download can fetch.
    companions: z
      .array(z.string().refine(isMlxUri, "companion must be an mlx: URI"))
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
          kind: d.kind ?? kindOfCategory(d.category),
          tags: d.tags ?? tagsOfCategory(d.category),
          contextWindow: d.contextWindow,
          license: d.license,
          description: d.description,
          sha256: d.sha256,
          companions: d.companions,
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
    target?: ConfigTarget;
  } = {},
): Promise<RefreshResult> {
  const target = opts.target ?? defaultAliasTarget();
  // Writes go to one file, and the aliases being rewritten come from it alone.
  const file = writeTarget(target);
  const url = resolveCatalogUrl(opts.url ?? "", target);
  const fetcher = opts.fetcher ?? fetchCatalog;

  // Fetch + validate BEFORE reading/writing agency.json, so a failure leaves
  // the file untouched.
  const text = await fetcher(url);
  const models = parseCatalog(text);

  // Read aliases through the canonical helper (single source of truth for
  // "how aliases come out of agency.json"). `cfg` is needed separately to
  // round-trip non-alias fields back into the file on write.
  const cfg = readJson(file);
  const existing = checkedAliases(cfg, file);

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

/** Register the llama-cpp provider into agency's own smoltalk. Inside a run
 *  (the agent's --local path), emit the `localModelLoaded` statelog event
 *  saying where the provider package came from. The plain CLI has no runtime
 *  frame, so there is no run logger there and nothing is emitted. */
export async function _registerLocalProvider(): Promise<void> {
  // run-read-ok: the log line is optional. A caller that has already awaited, or the plain CLI, emits nothing.
  const log = currentRunOrNone()?.log;
  requireSupport();
  const { entryPath, source } = (await loadLocalProviderDetailed()).choice;
  void log?.localModelLoaded({ entryPath, entrySource: source });
}

/** The pinned SHA-256 for a model name/alias, or undefined when none is known
 *  (raw uri/path, string alias, alias/curated without a hash, or a sharded
 *  model). An alias entry governs the name entirely — a user alias shadowing a
 *  curated name must NOT borrow the curated hash, but a user MAY opt in by
 *  setting their own `sha256` on the alias object. */
export function pinnedSha256(
  value: string,
  target: ConfigTarget = defaultAliasTarget(),
): string | undefined {
  if (isGgufPath(value) || isModelUri(value)) return undefined;
  const aliases = readModelAliases(target);
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

/** `client.mlx.downloadConcurrency` from the project config, else 8. The
 *  config schema requires a positive integer. */
export function configuredDownloadConcurrency(): number {
  return readClientConfig().mlx?.downloadConcurrency ?? DEFAULT_CONCURRENCY;
}

/** Download one mlx: or diffusers: repo into the models directory and
 *  return the directory. */
async function downloadServedRepo(
  target: string,
  cacheDir: string,
  opts: DownloadOptions,
  kind?: ModelKind,
): Promise<string> {
  const { backend, repo, revision } = parseServedUri(target);
  const snapshot = await fetchHubSnapshot(repo, revision, opts);
  const dir = servedModelDir(resolveCacheDir(cacheDir), backend, repo);
  if (backend === "diffusers") {
    return await downloadHubSnapshot(await diffusersSnapshot(snapshot, opts), dir, opts);
  }
  if (kind === "vision") {
    // A vision repo often ships the same weights three ways. Keep the one
    // the server reads.
    return await downloadHubSnapshot(
      { ...snapshot, files: visionFiles(snapshot.files) },
      dir,
      opts,
    );
  }
  return await downloadHubSnapshot(snapshot, dir, opts);
}

/** The files a ControlNet directory needs: its config and its
 *  `.safetensors` weights. A repo also ships sample images and, for
 *  some, a second copy of the weights under another name. */
export function controlnetFiles(files: HubFile[]): HubFile[] {
  return files.filter(
    (f) => f.path === "config.json" || f.path === "diffusion_pytorch_model.safetensors",
  );
}

/** Downloads a ControlNet into `client.controlnetsDir/<name>`, where an
 *  image server finds it by that name. Refuses when no folder is
 *  configured, since there is nowhere else a ControlNet is useful. */
async function downloadControlnet(
  value: string,
  target: string,
  opts: DownloadOptions,
): Promise<string> {
  const folder = configuredControlnetsDir();
  if (folder === null) {
    throw new Error(
      `${value} is a ControlNet, which an image server loads from client.controlnetsDir. ` +
        `Set that folder in agency.json, then download again.`,
    );
  }
  const { repo, revision } = parseServedUri(target);
  const snapshot = await fetchHubSnapshot(repo, revision, opts);
  const name = isServedUri(value) ? repo.split("/")[1] : value;
  const dir = path.join(folder, name);
  await downloadHubSnapshot({ ...snapshot, files: controlnetFiles(snapshot.files) }, dir, opts);
  recordKind(dir, "controlnet");
  return dir;
}

/** A diffusers snapshot cut down to the files the pipeline reads. Reads
 *  model_index.json from the hub first, since it names the component
 *  folders; nothing is written until the whole list is known. */
async function diffusersSnapshot(
  snapshot: HubSnapshot,
  opts: DownloadOptions,
): Promise<HubSnapshot> {
  if (!hasModelIndex(snapshot.files)) {
    throw new Error(
      `${snapshot.repo} has no ${MODEL_INDEX}, so it is not a diffusers model. ` +
        `An MLX model is downloaded with an mlx: URI instead.`,
    );
  }
  let modelIndex: unknown;
  try {
    modelIndex = JSON.parse(await fetchHubFileText(snapshot, MODEL_INDEX, opts));
  } catch (err) {
    throw new Error(
      `${snapshot.repo}'s ${MODEL_INDEX} could not be read: ${(err as Error).message}`,
    );
  }
  return { ...snapshot, files: diffusersFiles(snapshot.repo, snapshot.files, modelIndex) };
}

/** The repo an mlx: or diffusers: URI names, without its pinned revision.
 *  Null for anything else, which is compared whole. */
function mlxRepoOf(target: string): string | null {
  return isServedUri(target) ? parseServedUri(target).repo : null;
}

/** The curated entry a value names, by its catalog name or by the repo it
 *  resolved to. A pinned revision does not change which entry it is.
 *  Undefined for a URI the catalog does not know. */
function catalogEntry(value: string, target: string): ModelInfo | undefined {
  const byName = CURATED_LOCAL_MODELS[value];
  if (byName !== undefined) {
    return byName;
  }
  const repo = mlxRepoOf(target);
  const matches = (entry: ModelInfo): boolean =>
    repo === null ? entry.uri === target : mlxRepoOf(entry.uri) === repo;
  return Object.values(CURATED_LOCAL_MODELS).find(matches);
}

/** The repos a model loads by name at runtime. An alias answers for itself,
 *  even when it shadows a catalog name, because it may point somewhere with
 *  no companion at all. Otherwise the curated entry answers. */
function companionsFor(
  value: string,
  modelTarget: string,
  configTarget: ConfigTarget = defaultAliasTarget(),
): string[] {
  const alias = readModelAliases(configTarget)[value];
  if (alias !== undefined) {
    return typeof alias === "string" ? [] : (alias.companions ?? []);
  }
  return catalogEntry(value, modelTarget)?.companions ?? [];
}

/** The download options, plus the kind to record when the user says what
 *  the model is. Without it, the catalog or the files decide. */
export type ModelDownloadOptions = DownloadOptions & { kind?: ModelKind };

/** Download a model and return where it is: the `.gguf` path, or the MLX
 *  model directory. `hubOptions` lets the CLI watch progress and lets tests
 *  point at a fake hub. */
export async function _downloadModel(
  value: string,
  cacheDir: string = "",
  hubOptions: ModelDownloadOptions = {},
): Promise<string> {
  const model = _resolveModel(value);
  if (hubOptions.kind !== undefined) {
    refuseUnrecordableKind(value, model);
  }
  if (model.backend !== "llama-cpp") {
    if (isServedModelDir(model.target)) {
      return path.resolve(model.target);
    }
    const { kind: givenKind, ...rest } = hubOptions;
    const opts: DownloadOptions = {
      concurrency: configuredDownloadConcurrency(),
      ...rest,
      token: hubOptions.token ?? process.env.HF_TOKEN,
    };
    const kind = givenKind ?? _catalogKind(value);
    if (kind === "controlnet") {
      return await downloadControlnet(value, model.target, opts);
    }
    const dir = await downloadServedRepo(model.target, cacheDir, opts, kind);
    recordKind(dir, kind ?? _modelKind(value, dir));
    // A model that loads other repos by name at runtime needs them on disk
    // too, or it cannot start offline. Only a catalog entry lists them.
    for (const companion of companionsFor(value, model.target)) {
      await downloadServedRepo(companion, cacheDir, opts);
    }
    return dir;
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

/** `--kind` is written into the record an mlx: or diffusers: download
 *  keeps. A GGUF file and a directory have no such record, so the kind
 *  would be dropped without a word. Refuse instead, naming what works. */
function refuseUnrecordableKind(value: string, model: ResolvedModel): void {
  if (model.backend === "llama-cpp") {
    throw new Error(
      `${value} is a GGUF model, which is always a chat model. Download it without --kind.`,
    );
  }
  if (isServedModelDir(model.target)) {
    throw new Error(
      `${value} is a directory, and --kind is only recorded for a download. ` +
        `Name its kind when serving it instead, for example: agency local serve --embedding ${value}`,
    );
  }
}

/** Writes the kind into a finished download's record. A null kind leaves
 *  the record as it is: an unknown layout can still be served by someone
 *  who says what it is. */
function recordKind(dir: string, kind: ModelKind | null): void {
  const record = readMlxModelRecord(dir);
  if (record === null || kind === null || record.kind === kind) {
    return;
  }
  writeMlxModelRecord(dir, { ...record, kind });
}

/** The kind a category from before the split implies. The categories that
 *  say what a model returns map to themselves; the rest describe a chat
 *  model. */
export function kindOfCategory(category: ModelCategory | undefined): ModelKind | undefined {
  if (category === undefined) {
    return undefined;
  }
  if (category === "embedding" || category === "speech" || category === "image") {
    return category;
  }
  return "chat";
}

/** The tags a category from before the split implies: the category itself
 *  when it says what a chat model is good for, none otherwise. */
export function tagsOfCategory(category: ModelCategory | undefined): ModelTag[] | undefined {
  if (category === undefined) {
    return undefined;
  }
  if (kindOfCategory(category) !== "chat" || category === "general") {
    return [];
  }
  return [category];
}

/** What kind of model `value` is, given the directory it resolved to. The
 *  catalog's word comes first, because it knows the models whose files are
 *  ambiguous (an Orpheus speech model has a Llama config). Then the record
 *  the download wrote. Then the files. Null when none of the three knows,
 *  which also covers a directory that is not there. */
export function _modelKind(value: string, dir: string): ModelKind | null {
  const fromCatalog = _catalogKind(value);
  if (fromCatalog !== undefined) {
    return fromCatalog;
  }
  const record = readMlxModelRecord(dir);
  if (record?.kind !== undefined) {
    return record.kind;
  }
  try {
    return kindOfModelDir(dir);
  } catch {
    return null;
  }
}

/** The kind of the model `value` names, from the catalog, its record, or
 *  its files, or null when it is not downloaded or nothing knows. For a
 *  stdlib function refusing a model of the wrong kind before any request. */
export function _localModelKindOf(value: string, cacheDir: string = ""): ModelKind | null {
  const fromCatalog = _catalogKind(value);
  if (fromCatalog !== undefined) {
    return fromCatalog;
  }
  const resolved = _resolveModel(value);
  if (resolved.backend === "llama-cpp") {
    return "chat";
  }
  if (isServedUri(resolved.target)) {
    const { backend, repo, revision } = parseServedUri(resolved.target);
    const found = _findDownloadedServedModel(backend, repo, cacheDir, revision);
    return found === null ? null : _modelKind(value, found.path);
  }
  return _modelKind(value, path.resolve(resolved.target));
}

/** The kind the catalog or an alias entry gives `value`, before any file is
 *  looked at. The value may be the entry's name or the URI it points at; a
 *  plain string alias, a directory, or a URI no entry names has none. */
export function _catalogKind(
  value: string,
  target: ConfigTarget = defaultAliasTarget(),
): ModelKind | undefined {
  const aliases = readModelAliases(target);
  const alias = aliases[value];
  if (alias !== undefined) {
    return typeof alias === "string" ? undefined : metaFrom(alias).kind;
  }
  const curated = CURATED_LOCAL_MODELS[value];
  if (curated !== undefined) {
    return curated.kind;
  }
  for (const entry of Object.values(aliases)) {
    if (typeof entry !== "string" && entry.uri === value) {
      return metaFrom(entry).kind;
    }
  }
  return catalogEntry(value, value)?.kind;
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

/** What to send smoltalk for a local embedding model. For llama-cpp, a
 *  .gguf path (the provider registered) or a name the catalog knows
 *  (downloaded and verified if needed). For mlx, the served name; a name
 *  the catalog does not know passes through, because it may be a repo id
 *  the server was started with. */
export async function _resolveLocalEmbeddingModel(
  provider: string,
  model: string,
): Promise<string> {
  if (provider === "llama-cpp") {
    if (isGgufPath(model)) {
      await _registerLocalProvider();
      return path.resolve(model);
    }
    return await _registerLocalModel(model);
  }
  try {
    return _mlxServedName(_resolveModel(model));
  } catch {
    return model;
  }
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
