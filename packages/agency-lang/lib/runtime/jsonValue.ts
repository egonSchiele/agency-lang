type JsonCheck = { ok: true } | { ok: false; path: string; reason: string };

/** Precise "round-trips through JSON.stringify/parse unchanged" check for
 *  the stdlib `Json` type. Plain data only: class instances (Date, Map, ...)
 *  and non-finite numbers are rejected because stringify silently rewrites
 *  them; functions/undefined/symbols do not serialize at all. */
export function __isJsonValue(value: unknown): JsonCheck {
  return walkJson(value, "", []);
}

function walkJson(value: unknown, path: string, ancestors: unknown[]): JsonCheck {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { ok: false, path, reason: "non-finite number serializes to null" };
    }
    return { ok: true };
  }
  if (Array.isArray(value)) {
    if (ancestors.includes(value)) {
      return { ok: false, path, reason: "cycle detected" };
    }
    const nested = [...ancestors, value];
    for (let i = 0; i < value.length; i++) {
      const result = walkJson(value[i], `${path}[${i}]`, nested);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true };
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return { ok: false, path, reason: "not a plain object (class instance)" };
    }
    if (ancestors.includes(value)) {
      return { ok: false, path, reason: "cycle detected" };
    }
    const nested = [...ancestors, value];
    for (const key of Object.keys(value)) {
      const result = walkJson(
        (value as Record<string, unknown>)[key],
        path === "" ? key : `${path}.${key}`,
        nested,
      );
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true };
  }
  return { ok: false, path, reason: `${typeof value} is not JSON-serializable` };
}
