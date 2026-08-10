// Bridge between stdlib/xml.agency and the XML parser core, following the
// stdlib-lib pattern (see stdlib/path.agency + lib/stdlib/path.ts). The
// underscored functions are the .agency module's imports; the re-exports
// below them are the typed API for repo-internal TS callers (import from
// this file, not from lib/stdlib/xml/*).
import { parseXml } from "./xml/grammar.js";
import { xmlAttr, xmlFind, xmlFindAll, xmlText } from "./xml/helpers.js";
import type { XmlDocument, XmlElement, XmlNode } from "./xml/types.js";

// The core never throws; the bridge's throw is the `try` channel that
// stdlib/xml.agency converts into an Agency failure Result.
export function _parseXml(input: string): XmlDocument {
  const r = parseXml(input);
  if (!r.ok) {
    throw new Error(r.error);
  }
  return r.doc;
}

export function _xmlFind(node: XmlNode | null, tag: string): XmlElement | null {
  return xmlFind(node, tag);
}

export function _xmlFindAll(node: XmlNode | null, tag: string): XmlElement[] {
  return xmlFindAll(node, tag);
}

export function _xmlText(node: XmlNode | null): string {
  return xmlText(node);
}

export function _xmlAttr(node: XmlElement | null, name: string): string | null {
  return xmlAttr(node, name);
}

export { parseXml, xmlAttr, xmlFind, xmlFindAll, xmlText };
export type { XmlDocument, XmlElement, XmlNode };
export type { ParseXmlResult, XmlText } from "./xml/types.js";
export { MAX_DEPTH, MAX_INPUT_BYTES, MAX_TREE_ENTRIES } from "./xml/types.js";
