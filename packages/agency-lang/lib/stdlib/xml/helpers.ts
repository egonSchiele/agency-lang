// Tree helpers with pinned semantics: "descendant" excludes the supplied
// node itself; traversal is pre-order, depth-first, left-to-right; helpers
// never trim text and never strip namespace prefixes.
import type { XmlElement, XmlNode } from "./types.js";

/** First descendant element with this tag, or null. */
export function xmlFind(node: XmlNode | null, tag: string): XmlElement | null {
  if (node === null || node.kind !== "element") return null;
  for (const child of node.children) {
    if (child.kind === "element") {
      if (child.tag === tag) return child;
      const found = xmlFind(child, tag);
      if (found !== null) return found;
    }
  }
  return null;
}

/** All descendant elements with this tag, in document order. */
export function xmlFindAll(node: XmlNode | null, tag: string): XmlElement[] {
  const out: XmlElement[] = [];
  if (node === null || node.kind !== "element") return out;
  collectAll(node, tag, out);
  return out;
}

function collectAll(node: XmlElement, tag: string, out: XmlElement[]): void {
  for (const child of node.children) {
    if (child.kind === "element") {
      if (child.tag === tag) out.push(child);
      collectAll(child, tag, out);
    }
  }
}

/**
 * The concatenated text content of the node and all its descendants, in
 * document order (DOM `textContent` semantics). `""` on null.
 */
export function xmlText(node: XmlNode | null): string {
  if (node === null) return "";
  if (node.kind === "text") return node.text;
  let out = "";
  for (const child of node.children) {
    out += xmlText(child);
  }
  return out;
}

/** Attribute value, or null when the attribute (or the node) is missing. */
export function xmlAttr(node: XmlElement | null, name: string): string | null {
  if (node === null) return null;
  return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
}
