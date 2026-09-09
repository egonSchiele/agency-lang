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
/** A repo id is two names made of letters, digits, `.`, `_` and `-`.
 *  The Hub allows nothing else, and the id becomes a directory name, so
 *  a backslash or a `..` component must not get through. */
const MLX_URI = /^mlx:([\w.-]+\/[\w.-]+)(?:@([\w.-]+))?$/;

export function isMlxUri(v: string): boolean {
  return mlxUriParts(v) !== null;
}

/** Split "mlx:org/repo@rev" into its parts. Throws on any other shape. */
export function parseMlxUri(v: string): { repo: string; revision: string | undefined } {
  const parts = mlxUriParts(v);
  if (parts === null) {
    throw new Error(
      `"${v}" is not an mlx: URI. Expected mlx:<org>/<repo> or mlx:<org>/<repo>@<revision>.`,
    );
  }
  return parts;
}

/** The match, unless a component is only dots, which a URL or a path
 *  would read as the current or parent directory. */
function mlxUriParts(v: string): { repo: string; revision: string | undefined } | null {
  const m = MLX_URI.exec(v);
  if (m === null) {
    return null;
  }
  const components = [...m[1].split("/"), ...(m[2] === undefined ? [] : [m[2]])];
  if (components.some((c) => /^\.+$/.test(c))) {
    return null;
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

function readRef(dir: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, "refs", "main"), "utf8").trim();
  } catch {
    // No refs/main: a cache written by something that does not keep refs, or
    // a directory that is not a Hub cache at all. The snapshot scan decides.
    return null;
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
  const models = names.filter((name) => isModelDir(snapshot(name)));
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
