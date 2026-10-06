import { sha256Bytes, hmacSha256 as hmacSha256Bytes } from "#sha256";

// Hashing for the runtime and the stdlib. The two primitives come from
// `#sha256`, which package.json resolves to sha256.node.ts on Node and to
// sha256.portable.ts in a browser bundle. That entry in the "imports" field
// is one of the few places the two platforms may differ; see
// docs/dev/runtime/running-without-node.md. Everything else in this file is
// the same on both.

export { sha256Bytes };

/** HMAC-SHA256 of `data` under `key`, as 32 bytes. A string is used as UTF-8. */
export function hmacSha256(key: Uint8Array | string, data: Uint8Array | string): Uint8Array {
  return hmacSha256Bytes(toBytes(key), toBytes(data));
}

/** The SHA-256 digest of `data` as lowercase hex. A string is hashed as UTF-8. */
export function sha256Hex(data: Uint8Array | string): string {
  return toHex(sha256Bytes(toBytes(data)));
}

/** The SHA-256 digest of a UTF-8 string, as lowercase hex. */
export function sha256Text(value: string): string {
  return sha256Hex(value);
}

/** Bytes as lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function toBytes(value: Uint8Array | string): Uint8Array {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return value;
}
