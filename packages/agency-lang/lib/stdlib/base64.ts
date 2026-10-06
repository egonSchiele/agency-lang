/**
 * One strict base64 decoder shared by every caller (writeBinary, S3 binary
 * uploads). `Buffer.from(x, "base64")` silently drops invalid characters and
 * truncates at bad padding, so it would produce corrupted bytes rather than
 * fail. This validates first and throws a clear error; whitespace is allowed and
 * ignored.
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
  return new Uint8Array(Buffer.from(normalized, "base64"));
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding, in plain JavaScript so it runs where
 *  `Buffer` does not. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(triple >> 18) & 63];
    out += BASE64_ALPHABET[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "=";
  }
  return out;
}

/** `encodeBase64` of the UTF-8 bytes of `text`. */
export function encodeBase64Text(text: string): string {
  return encodeBase64(new TextEncoder().encode(text));
}
