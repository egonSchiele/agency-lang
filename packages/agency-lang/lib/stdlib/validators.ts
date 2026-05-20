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
// Each `_X(...)` is a factory: it captures its parameters and returns a
// fresh `(value) => ResultValue` validator closure. This means a tag like
// `@validate(maxLength(80))` instantiates the validator once at module
// load — the factory does NOT re-run on every validation call.
//
// All five validators here are usable with `@validate(...)` because their
// returned closure matches the plain-JS validator contract `(value) => Result`.
// ---------------------------------------------------------------------------

export function _min(n: number): (value: number) => ResultValue {
  return (value: number): ResultValue =>
    value >= n
      ? success(value)
      : failure(`expected value >= ${n}, got ${value}`);
}

export function _max(n: number): (value: number) => ResultValue {
  return (value: number): ResultValue =>
    value <= n
      ? success(value)
      : failure(`expected value <= ${n}, got ${value}`);
}

export function _minLength(n: number): (value: string) => ResultValue {
  return (value: string): ResultValue =>
    value.length >= n
      ? success(value)
      : failure(`expected length >= ${n}, got ${value.length}`);
}

export function _maxLength(n: number): (value: string) => ResultValue {
  return (value: string): ResultValue =>
    value.length <= n
      ? success(value)
      : failure(`expected length <= ${n}, got ${value.length}`);
}

export function _matches(
  pattern: string | RegExp,
): (value: string) => ResultValue {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  return (value: string): ResultValue =>
    re.test(value)
      ? success(value)
      : failure(`value does not match pattern ${re.source}`);
}
