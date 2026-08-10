import { failure, type ResultFailure } from "../runtime/result.js";
import { AWS_OBJECT_BYTE_LIMIT } from "../constants.js";

/** A `failure` when `bytes` exceeds the AWS object limit, or `null` when it fits. */
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
