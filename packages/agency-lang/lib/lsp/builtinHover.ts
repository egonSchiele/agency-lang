import type { BuiltinSignature } from "../typeChecker/types.js";
import { BUILTIN_FUNCTION_TYPES } from "../typeChecker/builtins.js";
import { JS_GLOBALS, lookupJsMember } from "../typeChecker/resolveCall.js";
import { formatTypeHint } from "../utils/formatType.js";

/**
 * Format a BuiltinSignature as a callable type string. Shape:
 *   (T1, T2, ...) => R
 * Variadic params (`restParam`) render as `...T[]`.
 */
function formatSig(sig: BuiltinSignature): string {
  const parts = sig.params.map((p) =>
    p === "any" ? "any" : formatTypeHint(p),
  );
  if (sig.restParam !== undefined) {
    const rest =
      sig.restParam === "any" ? "any" : formatTypeHint(sig.restParam);
    parts.push(`...${rest}[]`);
  }
  const ret = sig.returnType === "any" ? "any" : formatTypeHint(sig.returnType);
  return `(${parts.join(", ")}) => ${ret}`;
}

/**
 * Hover info for a name that may be a language primitive or JS global.
 * Returns a markdown-formatted string ready for `Hover.contents.value`,
 * or `null` if the name isn't recognized.
 *
 * Currently covers:
 *   - True language primitives in BUILTIN_FUNCTION_TYPES (success,
 *     failure, llm, …).
 *   - Flat callable JS globals with a populated `sig` (parseInt, …).
 *   - JS namespace bases (JSON, Math, …) — describes the namespace.
 *
 * Stdlib functions (print, fetch, …) come through importedFunctions,
 * which the existing semantic-symbol path already handles.
 */
export function lookupBuiltinHover(name: string): string | null {
  if (Object.prototype.hasOwnProperty.call(BUILTIN_FUNCTION_TYPES, name)) {
    const sig = BUILTIN_FUNCTION_TYPES[name];
    return [
      "```agency",
      `${name}: ${formatSig(sig)}`,
      "```",
      "",
      "_Agency language primitive._",
    ].join("\n");
  }
  if (Object.prototype.hasOwnProperty.call(JS_GLOBALS, name)) {
    const entry = JS_GLOBALS[name];
    if (entry.kind === "callable") {
      const sigText = entry.sig ? formatSig(entry.sig) : "(any) => any";
      return [
        "```ts",
        `${name}: ${sigText}`,
        "```",
        "",
        "_JavaScript global._",
      ].join("\n");
    }
    // namespace
    const memberNames = Object.keys(entry.members).sort();
    return [
      "```ts",
      `namespace ${name}`,
      "```",
      "",
      "_JavaScript namespace._",
      "",
      `Members: ${memberNames.join(", ")}`,
    ].join("\n");
  }
  return null;
}

/**
 * Hover info for a `<JsNamespace>.<member>` pair (e.g. `JSON.parse`).
 * Returns null if the chain doesn't resolve to a known JS global.
 */
export function lookupJsMemberHover(
  baseName: string,
  memberName: string,
): string | null {
  const entry = lookupJsMember([baseName, memberName]);
  if (!entry || entry.kind !== "callable") return null;
  const sigText = entry.sig ? formatSig(entry.sig) : "(any) => any";
  return [
    "```ts",
    `${baseName}.${memberName}: ${sigText}`,
    "```",
    "",
    "_JavaScript global._",
  ].join("\n");
}
