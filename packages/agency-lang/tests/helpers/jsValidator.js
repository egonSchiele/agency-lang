import { success, failure } from "agency-lang/runtime";

/**
 * Plain JS validator used by tests to confirm that `@validate(...)`
 * works with non-Agency functions. Receives only the value to check —
 * not the runtime ctx — per the documented validator contract.
 */
export function isShort(value) {
  return typeof value === "string" && value.length <= 5
    ? success(value)
    : failure(`expected short string, got ${JSON.stringify(value)}`);
}
