import { describe, expect, it } from "vitest";
import { decodeReferences, isXmlChar } from "./entities.js";

function decoded(run: string): string {
  const r = decodeReferences(run, 0);
  if (!r.ok) throw new Error(`expected decode success, got: ${r.message}`);
  return r.text;
}

function failed(run: string, baseOffset = 0): { message: string; offset: number } {
  const r = decodeReferences(run, baseOffset);
  if (r.ok) throw new Error(`expected decode failure, got success: ${JSON.stringify(r.text)}`);
  return r;
}

describe("predefined entities", () => {
  it("decodes all five, exact case", () => {
    expect(decoded("&amp;&lt;&gt;&quot;&apos;")).toBe(`&<>"'`);
  });

  it("decodes them embedded in text", () => {
    expect(decoded("a &amp; b &lt;tag&gt;")).toBe("a & b <tag>");
  });
});

describe("numeric references", () => {
  it("decodes decimal", () => {
    expect(decoded("&#65;&#101;")).toBe("Ae");
  });

  it("decodes lowercase-x hex with both digit cases", () => {
    expect(decoded("&#x41;&#x6a;&#x6A;")).toBe("Ajj");
  });

  it("accepts leading zeroes", () => {
    expect(decoded("&#065;&#x0041;")).toBe("AA");
  });

  it("decodes an astral code point to a surrogate pair", () => {
    expect(decoded("&#x1F600;")).toBe("\u{1F600}");
  });
});

describe("one-pass decoding", () => {
  it("never rescans output: &amp;lt; is the four characters &lt;", () => {
    expect(decoded("&amp;lt;")).toBe("&lt;");
  });
});

describe("literal-ampersand recovery (rule 4)", () => {
  it("bare & at end of run", () => {
    expect(decoded("a&")).toBe("a&");
  });

  it("& followed by space", () => {
    expect(decoded("fish & chips")).toBe("fish & chips");
  });

  it("&foo without semicolon", () => {
    expect(decoded("&foo")).toBe("&foo");
  });

  it("&amp without semicolon", () => {
    expect(decoded("&amp")).toBe("&amp");
  });

  it("&; stays literal", () => {
    expect(decoded("&;")).toBe("&;");
  });

  it("a long run of bare ampersands", () => {
    expect(decoded("&".repeat(50))).toBe("&".repeat(50));
  });
});

describe("unsupported named entities (rule 3)", () => {
  it("&nbsp; fails naming the entity", () => {
    const r = failed("&nbsp;");
    expect(r.message).toContain("unsupported entity &nbsp;");
    expect(r.offset).toBe(0);
  });

  it("&AMP; is not the predefined &amp;", () => {
    expect(failed("&AMP;").message).toContain("unsupported entity &AMP;");
  });

  it("&foo:bar; fails naming the full entity", () => {
    expect(failed("&foo:bar;").message).toContain("unsupported entity &foo:bar;");
  });
});

describe("malformed numeric references (rule 2)", () => {
  for (const bad of ["&#;", "&#x;", "&#oops;", "&#12", "&#x12", "&#xG;"]) {
    it(`${bad} fails at the ampersand`, () => {
      const r = failed(`ab${bad}`);
      expect(r.message).toContain("malformed character reference");
      expect(r.offset).toBe(2);
    });
  }
});

describe("illegal character values", () => {
  for (const bad of ["&#x0;", "&#x8;", "&#xB;", "&#xC;", "&#xE;", "&#x1F;", "&#xD800;", "&#xDFFF;", "&#xFFFE;", "&#xFFFF;", "&#x110000;"]) {
    it(`${bad} is rejected`, () => {
      const r = failed(bad);
      expect(r.message).toContain("is not a legal XML character");
      expect(r.offset).toBe(0);
    });
  }

  it("an enormous terminated numeric reference fails cleanly", () => {
    const r = failed(`&#${"9".repeat(5000)};`);
    expect(r.message).toContain("is not a legal XML character");
  });

  for (const good of ["&#x9;", "&#xA;", "&#xD;", "&#x20;", "&#xD7FF;", "&#xE000;", "&#xFFFD;", "&#x10000;", "&#x10FFFF;"]) {
    it(`boundary value ${good} is accepted`, () => {
      expect(decodeReferences(good, 0).ok).toBe(true);
    });
  }
});

describe("raw character validation", () => {
  it("rejects a forbidden control character", () => {
    const r = failed("ab\bcd");
    expect(r.message).toContain("U+0008");
    expect(r.offset).toBe(2);
  });

  it("accepts tab and newline", () => {
    expect(decoded("a\tb\nc")).toBe("a\tb\nc");
  });

  it("rejects an unpaired lead surrogate", () => {
    expect(failed("ab\uD800cd").message).toContain("unpaired surrogate");
  });

  it("rejects an unpaired trail surrogate", () => {
    expect(failed("ab\uDC00cd").message).toContain("unpaired surrogate");
  });

  it("accepts a proper surrogate pair", () => {
    expect(decoded("a\u{1F600}b")).toBe("a\u{1F600}b");
  });
});

describe("failure offsets", () => {
  it("advances past preceding text to the reference itself", () => {
    const r = failed("hello &#oops; world", 100);
    expect(r.offset).toBe(106);
  });
});

describe("isXmlChar", () => {
  it("matches the spec ranges at their edges", () => {
    expect(isXmlChar(0x8)).toBe(false);
    expect(isXmlChar(0x9)).toBe(true);
    expect(isXmlChar(0x1f)).toBe(false);
    expect(isXmlChar(0x20)).toBe(true);
    expect(isXmlChar(0xd7ff)).toBe(true);
    expect(isXmlChar(0xd800)).toBe(false);
    expect(isXmlChar(0xdfff)).toBe(false);
    expect(isXmlChar(0xe000)).toBe(true);
    expect(isXmlChar(0xfffd)).toBe(true);
    expect(isXmlChar(0xfffe)).toBe(false);
    expect(isXmlChar(0x10000)).toBe(true);
    expect(isXmlChar(0x10ffff)).toBe(true);
    expect(isXmlChar(0x110000)).toBe(false);
  });
});
