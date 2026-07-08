import type { GlobalStore } from "./state/globalStore.js";

export const REDACTED = "[REDACTED]";

/**
 * Build a `JSON.stringify` replacer bound to `globals` that swaps any value
 * marked `redact: true` for "[REDACTED]" and returns everything else
 * unchanged.
 *
 * Implemented as a replacer rather than a pre-copy deep-walk so it (a) runs
 * inside the single JSON.stringify statelog already performs — no second
 * traversal or deep copy — and (b) inherits JSON.stringify's native handling
 * of Date/URL/toJSON-bearing values. A value with a toJSON reaches the
 * replacer already converted to a primitive; `this[key]` still holds the
 * original object, which is what the value/reference tag lookup needs. This
 * mirrors `nativeTypeReplacer` (lib/runtime/revivers/index.ts).
 *
 * Cycles are left to JSON.stringify, which throws on them exactly as the
 * statelog stringify does today — the replacer adds no cycle handling because
 * a cyclic body could never have been serialized in the first place.
 */
export function makeRedactReplacer(
  globals: GlobalStore,
): (this: unknown, key: string, value: unknown) => unknown {
  return function redactReplacer(
    this: unknown,
    key: string,
    value: unknown,
  ): unknown {
    // Recover the raw, pre-toJSON value for the tag lookup. JSON.stringify
    // applies toJSON() BEFORE calling the replacer, so `value` may already be
    // transformed (e.g. a Date → ISO string, or a custom toJSON returning an
    // object). `this[key]` still holds the original value the tag was set on,
    // so always read from there for non-root keys. (Root is the wrapper's ""
    // key, where this[""] === value anyway.)
    const raw = key === "" ? value : (this as Record<string, unknown>)[key];
    if (globals.isRedacted(raw)) return REDACTED;
    return value;
  };
}
