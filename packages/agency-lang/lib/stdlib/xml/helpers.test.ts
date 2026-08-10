import { describe, expect, it } from "vitest";
import { parseXml } from "./grammar.js";
import { xmlAttr, xmlFind, xmlFindAll, xmlText } from "./helpers.js";
import { MAX_DEPTH, type XmlDocument, type XmlElement } from "./types.js";

function root(input: string): XmlElement {
  const r = parseXml(input);
  if (!r.ok) throw new Error(`fixture parse failed: ${r.error}`);
  return r.doc.root;
}

// An order-revealing tree: pre-order depth-first finds deep-left before
// shallow-right, where breadth-first would find shallow-right first.
const ORDER = root(`<r><a><hit n="deep-left"/></a><hit n="shallow-right"/><b><hit n="last"/></b></r>`);

describe("xmlFind", () => {
  it("returns the first match in pre-order, not breadth-first order", () => {
    expect(xmlAttr(xmlFind(ORDER, "hit"), "n")).toBe("deep-left");
  });

  it("excludes the supplied node itself", () => {
    const r = root("<hit><hit n='inner'/></hit>");
    expect(xmlAttr(xmlFind(r, "hit"), "n")).toBe("inner");
    const leaf = root("<hit/>");
    expect(xmlFind(leaf, "hit")).toBe(null);
  });

  it("returns null on null, no match, and text-node input", () => {
    expect(xmlFind(null, "x")).toBe(null);
    expect(xmlFind(root("<a><b/></a>"), "c")).toBe(null);
    expect(xmlFind({ kind: "text", text: "hi" }, "x")).toBe(null);
  });
});

describe("xmlFindAll", () => {
  it("returns all matches in document order", () => {
    const names = xmlFindAll(ORDER, "hit").map((e) => xmlAttr(e, "n"));
    expect(names).toEqual(["deep-left", "shallow-right", "last"]);
  });

  it("returns [] on null, no match, and text-node input", () => {
    expect(xmlFindAll(null, "x")).toEqual([]);
    expect(xmlFindAll(root("<a/>"), "x")).toEqual([]);
    expect(xmlFindAll({ kind: "text", text: "hi" }, "x")).toEqual([]);
  });

  it("excludes the supplied node itself", () => {
    const r = root("<hit><hit n='1'/><hit n='2'/></hit>");
    expect(xmlFindAll(r, "hit").length).toBe(2);
  });
});

describe("xmlText", () => {
  it("concatenates all descendant text in document order", () => {
    expect(xmlText(root("<p>a<b>b<i>c</i></b>d</p>"))).toBe("abcd");
  });

  it("preserves significant mixed-content whitespace", () => {
    expect(xmlText(root("<p><b>Hello</b> <i>world</i></p>"))).toBe("Hello world");
  });

  it("does not trim", () => {
    expect(xmlText(root("<a>  padded  </a>"))).toBe("  padded  ");
  });

  it("returns the node's own text for a text node, and empty string for null", () => {
    expect(xmlText({ kind: "text", text: " raw " })).toBe(" raw ");
    expect(xmlText(null)).toBe("");
    expect(xmlText(root("<a/>"))).toBe("");
  });

  it("chains with xmlFind without a null check", () => {
    expect(xmlText(xmlFind(root("<feed><title>Hi</title></feed>"), "title"))).toBe("Hi");
    expect(xmlText(xmlFind(root("<feed/>"), "missing"))).toBe("");
  });
});

describe("xmlAttr", () => {
  it("distinguishes present-but-empty from missing", () => {
    const r = root(`<a x=""/>`);
    expect(xmlAttr(r, "x")).toBe("");
    expect(xmlAttr(r, "y")).toBe(null);
  });

  it("returns null on a null node", () => {
    expect(xmlAttr(null, "x")).toBe(null);
  });

  it("does not strip namespace prefixes", () => {
    const r = root(`<a media:url="u"/>`);
    expect(xmlAttr(r, "media:url")).toBe("u");
    expect(xmlAttr(r, "url")).toBe(null);
  });
});

describe("deep trees", () => {
  it("traverses a maximum-depth parsed tree safely", () => {
    const input = "<a>".repeat(MAX_DEPTH - 1) + "<leaf hit='yes'>x</leaf>" + "</a>".repeat(MAX_DEPTH - 1);
    const r = parseXml(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d: XmlDocument = r.doc;
      expect(xmlAttr(xmlFind(d.root, "leaf"), "hit")).toBe("yes");
      expect(xmlText(d.root)).toBe("x");
      expect(xmlFindAll(d.root, "a").length).toBe(MAX_DEPTH - 2);
    }
  });
});
