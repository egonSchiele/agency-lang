import type { GlobalStore } from "./state/globalStore.js";

export const REDACTED = "[REDACTED]";

/**
 * One thing a statelog event must not carry. A rule gets a value from the
 * event, before any `toJSON` ran on it, and the object that holds the value.
 * It returns the text to log in the value's place, or undefined to leave the
 * value to the next rule.
 */
export type ScrubRule = (raw: unknown, parent: unknown) => string | undefined;

type Replacer = (this: unknown, key: string, value: unknown) => unknown;

/** The replacer used when no rule fires: the value unchanged. */
function keepValue(this: unknown, _key: string, value: unknown): unknown {
  return value;
}

/**
 * Build a `JSON.stringify` replacer that runs each rule in order and logs the
 * first replacement. When no rule fires, `fallback` decides (by default the
 * value is kept).
 *
 * A replacer, not a deep copy, so the rules run inside the one stringify that
 * serializes the event, and Date, URL, and other `toJSON` values serialize as
 * they normally would. JSON.stringify applies `toJSON` before it calls the
 * replacer, so `value` may already be converted. `this[key]` still holds the
 * original, and that is what the rules see, since a redact tag is set on the
 * original. At the root key "", `this[""]` is `value`.
 *
 * Cycles are left to JSON.stringify, which throws on them: a cyclic body could
 * never have been serialized in the first place.
 */
export function makeScrubReplacer(
  rules: readonly ScrubRule[],
  fallback: Replacer = keepValue,
): Replacer {
  return function scrubReplacer(this: unknown, key: string, value: unknown): unknown {
    const raw = key === "" ? value : (this as Record<string, unknown>)[key];
    for (const rule of rules) {
      const replacement = rule(raw, this);
      if (replacement !== undefined) {
        return replacement;
      }
    }
    return fallback.call(this, key, value);
  };
}

/**
 * Swap a value marked `redact` for its marker, and scrub a redacted string
 * that was interpolated into a larger one, since that larger string is a new
 * value with no tag of its own. When `globals` holds no tags at all, the rule
 * never fires and costs nothing per value.
 */
export function redactRule(globals: GlobalStore): ScrubRule {
  if (!globals.hasAnyTags()) {
    return () => undefined;
  }
  return (raw) => {
    const replacement = globals.redactionReplacement(raw);
    if (replacement !== undefined) {
      return replacement;
    }
    if (typeof raw === "string") {
      return globals.redactContainedStrings(raw);
    }
    return undefined;
  };
}

/** A string this long or shorter is logged as it is, even when it is base64. */
export const BINARY_OMIT_MIN_LENGTH = 4096;

/** Base64 and base64url characters, with up to two `=` of padding at the end. */
const BASE64_TEXT = /^[A-Za-z0-9+/_-]+={0,2}$/;
const UPPERCASE_LETTER = /[A-Z]/;
const LOWERCASE_LETTER = /[a-z]/;

/** How far into a `data:` URI to look for the comma that ends its header. */
const DATA_URI_HEADER_MAX = 256;

/**
 * Replace picture bytes, and any other binary data sent as base64, with a
 * marker such as `[image/png: 6000 bytes omitted]`. A string matches when it
 * is longer than `BINARY_OMIT_MIN_LENGTH` and is either a `data:` URI with
 * `;base64,`, or all base64 or base64url characters with both upper- and
 * lowercase letters among them. Prose and JSON never match, since they contain
 * spaces or punctuation outside that alphabet. Hex, long numbers, and
 * one-letter filler never match either: base64 of real binary data always
 * mixes the two cases.
 *
 * The mime type comes from the `data:` URI's header, or else from a string
 * `mimeType` beside the value. Agency's attachment shape keeps it there:
 * `{ kind: "base64", base64, mimeType }`. With neither, the marker says
 * `base64`.
 */
export const omitBinaryRule: ScrubRule = (raw, parent) => {
  if (typeof raw !== "string" || raw.length <= BINARY_OMIT_MIN_LENGTH) {
    return undefined;
  }
  const dataUri = parseDataUri(raw);
  if (dataUri !== undefined) {
    return binaryMarker(dataUri.mimeType ?? mimeTypeBeside(parent), dataUri.payload);
  }
  if (!isBinaryText(raw)) {
    return undefined;
  }
  return binaryMarker(mimeTypeBeside(parent), raw);
};

function isBinaryText(text: string): boolean {
  return BASE64_TEXT.test(text) && UPPERCASE_LETTER.test(text) && LOWERCASE_LETTER.test(text);
}

type DataUri = { mimeType: string | undefined; payload: string };

/** The mime type and payload of a base64 `data:` URI; undefined for any
 *  other string. */
function parseDataUri(text: string): DataUri | undefined {
  if (!text.startsWith("data:")) {
    return undefined;
  }
  const comma = text.slice(0, DATA_URI_HEADER_MAX).indexOf(",");
  if (comma === -1) {
    return undefined;
  }
  const header = text.slice("data:".length, comma);
  if (!header.endsWith(";base64")) {
    return undefined;
  }
  const mimeType = header.split(";")[0];
  return { mimeType: mimeType === "" ? undefined : mimeType, payload: text.slice(comma + 1) };
}

function mimeTypeBeside(parent: unknown): string | undefined {
  if (parent === null || typeof parent !== "object" || Array.isArray(parent)) {
    return undefined;
  }
  const mimeType = (parent as Record<string, unknown>).mimeType;
  return typeof mimeType === "string" && mimeType !== "" ? mimeType : undefined;
}

function binaryMarker(mimeType: string | undefined, base64: string): string {
  return `[${mimeType ?? "base64"}: ${decodedLength(base64)} bytes omitted]`;
}

/** How many bytes `base64` decodes to: three for every four characters, less
 *  one for each `=` of padding. */
function decodedLength(base64: string): number {
  const padding = (base64.endsWith("=") ? 1 : 0) + (base64.endsWith("==") ? 1 : 0);
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** The rules every statelog event goes through, in order: the redact tag
 *  first, so a redacted picture shows its redaction marker, then binary data. */
export function statelogScrubRules(globals: GlobalStore | undefined): ScrubRule[] {
  return globals === undefined ? [omitBinaryRule] : [redactRule(globals), omitBinaryRule];
}

/** The fields every statelog line has. The rules apply to `data` alone. */
export type StatelogEnvelope = {
  format_version: number;
  trace_id: string;
  project_id: string;
  span_id: string | null;
  parent_span_id: string | null;
  data: Record<string, unknown>;
};

/**
 * Serialize an event in one `JSON.stringify`. The scrub rules see only `data`,
 * so a pathological redaction, such as a tag on the number 1, can never blank
 * an envelope field such as `format_version`.
 */
export function stringifyStatelogEvent(
  envelope: StatelogEnvelope,
  rules: readonly ScrubRule[],
): string {
  const scrub = makeScrubReplacer(rules);
  return JSON.stringify(envelope, function (this: unknown, key: string, value: unknown) {
    if (this === envelope && key !== "data") {
      return value;
    }
    return scrub.call(this, key, value);
  });
}
