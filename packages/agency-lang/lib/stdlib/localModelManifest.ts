import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/** downloads.json in the models cache dir: resolved model URI → the .gguf
 *  basename node-llama-cpp stored it under. Written on successful (verified)
 *  download; read only by the `agency local list` view. Display metadata:
 *  resolution, downloading, and verification never consult it, so a missing
 *  or corrupt manifest can mislabel the list and nothing else — and for the
 *  same reason `recordDownload` NEVER throws (a bookkeeping failure must not
 *  turn a successful download into a failed command). Writes go through a
 *  uniquely-named sibling temp file + rename: an interrupted write keeps the
 *  previous valid manifest, and two concurrent downloaders cannot collide on
 *  the temp file — they race whole-file on the rename (last writer wins),
 *  accepted for display metadata. */
export const MANIFEST_FILE = "downloads.json";

export function readDownloadManifest(dir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf-8"),
    );
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
  // Unique per writer: a fixed name would make two concurrent downloads race
  // on the SAME temp file — the loser's rename throws ENOENT after its model
  // downloaded fine.
  const tmp = path.join(
    dir,
    `${MANIFEST_FILE}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
    const next = { ...readDownloadManifest(dir), [uri]: file };
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    fs.renameSync(tmp, path.join(dir, MANIFEST_FILE));
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never written, or already renamed */
    }
    console.warn(
      `Could not record the download in ${MANIFEST_FILE} (the list view may not mark this model):`,
      (err as Error).message,
    );
  }
}
