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
