// Character-reference decoding and raw-character validation for text runs
// and attribute values. Operates on the newline-normalized parser input
// (grammar.ts normalizes the complete source once, so offsets here and
// tarsec positions share one coordinate system). CDATA content never goes
// through this — it is retained raw.

export type DecodeOutcome =
  | { ok: true; text: string }
  // offset is absolute in the normalized source (baseOffset + position
  // within the run), pointing at the offending character or `&`.
  | { ok: false; message: string; offset: number };

const AMP = 0x26;
const HASH = 0x23;
const SEMI = 0x3b;

// Legal XML characters: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD]
// | [#x10000-#x10FFFF]. Takes a full code point (surrogate pairs already
// combined by the caller).
export function isXmlChar(cp: number): boolean {
  if (cp === 0x9 || cp === 0xa || cp === 0xd) return true;
  if (cp >= 0x20 && cp <= 0xd7ff) return true;
  if (cp >= 0xe000 && cp <= 0xfffd) return true;
  return cp >= 0x10000 && cp <= 0x10ffff;
}

function isEntityNameStart(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x3a;
}

function isEntityNameChar(c: number): boolean {
  return isEntityNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x2d;
}

const PREDEFINED: Record<string, string> = {
  "amp;": "&",
  "lt;": "<",
  "gt;": ">",
  "quot;": '"',
  "apos;": "'",
};

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

function formatCodePoint(cp: number): string {
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Decode character references in one text run or attribute value, and
 * validate every raw character against the XML `Char` ranges (rejecting
 * forbidden controls and unpaired surrogates). One left-to-right pass;
 * decoding happens exactly once, so `&amp;lt;` yields the four characters
 * `&lt;`. A bare `&` that does not begin a valid reference is emitted as a
 * literal ampersand (the parser's one recovery rule).
 *
 * `baseOffset` is the run's start offset in the normalized source; failure
 * offsets are absolute in that source.
 */
export function decodeReferences(run: string, baseOffset: number): DecodeOutcome {
  const n = run.length;
  // Chunked copy: scan with charCodeAt, slice whole segments only at
  // reference boundaries, and hand back the input string untouched when
  // nothing decoded. Per-character string building was ~6x slower.
  let out = "";
  let segStart = 0;
  let decoded = false;
  let i = 0;
  while (i < n) {
    const c = run.charCodeAt(i);
    // Fast path: everything from ' (0x27) up to the surrogate range is a
    // plain legal character (& is 0x26, so it falls through).
    if (c >= 0x27 && c < 0xd800) {
      i++;
      continue;
    }
    if (c === AMP) {
      const ref = decodeOneReference(run, i);
      if (ref.kind === "failure") {
        return { ok: false, message: ref.message, offset: baseOffset + i };
      }
      if (ref.kind === "decoded") {
        out += run.slice(segStart, i) + ref.text;
        segStart = ref.next;
        i = ref.next;
        decoded = true;
        continue;
      }
      i++; // literal ampersand: keep it in the current segment
      continue;
    }
    if ((c >= 0x20 && c < 0xd800) || c === 0x9 || c === 0xa || c === 0xd) {
      i++;
      continue;
    }
    if (c >= 0xe000 && c <= 0xfffd) {
      i++;
      continue;
    }
    // Surrogates: a proper pair is legal, anything unpaired is not.
    if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = i + 1 < n ? run.charCodeAt(i + 1) : -1;
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i += 2;
        continue;
      }
      return { ok: false, message: "unpaired surrogate is not a legal XML character", offset: baseOffset + i };
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      return { ok: false, message: "unpaired surrogate is not a legal XML character", offset: baseOffset + i };
    }
    return {
      ok: false,
      message: `forbidden character ${formatCodePoint(c)} is not a legal XML character`,
      offset: baseOffset + i,
    };
  }
  if (!decoded) return { ok: true, text: run };
  return { ok: true, text: out + run.slice(segStart) };
}

/**
 * Validate raw characters only (XML `Char` ranges, unpaired surrogates) with
 * no reference decoding. Used for CDATA content, which is retained verbatim.
 */
export function validateChars(run: string, baseOffset: number): DecodeOutcome {
  let i = 0;
  const n = run.length;
  while (i < n) {
    const c = run.charCodeAt(i);
    // Fast path: space up to the surrogate range, plus tab/LF/CR.
    if ((c >= 0x20 && c < 0xd800) || c === 0x9 || c === 0xa || c === 0xd) {
      i++;
      continue;
    }
    if (c >= 0xe000 && c <= 0xfffd) {
      i++;
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = i + 1 < n ? run.charCodeAt(i + 1) : -1;
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i += 2;
        continue;
      }
      return { ok: false, message: "unpaired surrogate is not a legal XML character", offset: baseOffset + i };
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      return { ok: false, message: "unpaired surrogate is not a legal XML character", offset: baseOffset + i };
    }
    if (!isXmlChar(c)) {
      return {
        ok: false,
        message: `forbidden character ${formatCodePoint(c)} is not a legal XML character`,
        offset: baseOffset + i,
      };
    }
    i++;
  }
  return { ok: true, text: run };
}

type OneReference =
  | { kind: "decoded"; text: string; next: number }
  | { kind: "literal" }
  | { kind: "failure"; message: string };

// `i` points at the `&`. The four rules from the spec, in order.
function decodeOneReference(run: string, i: number): OneReference {
  // Rule 1: the five predefined references, exact case.
  for (const key of Object.keys(PREDEFINED)) {
    if (run.startsWith(key, i + 1)) {
      return { kind: "decoded", text: PREDEFINED[key], next: i + 1 + key.length };
    }
  }
  const c1 = i + 1 < run.length ? run.charCodeAt(i + 1) : -1;
  // Rule 2: numeric references. `&#` commits to one.
  if (c1 === HASH) {
    let j = i + 2;
    const hex = j < run.length && (run.charCodeAt(j) === 0x78 /* x */);
    if (hex) j++;
    let value = 0;
    let digits = 0;
    while (j < run.length) {
      const d = run.charCodeAt(j);
      const dv = hex ? hexValue(d) : d >= 0x30 && d <= 0x39 ? d - 0x30 : -1;
      if (dv < 0) break;
      // Cap so a huge reference cannot overflow; anything past the max
      // code point fails the isXmlChar check below regardless.
      value = Math.min(value * (hex ? 16 : 10) + dv, 0x7fffffff);
      digits++;
      j++;
    }
    if (digits === 0 || j >= run.length || run.charCodeAt(j) !== SEMI) {
      return {
        kind: "failure",
        message: `malformed character reference (expected \`&#${hex ? "x" : ""}digits;\`)`,
      };
    }
    if (!isXmlChar(value)) {
      const shown = run.slice(i, j + 1);
      return {
        kind: "failure",
        message: `character reference ${shown} (${formatCodePoint(value)}) is not a legal XML character`,
      };
    }
    return { kind: "decoded", text: String.fromCodePoint(value), next: j + 1 };
  }
  // Rule 3: `&Name;` for any other name is unsupported.
  if (isEntityNameStart(c1)) {
    let j = i + 2;
    while (j < run.length && isEntityNameChar(run.charCodeAt(j))) j++;
    if (j < run.length && run.charCodeAt(j) === SEMI) {
      const name = run.slice(i + 1, j);
      return {
        kind: "failure",
        message: `unsupported entity &${name}; (only &amp; &lt; &gt; &quot; &apos; and numeric character references are supported)`,
      };
    }
  }
  // Rule 4: literal ampersand.
  return { kind: "literal" };
}
