// The synchronous file operations of nodeHost, not host.files: local models are Node-only.
import { root, readText } from "../host/node/nodeFiles.js";

/** downloads.json in the models cache dir: model URI → the .gguf file name
 *  node-llama-cpp stored it under. Downloads before GGUF models had their
 *  own folders wrote it; nothing writes it now. It is still read so those
 *  files load, list, and remove without being downloaded again. A missing
 *  or corrupt manifest reads as empty, so such a file shows up as an
 *  unclaimed file in the list, and nothing else. */
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
