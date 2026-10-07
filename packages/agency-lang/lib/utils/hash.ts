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

// The asynchronous pair below runs on WebCrypto, `crypto.subtle`, which
// Node and every browser have, so it is the same code on both platforms
// and the platform does the hashing. A caller that is async already (the
// S3 request signer, the OAuth PKCE challenge) uses these; the synchronous
// pair above stays for the callers that cannot await, such as the
// checkpoint checksum.

/** The SHA-256 digest of `data`, as 32 bytes, from WebCrypto. A string is
 *  hashed as UTF-8. */
export async function sha256BytesAsync(data: Uint8Array | string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toBuffer(toBytes(data))));
}

/** HMAC-SHA256 of `data` under `key`, as 32 bytes, from WebCrypto. A
 *  string is used as UTF-8. */
export async function hmacSha256Async(
  key: Uint8Array | string,
  data: Uint8Array | string,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBuffer(toBytes(key)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, toBuffer(toBytes(data))));
}

/** The SHA-256 digest of `data` as lowercase hex, from WebCrypto. */
export async function sha256HexAsync(data: Uint8Array | string): Promise<string> {
  return toHex(await sha256BytesAsync(data));
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

/** The bytes of `view` as an `ArrayBuffer` of their own, which WebCrypto
 *  takes; a view over a shared buffer, such as a Node `Buffer`, would
 *  otherwise hand it the whole pool. */
function toBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}
