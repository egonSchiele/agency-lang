import { createHash, createHmac } from "crypto";

// The two hashing primitives on Node, where OpenSSL is about nine times
// faster than the portable implementation. `#sha256` resolves here on Node
// and to sha256.portable.ts in a browser bundle. See hash.ts.

/** The SHA-256 digest of `data`, as 32 bytes. */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

/** HMAC-SHA256 of `data` under `key`, as 32 bytes. */
export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data).digest());
}
