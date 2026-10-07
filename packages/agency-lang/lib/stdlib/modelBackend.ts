import * as fs from "node:fs";
import * as path from "node:path";
// The synchronous file operations of nodeHost, not host.files: local models are Node-only.
import { wholePath, stat, root, readText } from "../host/node/nodeFiles.js";

/** Which engine runs a model. GGUF files run in-process through llama.cpp.
 *  MLX models run in mlx_lm.server, and diffusers models in Agency's image
 *  server; `agency local serve` starts both. */
export type Backend = "llama-cpp" | "mlx" | "diffusers";

/** The backends whose models `agency local serve` runs. Each is named with
 *  a URI of its own prefix and downloaded into a folder of its own name. */
export type ServedBackend = "mlx" | "diffusers";

export function isGgufPath(v: string): boolean {
  return v.endsWith(".gguf");
}

/** `mlx:<org>/<repo>` or `diffusers:<org>/<repo>`, with an optional
 *  `@<revision>`. A repo id is two names made of letters, digits, `.`, `_`
 *  and `-`. The Hub allows nothing else, and the id becomes a directory
 *  name, so a backslash or a `..` component must not get through. */
const SERVED_URI = /^(mlx|diffusers):([\w.-]+\/[\w.-]+)(?:@([\w.-]+))?$/;

export type ServedUri = { backend: ServedBackend; repo: string; revision: string | undefined };

export function isServedUri(v: string): boolean {
  return servedUriParts(v) !== null;
}

/** Split "diffusers:org/repo@rev" or "mlx:org/repo@rev" into its parts.
 *  Throws on any other shape. */
export function parseServedUri(v: string): ServedUri {
  const parts = servedUriParts(v);
  if (parts === null) {
    throw new Error(
      `"${v}" is not an mlx: or diffusers: URI. Expected mlx:<org>/<repo> or diffusers:<org>/<repo>, optionally followed by @<revision>.`,
    );
  }
  return parts;
}

export function isMlxUri(v: string): boolean {
  return servedUriParts(v)?.backend === "mlx";
}

/** Split "mlx:org/repo@rev" into its parts. Throws on any other shape. */
export function parseMlxUri(v: string): { repo: string; revision: string | undefined } {
  const parts = servedUriParts(v);
  if (parts === null || parts.backend !== "mlx") {
    throw new Error(
      `"${v}" is not an mlx: URI. Expected mlx:<org>/<repo> or mlx:<org>/<repo>@<revision>.`,
    );
  }
  return { repo: parts.repo, revision: parts.revision };
}

/** The match, unless a component is only dots, which a URL or a path
 *  would read as the current or parent directory. */
function servedUriParts(v: string): ServedUri | null {
  const m = SERVED_URI.exec(v);
  if (m === null) {
    return null;
  }
  const components = [...m[2].split("/"), ...(m[3] === undefined ? [] : [m[3]])];
  if (components.some((c) => /^\.+$/.test(c))) {
    return null;
  }
  return { backend: m[1] as ServedBackend, repo: m[2], revision: m[3] };
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
  if (!isDirectory(p)) {
    return false;
  }
  const entries = modelDirEntries(p);
  const hasConfig = entries.some((e) => e.name === "config.json");
  // An ONNX vision model, such as the WD14 tagger, keeps its weights in
  // model.onnx and has no .safetensors at all.
  const hasWeights = entries.some(
    (e) => e.name.endsWith(".safetensors") || e.name.endsWith(".onnx"),
  );
  return hasConfig && hasWeights;
}

/** A diffusers model directory: `model_index.json` at the top and its
 *  weights one level down, in a folder per component (`transformer/`,
 *  `vae/`, and so on). It has no top-level config.json, so it is never also
 *  an MLX model directory. */
export function isDiffusersDir(p: string): boolean {
  if (!isDirectory(p)) {
    return false;
  }
  if (!modelDirEntries(p).some((e) => e.name === "model_index.json")) {
    return false;
  }
  return componentDirs(p).some((dir) =>
    modelDirEntries(dir).some((e) => e.name.endsWith(".safetensors")),
  );
}

/** Which served backend a model directory is for, or null when it is
 *  neither kind. */
export function servedDirBackend(p: string): ServedBackend | null {
  if (isDiffusersDir(p)) {
    return "diffusers";
  }
  if (isModelDir(p)) {
    return "mlx";
  }
  return null;
}

export function isServedModelDir(p: string): boolean {
  return servedDirBackend(p) !== null;
}

/** The bytes a model directory holds: its files, and for a diffusers model
 *  the files in its component folders too. Follows symlinks the way
 *  `modelDirEntries` does. */
export function modelDirSizeBytes(p: string): number {
  const sum = (dir: string) => modelDirEntries(dir).reduce((total, f) => total + f.size, 0);
  const top = sum(p);
  if (!isDiffusersDir(p)) {
    return top;
  }
  return componentDirs(p).reduce((total, dir) => total + sum(dir), top);
}

function isDirectory(p: string): boolean {
  const located = wholePath(p);
  const info = stat(located.root, located.target);
  return info !== null && info.isDirectory();
}

/** The subfolders of a model directory, following symlinks, skipping any
 *  whose name starts with `.`. */
function componentDirs(p: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(p)) {
    if (name.startsWith(".")) {
      continue;
    }
    const dir = path.join(p, name);
    try {
      if (fs.statSync(dir).isDirectory()) {
        out.push(dir);
      }
    } catch {
      continue;
    }
  }
  return out;
}

/** Which engine runs a resolved target. Throws for a path that is neither a
 *  GGUF file nor a model directory. */
export function backendOfTarget(target: string): Backend {
  if (isGgufPath(target) || /^(hf:|https?:)/.test(target)) {
    return "llama-cpp";
  }
  const uri = servedUriParts(target);
  if (uri !== null) {
    return uri.backend;
  }
  const dirBackend = servedDirBackend(target);
  if (dirBackend !== null) {
    return dirBackend;
  }
  throw new Error(
    `"${target}" is not a model: expected a .gguf file, a directory containing config.json, or a diffusers directory containing model_index.json.`,
  );
}

// ---------------------------------------------------------------------------
// Hugging Face cache directories
// ---------------------------------------------------------------------------

/** What the Hub calls a cached repo's folder: `models--<org>--<repo>`. */
const HUB_DIR_PREFIX = "models--";

/** The repo id a Hub cache folder name stands for, or null when the name is
 *  not one. The Hub writes `org/repo` as `org--repo`, so the first `--` after
 *  the prefix is the separator and any later one belongs to the repo name. */
export function hubRepoOfDirName(name: string): string | null {
  if (!name.startsWith(HUB_DIR_PREFIX)) {
    return null;
  }
  const rest = name.slice(HUB_DIR_PREFIX.length);
  const cut = rest.indexOf("--");
  if (cut <= 0 || cut + 2 >= rest.length) {
    return null;
  }
  return `${rest.slice(0, cut)}/${rest.slice(cut + 2)}`;
}

/** The longest a revision can be. A sha is 40 characters; anything longer in
 *  `refs/main` is not one, and only this much of it reaches an error message. */
const REF_MAX = 64;

/** The revision `refs/main` names, or null when the cache keeps no ref.
 *  Read through `contained.ts`, which opens without following a final link,
 *  so a ref that is a symlink cannot make Agency read a file elsewhere. */
function readRef(dir: string): string | null {
  try {
    return readText(root(dir), path.join("refs", "main")).trim().slice(0, REF_MAX);
  } catch (err) {
    const message = (err as Error).message;
    if (/ENOENT|no such file|not a directory/i.test(message)) {
      // No refs/main: a cache written by something that does not keep refs,
      // or a directory that is not a Hub cache at all. The snapshot scan
      // decides which.
      return null;
    }
    throw new Error(`${path.join(dir, "refs", "main")} is not a file Agency will read: ${message}`);
  }
}

function snapshotNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(path.join(dir, "snapshots"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** The model directory inside a Hugging Face cache folder
 *  (`models--org--repo/snapshots/<sha>/`), or null when `p` is not one.
 *  `refs/main` names the snapshot to use; without it, a lone snapshot is
 *  taken. Several snapshots and no ref is ambiguous, and throws rather than
 *  guessing which revision you meant. */
export function hubSnapshotDir(p: string): string | null {
  const names = snapshotNames(p);
  if (names.length === 0) {
    return null;
  }
  const snapshot = (name: string) => path.join(p, "snapshots", name);
  const models = names.filter((name) => isServedModelDir(snapshot(name)));
  const ref = readRef(p);
  if (ref !== null) {
    if (models.includes(ref)) {
      return snapshot(ref);
    }
    // The ref decides which revision this cache is on, so falling back to
    // another one would serve a model the user did not ask for.
    throw new Error(
      `${p} is on revision ${ref}, and ${snapshot(ref)} is missing or incomplete. ` +
        (models.length === 0
          ? "Download it again."
          : `Name a snapshot instead:\n${models.map((m) => `  ${snapshot(m)}`).join("\n")}`),
    );
  }
  if (models.length === 1) {
    return snapshot(models[0]);
  }
  if (models.length === 0) {
    return null;
  }
  throw new Error(
    `${p} holds ${models.length} snapshots and no refs/main saying which is current. ` +
      `Name one of them instead:\n${models.map((m) => `  ${snapshot(m)}`).join("\n")}`,
  );
}

/** The cache folder name for a repo id: `org/repo` becomes
 *  `models--org--repo`. */
export function hubDirNameOfRepo(repo: string): string {
  return `${HUB_DIR_PREFIX}${repo.replace("/", "--")}`;
}

/** Whether a path looks like a snapshot inside a Hugging Face cache:
 *  `<something>/models--org--repo/snapshots/<sha>`. Used to classify a
 *  directory Agency did not scan, such as the target of an alias. */
export function isHubSnapshotPath(p: string): boolean {
  const parent = path.dirname(p);
  if (path.basename(parent) !== "snapshots") {
    return false;
  }
  return hubRepoOfDirName(path.basename(path.dirname(parent))) !== null;
}

/** The revision a Hub snapshot directory came from: the sha in its name. */
export function hubSnapshotRevision(snapshotDir: string): string {
  return path.basename(snapshotDir);
}

/** The largest `config.json` or `model_index.json` read. Real ones are a
 *  few kilobytes. The cap keeps a file that links to something huge or
 *  endless from hanging `agency local list`, which reads every model's. */
const MAX_MODEL_JSON_BYTES = 1024 * 1024;

/** The parsed contents of one JSON file in a model directory, or null when
 *  it is missing, not JSON, not a regular file, or over
 *  `MAX_MODEL_JSON_BYTES`. Only `config.json` and `model_index.json` are
 *  read this way, and only to decide what the directory holds.
 *
 *  A symlink is refused, except in a Hub cache snapshot, which links every
 *  file into its repo folder's `blobs/`. There the link is followed only
 *  when it stays inside that repo folder. */
export function readModelJson(dir: string, name: string): Record<string, unknown> | null {
  const file = path.join(dir, name);
  if (!isReadableModelJson(dir, file)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isReadableModelJson(dir: string, file: string): boolean {
  try {
    if (fs.lstatSync(file).isSymbolicLink() && !isHubBlobLink(dir, file)) {
      return false;
    }
    const info = fs.statSync(file);
    return info.isFile() && info.size <= MAX_MODEL_JSON_BYTES;
  } catch {
    return false;
  }
}

/** Whether `file`, a symlink in `dir`, is a Hub cache snapshot's link into
 *  its own repo folder (`models--org--repo/`). */
function isHubBlobLink(dir: string, file: string): boolean {
  if (!isHubSnapshotPath(dir)) {
    return false;
  }
  const repoFolder = fs.realpathSync(path.dirname(path.dirname(dir)));
  return fs.realpathSync(file).startsWith(repoFolder + path.sep);
}
