import { fixedPath, readStream, stat } from "agency-lang/stdlib-lib/contained.js";

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

/** The first bytes of a file the caller already validated (`spelling` is
 *  the real path an effect named), read through a descriptor that refuses
 *  a link, stopping once `wanted(bytes)` says enough has arrived. */
function readHead(spelling: string, wanted: (bytes: Buffer) => number | null): Promise<Buffer> {
  const located = fixedPath(spelling);
  const stream = readStream(located.root, located.target);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      const need = wanted(Buffer.concat(chunks));
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
 *  announces. Null until the length field is in. */
function headerLength(bytes: Buffer): number | null {
  if (bytes.length < LENGTH_BYTES) {
    return null;
  }
  return LENGTH_BYTES + Number(bytes.readBigUInt64LE(0));
}

export async function readSafetensorsHeader(spelling: string): Promise<SafetensorsHeader> {
  const located = fixedPath(spelling);
  const info = stat(located.root, located.target);
  if (info === null || !info.isFile()) {
    throw new Error(`${spelling} is not a file.`);
  }
  const head = await readHead(spelling, headerLength);
  if (head.length < LENGTH_BYTES) {
    throw new Error(`${spelling} is too short to be a safetensors file.`);
  }
  const length = Number(head.readBigUInt64LE(0));
  if (length > MAX_HEADER_BYTES) {
    throw new Error(`${spelling} has a ${length}-byte header; an adapter's is far smaller.`);
  }
  const text = head.subarray(LENGTH_BYTES, LENGTH_BYTES + length).toString("utf8");
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
