import * as fs from "node:fs";
import * as path from "node:path";

/** downloads.json in the models cache dir: resolved model URI → the .gguf
 *  basename node-llama-cpp stored it under. Written on successful (verified)
 *  download; read only by the `agency local list` view. Display metadata:
 *  resolution, downloading, and verification never consult it, so a missing
 *  or corrupt manifest can mislabel the list and nothing else. Writes go
 *  through a sibling temp file + rename so an interrupted write keeps the
 *  previous valid manifest; two agency processes downloading concurrently
 *  still race whole-file (last writer wins) — accepted for display metadata. */
export const MANIFEST_FILE = "downloads.json";

export function readDownloadManifest(dir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf-8"),
    );
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function recordDownload(dir: string, uri: string, file: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...readDownloadManifest(dir), [uri]: file };
  const target = path.join(dir, MANIFEST_FILE);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, target);
}
