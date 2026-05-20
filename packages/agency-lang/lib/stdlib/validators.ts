import { success, failure } from "../runtime/result.js";
import type { ResultValue } from "../runtime/result.js";

// Format taken from RFC 5322 simplified — same one used by HTML5 input[type=email].
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function _isEmail(value: string): ResultValue {
  return EMAIL_RE.test(value)
    ? success(value)
    : failure(`not a valid email: ${JSON.stringify(value)}`);
}

export function _isUrl(value: string): ResultValue {
  return URL_RE.test(value)
    ? success(value)
    : failure(`not a valid URL: ${JSON.stringify(value)}`);
}

export function _isUuid(value: string): ResultValue {
  return UUID_RE.test(value)
    ? success(value)
    : failure(`not a valid UUID: ${JSON.stringify(value)}`);
}

export function _isInt(value: number): ResultValue {
  return Number.isInteger(value)
    ? success(value)
    : failure(`expected integer, got ${value}`);
}

export function _isPositive(value: number): ResultValue {
  return value > 0
    ? success(value)
    : failure(`expected positive number, got ${value}`);
}

export function _isNegative(value: number): ResultValue {
  return value < 0
    ? success(value)
    : failure(`expected negative number, got ${value}`);
}

// ---------------------------------------------------------------------------
// Parameterized validators
//
// These are plain two-argument validators. The first argument is the
// configuration parameter (e.g. the minimum value), the second is the
// value being validated. Users bind the configuration parameter via
// Agency's partial-application (PFA) syntax when using them inside a
// `@validate(...)` tag:
//
//   @validate(min.partial(n: 0))
//   type NonNegative = number
//
// `.partial(n: 0)` produces a single-argument `AgencyFunction` that the
// validation chain invokes with the value to check. See
// `docs/site/guide/type-validation.md` for usage details.
// ---------------------------------------------------------------------------

export function _min(n: number, value: number): ResultValue {
  return value >= n
    ? success(value)
    : failure(`expected value >= ${n}, got ${value}`);
}

export function _max(n: number, value: number): ResultValue {
  return value <= n
    ? success(value)
    : failure(`expected value <= ${n}, got ${value}`);
}

export function _minLength(n: number, value: string): ResultValue {
  return value.length >= n
    ? success(value)
    : failure(`expected length >= ${n}, got ${value.length}`);
}

export function _maxLength(n: number, value: string): ResultValue {
  return value.length <= n
    ? success(value)
    : failure(`expected length <= ${n}, got ${value.length}`);
}

export function _matches(pattern: string, value: string): ResultValue {
  const re = new RegExp(pattern);
  return re.test(value)
    ? success(value)
    : failure(`value does not match pattern ${re.source}`);
}
