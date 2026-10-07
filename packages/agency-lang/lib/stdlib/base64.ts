/**
 * One strict base64 decoder shared by every caller (writeBinary, S3 binary
 * uploads). A lenient decoder silently drops invalid characters and
 * truncates at bad padding, so it would produce corrupted bytes rather than
 * fail. This validates first and throws a clear error; whitespace is allowed
 * and ignored. The decoding itself is the platform's own `atob`, which Node
 * and browsers both have.
 */
export const BASE64_QUANTUM_LENGTH = 4;
export const BASE64_MAX_PADDING_LENGTH = 2;
// Standard base64 alphabet, with padding only at the end (terminal) and at most
// BASE64_MAX_PADDING_LENGTH `=` characters.
export const BASE64_ALPHABET_AND_PADDING = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeBase64Strict(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, "");
  if (
    normalized.length % BASE64_QUANTUM_LENGTH !== 0 ||
    !BASE64_ALPHABET_AND_PADDING.test(normalized)
  ) {
    throw new Error("`base64` is not valid base64-encoded data (expected standard base64).");
  }
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** `encodeBase64` in the URL-safe alphabet with no padding, the way
 *  `base64url` spells it. */
export function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The number of bytes in the UTF-8 encoding of `text`. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Standard base64 with padding, through the platform's own `btoa`, which
 *  Node and browsers both have. `btoa` takes a string of byte values. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** `encodeBase64` of the UTF-8 bytes of `text`. */
export function encodeBase64Text(text: string): string {
  return encodeBase64(new TextEncoder().encode(text));
}
