import { timingSafeEqual } from "crypto";

export function checkAuth(
  configuredKey: string | undefined,
  authHeader: string | undefined,
): boolean {
  if (!configuredKey) return true;
  if (!authHeader) return false;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;
  return constantTimeStringEqual(parts[1], configuredKey);
}

/**
 * Constant-time string comparison. Returns false immediately on length
 * mismatch (which leaks length, but that's acceptable for fixed-length
 * secrets and the alternative — comparing variable-length buffers — would
 * require a different cryptographic primitive). For equal-length inputs the
 * comparison time does not depend on the position of the first differing byte.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
