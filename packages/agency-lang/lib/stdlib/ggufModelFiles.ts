import * as path from "node:path";
// The synchronous file operations of nodeHost, not host.files: local models are Node-only.
import { root, stat, list, remove } from "../host/node/nodeFiles.js";
import { loadLocalProvider } from "../runtime/localProvider.js";
import { readDownloadManifest } from "./localModelManifest.js";
import { verifyModelFile } from "./modelVerify.js";
import {
  ggufModelDir,
  ggufModelSizeBytes,
  readGgufModelRecord,
  writeGgufModelRecord,
} from "./ggufModelRecord.js";
import { GGUF_SUBDIR, ggufModelDirName } from "./ggufModelDir.js";

/** GGUF models on disk: the folders `ggufModelDir` names, and the loose
 *  `.gguf` files downloads left in the models directory before those
 *  folders existed. Every function takes the models directory already
 *  resolved. */

/** A downloaded model folder: the URI its record names, and its size. */
export type GgufFolder = { uri: string; path: string; sizeBytes: number };

/** The model folders under `<dir>/gguf` that carry a record. A folder
 *  without one is a download that never finished, and is not a model. */
export function ggufFolders(dir: string): GgufFolder[] {
  const cache = root(dir);
  if (stat(cache, GGUF_SUBDIR) === null) {
    return [];
  }
  const out: GgufFolder[] = [];
  for (const entry of list(cache, GGUF_SUBDIR)) {
    const folder = path.join(dir, GGUF_SUBDIR, entry.name);
    const record = entry.type === "dir" ? readGgufModelRecord(folder) : null;
    if (record !== null) {
      out.push({ uri: record.uri, path: folder, sizeBytes: ggufModelSizeBytes(record) });
    }
  }
  return out;
}

/** The loose `.gguf` files directly in `dir`, by name. A missing dir has none. */
export function looseGgufFiles(dir: string): { name: string; size: number }[] {
  const cache = root(dir);
  if (stat(cache, ".") === null) {
    return [];
  }
  return list(cache, ".")
    .filter((entry) => entry.type === "file" && entry.name.endsWith(".gguf"))
    .map((entry) => ({ name: entry.name, size: entry.size }));
}

/** Delete one loose file from `dir`. `name` must be a plain file name
 *  inside it: `resolveUnder` refuses `..` and symlinks, and a missing file
 *  or a non-file returns false. */
export function removeLooseGgufFile(dir: string, name: string): boolean {
  const cache = root(dir);
  const info = stat(cache, name);
  if (info === null || !info.isFile()) {
    return false;
  }
  remove(cache, name);
  return true;
}

/** Delete the folder a URI was downloaded into, with every file in it.
 *  `remove` refuses symlinks. */
export function removeGgufFolder(dir: string, uri: string): boolean {
  const cache = root(path.join(dir, GGUF_SUBDIR));
  const name = ggufModelDirName(uri);
  const info = stat(cache, name);
  if (info === null || !info.isDirectory()) {
    return false;
  }
  remove(cache, name);
  return true;
}

/** Was the resolved file freshly downloaded (not already cached)? */
export type FreshnessProbe = (resolved: string) => boolean;

/** Snapshot a model folder, returning a probe that reports whether a
 *  resolved path is newly downloaded. node-llama-cpp stores a model's files
 *  FLAT in the folder it is given, with no subfolders (verified against its
 *  `buildHuggingFaceFilePrefix`), so matching by basename is correct. */
export function snapshotFreshness(folder: string): FreshnessProbe {
  const present = looseGgufFiles(folder).map((entry) => entry.name);
  return (resolved) => !present.includes(path.basename(resolved));
}

/** Download `uri` into its folder under `dir` unless it is already on disk,
 *  and return the file to load. A fresh download is checked against
 *  `sha256` when there is one; `label` names the model in that error. */
export async function downloadGgufModel(
  dir: string,
  uri: string,
  sha256: string | undefined,
  label: string,
): Promise<string> {
  const onDisk = downloadedGgufFile(dir, uri);
  if (onDisk !== null) {
    return onDisk;
  }
  const folder = ggufModelDir(dir, uri);
  const mod = await loadLocalProvider();
  // Snapshot freshness BEFORE resolving so we verify the bytes only once, right
  // after a real download. A file a crashed run left in the folder is already
  // there, so it is not checked again.
  const wasFresh = snapshotFreshness(folder);
  const resolved = await mod.resolveModel(uri, folder);
  if (sha256 !== undefined && wasFresh(resolved)) {
    await verifyModelFile(resolved, sha256, label);
  }
  // Record-after-verify: a file that fails its hash check throws above, and
  // a folder with no record is not a model.
  writeGgufModelRecord(folder, uri, path.basename(resolved));
  return resolved;
}

/** The file to load for a URI already downloaded: the entry its folder's
 *  record names, or for a download from before those folders, the file the
 *  download manifest names. Null when it has to be downloaded. */
function downloadedGgufFile(dir: string, uri: string): string | null {
  const folder = ggufModelDir(dir, uri);
  const record = readGgufModelRecord(folder);
  if (record !== null) {
    if (record.uri !== uri) {
      throw new Error(
        `${folder} holds ${record.uri}, not ${uri}. Remove that model with "agency local remove ${record.uri} -f", or download ${uri} into another models directory.`,
      );
    }
    if (stat(root(folder), record.entry)?.isFile()) {
      return path.join(folder, record.entry);
    }
  }
  const legacy = readDownloadManifest(dir)[uri];
  if (legacy !== undefined && stat(root(dir), legacy)?.isFile()) {
    return path.join(dir, legacy);
  }
  return null;
}
