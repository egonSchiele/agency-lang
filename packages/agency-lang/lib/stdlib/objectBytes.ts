import { failure, type ResultFailure } from "../runtime/result.js";

/**
 * One shared object-size policy for AWS object bodies. Raw downloads and decoded
 * uploads intentionally share this limit — it bounds the bytes held in memory,
 * so both directions are capped by the same number rather than two drifting ones.
 */
export const AWS_OBJECT_BYTE_LIMIT = 10 * 1024 * 1024;

/** A `failure` when `bytes` exceeds the object limit, or `null` when it fits. */
export function objectSizeFailure(bytes: Uint8Array): ResultFailure | null {
  if (bytes.byteLength > AWS_OBJECT_BYTE_LIMIT) {
    return failure({
      message:
        `Object body is ${bytes.byteLength} bytes, over the ` +
        `${AWS_OBJECT_BYTE_LIMIT}-byte limit.`,
    });
  }
  return null;
}
