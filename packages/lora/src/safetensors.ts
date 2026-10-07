import { fixedPath, readStream, stat } from "agency-lang/host-lib/node/nodeFiles.js";

/** A safetensors file starts with an 8-byte little-endian length, then
 *  that many bytes of JSON: one entry per tensor, plus `__metadata__`, a
 *  map of strings. Reading the header says what an adapter is without
 *  loading a tensor. */

/** A header longer than this is not an adapter's. */
export const MAX_HEADER_BYTES = 10_000_000;
const LENGTH_BYTES = 8;

export type SafetensorsHeader = {
  metadata: Record<string, string>;
  tensorCount: number;
  sizeBytes: number;
};

/** The length field and header of a file the caller already validated
 *  (`spelling` is the real path an effect named), read through a
 *  descriptor that refuses a link. It stops as soon as the length field
 *  is in when the length is too large, and as soon as the header is in
 *  otherwise, so a bogus length never reads the rest of the file. */
function readHead(spelling: string): Promise<Buffer> {
  const located = fixedPath(spelling);
  const stream = readStream(located.root, located.target);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let need: number | null = null;
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (need === null && total >= LENGTH_BYTES) {
        try {
          need = headerLength(Buffer.concat(chunks).subarray(0, LENGTH_BYTES), spelling);
        } catch (err) {
          stream.destroy();
          reject(err);
          return;
        }
      }
      if (need !== null && total >= need) {
        stream.destroy();
        resolve(Buffer.concat(chunks).subarray(0, need));
      }
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** How many bytes the header needs: the length field, then the JSON it
 *  announces. Throws when the announced length is more than an adapter's
 *  header could be. */
export function headerLength(lengthField: Buffer, spelling: string): number {
  const length = Number(lengthField.readBigUInt64LE(0));
  if (length > MAX_HEADER_BYTES) {
    throw new Error(`${spelling} has a ${length}-byte header; an adapter's is far smaller.`);
  }
  return LENGTH_BYTES + length;
}

export async function readSafetensorsHeader(spelling: string): Promise<SafetensorsHeader> {
  const located = fixedPath(spelling);
  const info = stat(located.root, located.target);
  if (info === null || !info.isFile()) {
    throw new Error(`${spelling} is not a file.`);
  }
  const head = await readHead(spelling);
  if (head.length < LENGTH_BYTES) {
    throw new Error(`${spelling} is too short to be a safetensors file.`);
  }
  const text = head.subarray(LENGTH_BYTES, headerLength(head, spelling)).toString("utf8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${spelling} has a header that is not JSON; it is not a safetensors file.`);
  }
  const raw = parsed.__metadata__;
  const metadata: Record<string, string> = {};
  if (raw !== null && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string") {
        metadata[key] = value;
      }
    }
  }
  const tensorCount = Object.keys(parsed).filter((key) => key !== "__metadata__").length;
  return { metadata, tensorCount, sizeBytes: info.size };
}
