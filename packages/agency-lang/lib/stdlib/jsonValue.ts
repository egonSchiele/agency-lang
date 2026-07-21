import { __isJsonValue } from "../runtime/jsonValue.js";

export type JsonCheckResult = { ok: boolean; path: string; reason: string };

/** stdlib bridge for `std::validation`'s `isJsonValue`. Returns a plain
 *  object (never throws) so the Agency wrapper can build the failure
 *  message with the offending path. */
export function _isJsonValue(value: unknown): JsonCheckResult {
  const result = __isJsonValue(value);
  if (result.ok) {
    return { ok: true, path: "", reason: "" };
  }
  return { ok: false, path: result.path, reason: result.reason };
}
