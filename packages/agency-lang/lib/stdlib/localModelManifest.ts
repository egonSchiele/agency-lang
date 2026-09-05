import { root, mkdir, readText, writeText } from "./contained.js";

/** downloads.json in the models cache dir: resolved model URI → the .gguf
 *  basename node-llama-cpp stored it under. Written on successful (verified)
 *  download; read only by the `agency local list` view. Display metadata:
 *  resolution, downloading, and verification never consult it, so a missing
 *  or corrupt manifest can mislabel the list and nothing else — and for the
 *  same reason `recordDownload` NEVER throws (a bookkeeping failure must not
 *  turn a successful download into a failed command). `writeText` replaces
 *  the file by renaming a uniquely named sibling over it, so an interrupted
 *  write keeps the previous valid manifest, and two concurrent downloaders
 *  race whole-file on the rename (last writer wins), accepted for display
 *  metadata. */
export const MANIFEST_FILE = "downloads.json";

export function readDownloadManifest(dir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readText(root(dir), MANIFEST_FILE));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    // Null-prototype: on-disk JSON is untrusted, and keys like "__proto__" /
    // "toString" must behave as plain data (same convention as smoltalk's
    // provider registry).
    const out: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function recordDownload(dir: string, uri: string, file: string): void {
  try {
    const cache = root(dir);
    mkdir(cache, ".");
    const next = { ...readDownloadManifest(dir), [uri]: file };
    writeText(cache, MANIFEST_FILE, JSON.stringify(next, null, 2) + "\n");
  } catch (err) {
    console.warn(
      `Could not record the download in ${MANIFEST_FILE} (the list view may not mark this model):`,
      (err as Error).message,
    );
  }
}
