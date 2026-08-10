import { describe, expect, it } from "vitest";
import { runNested, str } from "tarsec";
import { parseXml } from "./grammar.js";
import { MAX_DEPTH, MAX_INPUT_BYTES, MAX_TREE_ENTRIES, type XmlDocument, type XmlElement } from "./types.js";

function doc(input: string): XmlDocument {
  const r = parseXml(input);
  if (!r.ok) throw new Error(`expected parse success, got: ${r.error}`);
  return r.doc;
}

// Shared failure assertion: the stable construct-specific message plus the
// exact line and column, as formatted by the tarsec error machinery.
function expectFail(input: string, messagePart: string, line?: number, col?: number): string {
  const r = parseXml(input);
  if (r.ok) throw new Error(`expected parse failure containing "${messagePart}", got success`);
  expect(r.error).toContain(messagePart);
  if (line !== undefined && col !== undefined) {
    expect(r.error).toContain(`Line ${line}, col ${col}`);
  }
  return r.error;
}

function el(tag: string, attrs: Record<string, string> = {}, children: XmlDocument["root"]["children"] = []): XmlElement {
  return { kind: "element", tag, attrs, children };
}

describe("elements", () => {
  it("parses an empty element pair to exact shape", () => {
    expect(doc("<a></a>")).toEqual({ root: el("a") });
  });

  it("parses both self-closing spellings", () => {
    expect(doc("<r><a/><b /></r>")).toEqual({ root: el("r", {}, [el("a"), el("b")]) });
  });

  it("parses nesting and mixed content", () => {
    expect(doc("<p>hello <b>world</b>!</p>")).toEqual({
      root: el("p", {}, [{ kind: "text", text: "hello " }, el("b", {}, [{ kind: "text", text: "world" }]), { kind: "text", text: "!" }]),
    });
  });

  it("is case-sensitive about tag matching", () => {
    expectFail("<a></A>", "expected </a> to close <a> opened at line 1, col 1", 1, 4);
  });
});

describe("attributes", () => {
  it("parses both quote styles and whitespace around =", () => {
    expect(doc(`<a x="1" y='2' z = "3"/>`)).toEqual({ root: el("a", { x: "1", y: "2", z: "3" }) });
  });

  it("distinguishes empty from missing attributes", () => {
    const root = doc(`<a x=""/>`).root;
    expect(root.attrs.x).toBe("");
    expect("y" in root.attrs).toBe(false);
  });

  it("requires whitespace between adjacent attributes", () => {
    expectFail(`<a x="1"y="2"/>`, "expected whitespace before attribute", 1, 9);
  });

  it("allows whitespace before > and />", () => {
    expect(doc(`<a x="1"   />`)).toEqual({ root: el("a", { x: "1" }) });
    expect(doc(`<a x="1" ></a>`)).toEqual({ root: el("a", { x: "1" }) });
  });

  it("rejects unquoted values", () => {
    expectFail("<a x=1/>", `attribute value for "x" in <a> must be quoted`, 1, 6);
  });

  it("rejects duplicates at the duplicate position", () => {
    expectFail(`<a x="1" x="2"/>`, `duplicate attribute "x" in <a>`, 1, 10);
  });

  it("rejects a literal < in a value", () => {
    expectFail(`<a x="a<b"/>`, "attribute values may not contain a literal `<`", 1, 8);
  });

  it("rejects an unterminated value", () => {
    expectFail(`<a x="oops>`, `unterminated attribute value for "x"`);
  });

  it("decodes references in values, at the right position on failure", () => {
    expect(doc(`<a x="a&amp;b&#65;"/>`).root.attrs.x).toBe("a&bA");
    expectFail(`<a x="ab&#oops;"/>`, "malformed character reference", 1, 9);
  });
});

describe("attribute safety", () => {
  it("treats prototype-named attributes as ordinary data", () => {
    const root = doc(`<a __proto__="p" constructor="c" toString="t"/>`).root;
    expect(root.attrs["__proto__"]).toBe("p");
    expect(root.attrs["constructor"]).toBe("c");
    expect(root.attrs["toString"]).toBe("t");
    expect(Object.getPrototypeOf(root.attrs)).toBe(null);
    expect(({} as Record<string, unknown>).p).toBeUndefined();
    expect(Object.prototype.toString).toBeTypeOf("function");
  });

  it("still rejects duplicate prototype-named attributes", () => {
    expectFail(`<a __proto__="1" __proto__="2"/>`, `duplicate attribute "__proto__"`);
  });
});

describe("prolog, DOCTYPE, comments, PIs", () => {
  it("accepts BOM + declaration + DOCTYPE + comments, none leaking into output", () => {
    const input = `\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- before -->\n<!DOCTYPE root SYSTEM "root.dtd">\n<!-- after -->\n<root/>\n<!-- trailing -->\n`;
    expect(doc(input)).toEqual({ root: el("root") });
  });

  it("accepts a quote-aware DOCTYPE with [ and > inside quotes", () => {
    expect(doc(`<!DOCTYPE r PUBLIC "-//x//[>//EN" 'a[b'><r/>`)).toEqual({ root: el("r") });
  });

  it("rejects a DTD internal subset", () => {
    expectFail(`<!DOCTYPE r [<!ENTITY x "y">]><r/>`, "DTD internal subsets are not supported", 1, 13);
  });

  it("rejects an unterminated DOCTYPE quoted string", () => {
    expectFail(`<!DOCTYPE r "oops><r/>`, "unterminated quoted string in DOCTYPE");
  });

  it("keeps <?xml-stylesheet?> a processing instruction", () => {
    expect(doc(`<?xml version="1.0"?><?xml-stylesheet href="s.css"?><r/>`)).toEqual({ root: el("r") });
  });

  it("comments and PIs inside content produce no nodes", () => {
    expect(doc("<r><!-- c --><?pi data?></r>")).toEqual({ root: el("r") });
  });

  it("rejects -- inside a comment", () => {
    expectFail("<r><!-- a--b --></r>", "`--` is not allowed inside a comment", 1, 10);
  });

  it("rejects a misplaced declaration", () => {
    expectFail("<r/><?xml version='1.0'?>", "XML declaration may appear only once, at the very beginning");
    expectFail("<r><?xml version='1.0'?></r>", "XML declaration may appear only once, at the very beginning");
  });

  it("rejects a duplicate DOCTYPE and a DOCTYPE after the root", () => {
    expectFail("<!DOCTYPE a><!DOCTYPE b><r/>", "at most one DOCTYPE declaration is allowed", 1, 13);
    expectFail("<r/><!DOCTYPE a>", "a DOCTYPE must appear before the root element", 1, 5);
    expectFail("<r><!DOCTYPE a></r>", "a DOCTYPE must appear before the root element", 1, 4);
  });

  it("rejects a BOM anywhere but the very beginning", () => {
    expectFail("\uFEFF\uFEFF<r/>", "expected an element", 1, 2);
  });
});

describe("document structure", () => {
  it("rejects empty input", () => {
    expectFail("", "the document is empty");
  });

  it("rejects whitespace-only input", () => {
    expectFail("   \n  ", "the document is empty");
  });

  it("rejects two root elements", () => {
    expectFail("<a/><b/>", "a document may have only one root element", 1, 5);
  });

  it("rejects non-whitespace text outside the root", () => {
    expectFail("hello <a/>", "expected an element", 1, 1);
    expectFail("<a/> trailing", "content after the root element is not allowed", 1, 6);
  });

  it("accepts XML whitespace around the root", () => {
    expect(doc("\n  <a/>\n\t")).toEqual({ root: el("a") });
  });

  it("rejects CDATA outside the root", () => {
    expectFail("<![CDATA[x]]><a/>", "CDATA sections are only allowed inside an element", 1, 1);
    expectFail("<a/><![CDATA[x]]>", "CDATA sections are only allowed inside an element", 1, 5);
  });

  it("rejects an unclosed element at EOF with the opener position", () => {
    expectFail("<a><b>text", "unclosed <b> (opened at line 1, col 4)", 1, 11);
  });

  it("reports mismatched close tags with both positions", () => {
    const err = expectFail("<root>\n  <entry>text</wrong>\n</root>", "expected </entry> to close <entry> opened at line 2, col 3", 2, 14);
    expect(err).toContain("</wrong>");
  });

  it("rejects malformed names", () => {
    expectFail("<1a/>", "expected an element", 1, 1);
    expectFail("<a><2/></a>", "expected a tag name after `<`", 1, 5);
    expectFail("<élément/>", "expected an element");
    expectFail("<aéb/>", "expected an attribute name");
  });

  it("accepts the full name grammar and rejects bad starts", () => {
    expect(doc("<_a.b-c:d9/>")).toEqual({ root: el("_a.b-c:d9") });
    expectFail("<.a/>", "expected an element");
    expectFail("<-a/>", "expected an element");
  });
});

describe("namespaces are literal", () => {
  it("keeps prefixed tags and xmlns attributes exactly", () => {
    const input = `<media:thumbnail xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://d" media:url="u"/>`;
    expect(doc(input)).toEqual({
      root: el("media:thumbnail", {
        "xmlns:media": "http://search.yahoo.com/mrss/",
        xmlns: "http://d",
        "media:url": "u",
      }),
    });
  });
});

describe("text handling", () => {
  it("decodes references in text", () => {
    expect(doc("<a>fish &amp; chips &#x2014; cheap</a>").root.children).toEqual([
      { kind: "text", text: "fish & chips — cheap" },
    ]);
  });

  it("recovers bare ampersands in text", () => {
    expect(doc("<a>tom & jerry &co</a>").root.children).toEqual([{ kind: "text", text: "tom & jerry &co" }]);
  });

  it("rejects an undefined named entity with position", () => {
    expectFail("<a>x &nbsp; y</a>", "unsupported entity &nbsp;", 1, 6);
  });

  it("keeps CDATA verbatim, including markup-like content, undecoded", () => {
    expect(doc("<a><![CDATA[<b>&amp;&#65;</b>]]></a>").root.children).toEqual([
      { kind: "text", text: "<b>&amp;&#65;</b>" },
    ]);
  });

  it("rejects ]]> in ordinary text", () => {
    expectFail("<a>x ]]> y</a>", "`]]>` is not allowed in ordinary text", 1, 6);
  });

  it("retains whitespace-only text nodes", () => {
    expect(doc("<p><b>Hello</b> <i>world</i></p>").root.children).toEqual([
      el("b", {}, [{ kind: "text", text: "Hello" }]),
      { kind: "text", text: " " },
      el("i", {}, [{ kind: "text", text: "world" }]),
    ]);
  });

  it("coalesces text, references, and CDATA into one node", () => {
    expect(doc("<p>a&amp;b<![CDATA[c]]>d&#101;</p>").root.children).toEqual([{ kind: "text", text: "a&bcde" }]);
  });

  it("coalesces across a skipped comment and PI", () => {
    expect(doc("<p>a<!-- c -->b<?pi x?>c</p>").root.children).toEqual([{ kind: "text", text: "abc" }]);
  });

  it("drops an empty CDATA section", () => {
    expect(doc("<p><![CDATA[]]></p>").root.children).toEqual([]);
  });
});

describe("newline normalization", () => {
  it("normalizes CRLF and lone CR in text, attributes, and CDATA", () => {
    expect(doc("<a>x\r\ny\rz</a>").root.children).toEqual([{ kind: "text", text: "x\ny\nz" }]);
    expect(doc(`<a b="x\r\ny\rz"/>`).root.attrs.b).toBe("x\ny\nz");
    expect(doc("<a><![CDATA[x\r\ny\rz]]></a>").root.children).toEqual([{ kind: "text", text: "x\ny\nz" }]);
  });

  it("keeps a numeric &#xD; as CR because decoding follows normalization", () => {
    expect(doc("<a>x&#xD;y</a>").root.children).toEqual([{ kind: "text", text: "x\ry" }]);
  });

  it("reports positions in normalized coordinates after CRLF and lone CR", () => {
    expectFail("<r>\r\n  <a>x&#oops;</a>\r\n</r>", "malformed character reference", 2, 7);
    expectFail("<r>\r  <a></b></r>", "expected </a> to close <a> opened at line 2, col 3", 2, 6);
  });

  it("positions errors after a recoverable ampersand correctly", () => {
    expectFail("<a>x & y &#bad;</a>", "malformed character reference", 1, 10);
  });
});

describe("forbidden raw characters", () => {
  it("rejects NUL and controls in text with position", () => {
    expectFail("<a>x\u0000y</a>", "U+0000", 1, 5);
    expectFail("<a>x\u0008y</a>", "U+0008", 1, 5);
  });

  it("rejects unpaired surrogates in text and CDATA", () => {
    expectFail("<a>x\uD800y</a>", "unpaired surrogate");
    expectFail("<a><![CDATA[x\uDC00y]]></a>", "unpaired surrogate");
  });

  it("rejects controls in CDATA", () => {
    expectFail("<a><![CDATA[x\u0000y]]></a>", "U+0000");
  });
});

describe("unterminated constructs", () => {
  it("fails cleanly on each", () => {
    expectFail("<?xml version='1.0'", "unterminated XML declaration");
    expectFail("<r><?pi data", "unterminated processing instruction");
    expectFail("<!-- never ends", "unterminated comment");
    expectFail("<r><![CDATA[ never ends", "unterminated CDATA section");
    expectFail("<!DOCTYPE r never ends", "unterminated DOCTYPE");
    expectFail("<r x='never", "unterminated attribute value");
    expectFail("<r", "unclosed <r> tag");
  });
});

describe("limits", () => {
  it("depth: exactly MAX_DEPTH parses, MAX_DEPTH+1 fails", () => {
    const ok = "<a>".repeat(MAX_DEPTH) + "</a>".repeat(MAX_DEPTH);
    expect(parseXml(ok).ok).toBe(true);
    const over = "<a>".repeat(MAX_DEPTH + 1) + "</a>".repeat(MAX_DEPTH + 1);
    const r = parseXml(over);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`depth limit of ${MAX_DEPTH}`);
  });

  it("depth restores across siblings: many wide siblings stay at depth 2", () => {
    const wide = "<r>" + "<a/>".repeat(MAX_DEPTH * 2) + "</r>";
    expect(parseXml(wide).ok).toBe(true);
  });

  it("a valid parse succeeds after a depth failure (no cross-call state)", () => {
    parseXml("<a>".repeat(MAX_DEPTH + 1));
    expect(parseXml("<a/>").ok).toBe(true);
  });

  it("input bytes: at the cap parses, one byte over fails before parsing starts", () => {
    const pad = MAX_INPUT_BYTES - "<a></a>".length;
    const atCap = "<a>" + "x".repeat(pad) + "</a>";
    expect(parseXml(atCap).ok).toBe(true);
    const overMalformed = "<a>" + "x".repeat(pad) + "</a>x"; // over cap AND malformed
    const r = parseXml(overMalformed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`maximum is ${MAX_INPUT_BYTES}`);
  });

  it("input cap counts UTF-8 bytes, not JS string length", () => {
    // Each é is 1 JS char but 2 UTF-8 bytes.
    const n = Math.ceil((MAX_INPUT_BYTES - 7) / 2) + 4;
    const r = parseXml("<a>" + "é".repeat(n) + "</a>");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("UTF-8");
  });

  it("tree entries: attribute-dominated construction fails over the cap", () => {
    // Root element = 1 entry, then MAX_TREE_ENTRIES attributes exceeds it.
    const count = MAX_TREE_ENTRIES;
    const parts = ["<r"];
    for (let i = 0; i < count; i++) parts.push(` a${i}="x"`);
    parts.push("/>");
    const input = parts.join("");
    expect(Buffer.byteLength(input, "utf8")).toBeLessThan(MAX_INPUT_BYTES);
    const r = parseXml(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(`tree entry limit of ${MAX_TREE_ENTRIES}`);
  });

  it("tree entries: element-dominated construction fails over the cap", () => {
    const count = MAX_TREE_ENTRIES + 1;
    const input = "<r>" + "<a/>".repeat(count) + "</r>";
    expect(Buffer.byteLength(input, "utf8")).toBeLessThan(MAX_INPUT_BYTES);
    const r = parseXml(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("tree entry limit");
  });

  it("tree entries: exactly at the cap succeeds", () => {
    // 1 root + (cap - 1) children = exactly MAX_TREE_ENTRIES entries.
    const input = "<r>" + "<a/>".repeat(MAX_TREE_ENTRIES - 1) + "</r>";
    expect(parseXml(input).ok).toBe(true);
  });

  it("text coalescing does not reserve extra entries", () => {
    // 1 root + 1 text node built from many coalesced contributions; with a
    // budget of 2 remaining this only passes if merging is free.
    const contributions = "<r>" + "a<!-- c -->".repeat(50) + "</r>";
    const d = doc(contributions);
    expect(d.root.children).toEqual([{ kind: "text", text: "a".repeat(50) }]);
  });

  it("a valid parse succeeds after a budget failure", () => {
    parseXml("<r>" + "<a/>".repeat(MAX_TREE_ENTRIES + 1) + "</r>");
    expect(parseXml("<a/>").ok).toBe(true);
  });
});

describe("hostile inputs return failures, never throw", () => {
  it("long unterminated constructs fail fast", () => {
    expectFail("<!--" + "x".repeat(500_000), "unterminated comment");
    expectFail("<r><![CDATA[" + "x".repeat(500_000), "unterminated CDATA");
    expectFail(`<r x="` + "x".repeat(500_000), "unterminated attribute value");
    expectFail("<!DOCTYPE " + "x".repeat(500_000), "unterminated DOCTYPE");
    expectFail("<?" + "x".repeat(500_000), "unterminated processing instruction");
    expectFail("<r>&#" + "9".repeat(500_000), "malformed character reference");
  });

  it("deep unterminated nesting hits the depth cap cleanly", () => {
    const r = parseXml("<a>".repeat(300_000));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("depth limit");
  });

  it("an enormous terminated numeric reference fails cleanly", () => {
    expectFail(`<r>&#${"9".repeat(100_000)};</r>`, "is not a legal XML character");
  });

  it("a long run of bare ampersands parses", () => {
    const d = doc("<r>" + "& ".repeat(10_000) + "</r>");
    expect(d.root.children[0]).toEqual({ kind: "text", text: "& ".repeat(10_000) });
  });

  it("every prefix of a representative document returns without throwing", () => {
    const full = `\uFEFF<?xml version="1.0"?><!DOCTYPE r SYSTEM "r.dtd"><!-- c --><r a="v&amp;1" b='2'><child>text &#65; more</child><![CDATA[raw <>&]]><?pi data?><empty/></r>`;
    for (let i = 0; i <= full.length; i++) {
      const r = parseXml(full.slice(0, i));
      expect(typeof r.ok).toBe("boolean");
    }
    expect(parseXml(full).ok).toBe(true);
  });
});

describe("nested tarsec state", () => {
  it("an outer tarsec parse continues correctly after parseXml runs inside it", () => {
    const outer = (input: string) => {
      const pre = str("BEGIN ")(input);
      if (!pre.success) return pre;
      const inner = parseXml("<x>oops");
      expect(inner.ok).toBe(false);
      if (!inner.ok) expect(inner.error).toContain("unclosed <x>");
      const good = parseXml("<x>fine</x>");
      expect(good.ok).toBe(true);
      return str("END")(pre.rest);
    };
    const result = runNested(outer, "BEGIN END");
    expect(result.success).toBe(true);
    const failing = runNested((input: string) => str("NOPE")(input), "BEGIN");
    expect(failing.success).toBe(false);
  });
});
