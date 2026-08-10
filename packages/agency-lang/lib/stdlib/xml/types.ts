export type XmlText = { kind: "text"; text: string };

export type XmlElement = {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
};

export type XmlNode = XmlElement | XmlText;

export type XmlDocument = { root: XmlElement };

export type ParseXmlResult =
  | { ok: true; doc: XmlDocument }
  | { ok: false; error: string };

// Input larger than this fails fast (UTF-8 bytes, measured before parsing).
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;

// Root element is depth 1; opening depth MAX_DEPTH + 1 is a parse failure,
// checked before recursing. Spike-measured: the uncapped combinator stack
// overflows near nesting depth ~2100, so 256 keeps an ~8x margin.
export const MAX_DEPTH = 256;

// Total emitted elements + retained text nodes + attributes. Spike-measured:
// hostile tiny-element input allocates ~420 bytes of heap per entry, so this
// cap bounds a worst-case parse near ~105 MB transient heap while still
// admitting a 10 MiB feed-like document (~177k entries).
export const MAX_TREE_ENTRIES = 250_000;
