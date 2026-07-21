import { __isJsonValue } from "../runtime/jsonValue.js";
import { success, failure } from "../runtime/result.js";
import type { ResultValue } from "../runtime/result.js";

/** stdlib bridge for `std::validation`'s `isJsonValue`. Returns a runtime
 *  `Result` like the other stdlib validators (validators.ts), with the
 *  offending path folded into the failure message. */
export function _isJsonValue(value: unknown): ResultValue {
  const check = __isJsonValue(value);
  if (check.ok) {
    return success(value);
  }
  return failure(
    check.path === "" ? check.reason : `${check.reason} at ${check.path}`,
  );
}
