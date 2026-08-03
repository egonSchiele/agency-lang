import { describe, expect, it } from "vitest";

import { stripAnsi, visualWidth, wrapText } from "./ansi.js";

const ESC = "\x1b";
const BEL = "\x07";
/** An OSC 8 hyperlink: opener carrying the URL, the visible label, then the
 *  closer. Terminal-rendered Markdown produces these for every link. */
function link(url: string, label: string): string {
  return `${ESC}]8;;${url}${BEL}${label}${ESC}]8;;${BEL}`;
}

const LONG_URL = "https://www.example.com/a/very/long/path/that/goes/on?utm_source=somewhere";

describe("visualWidth", () => {
  it("counts only the visible label of a hyperlink, not its URL", () => {
    expect(visualWidth(link(LONG_URL, "site"))).toBe(4);
  });

  it("still ignores SGR colour codes", () => {
    expect(visualWidth(`${ESC}[1mbold${ESC}[0m`)).toBe(4);
  });

  it("handles a link terminated with ST instead of BEL", () => {
    const withSt = `${ESC}]8;;${LONG_URL}${ESC}\\label${ESC}]8;;${ESC}\\`;
    expect(visualWidth(withSt)).toBe(5);
  });

  it("counts plain text unchanged", () => {
    expect(visualWidth("plain text")).toBe(10);
  });
});

describe("stripAnsi", () => {
  it("removes the hyperlink wrapper and keeps the label", () => {
    expect(stripAnsi(link(LONG_URL, "site"))).toBe("site");
  });

  it("keeps text either side of a link", () => {
    expect(stripAnsi(`see ${link(LONG_URL, "site")} for more`)).toBe("see site for more");
  });
});

describe("wrapText with hyperlinks", () => {
  it("does not treat a link's URL as content that must be wrapped", () => {
    // Before OSC awareness this wrapped into many lines of URL fragments,
    // because the URL counted toward the column budget.
    const lines = wrapText(`see ${link(LONG_URL, "site")} now`, 20);
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0])).toBe("see site now");
  });

  it("keeps every wrapped line within the column budget", () => {
    const source = `alpha ${link(LONG_URL, "beta")} gamma delta epsilon zeta eta theta`;
    for (const wrapped of wrapText(source, 12)) {
      expect(visualWidth(wrapped)).toBeLessThanOrEqual(12);
    }
  });

  it("loses no visible words around a link", () => {
    const source = `alpha ${link(LONG_URL, "beta")} gamma delta epsilon`;
    const joined = wrapText(source, 10).map(stripAnsi).join(" ");
    for (const word of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
      expect(joined).toContain(word);
    }
  });

  it("does not let a link swallow the text after it", () => {
    const source = `(${link(LONG_URL, "site")}) and more words here`;
    const joined = wrapText(source, 40).map(stripAnsi).join(" ");
    expect(joined).toContain("and more words here");
    expect(joined).toContain("site");
  });

  it("still hard-breaks a genuinely long visible token", () => {
    const lines = wrapText("x".repeat(50), 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const wrapped of lines) {
      expect(visualWidth(wrapped)).toBeLessThanOrEqual(10);
    }
  });
});

describe("hyperlink state across wrap boundaries", () => {
  it("closes an open link at the end of a wrapped segment", () => {
    // A long label forces the link to span more than one line. Leaving the
    // link open would make the rest of the row, and the next pane, clickable.
    const label = "a clickable label long enough to wrap across two lines";
    const wrapped = wrapText(link(LONG_URL, label), 20);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped[0].endsWith(`${ESC}]8;;${BEL}`)).toBe(true);
  });

  it("reopens the link on the following segment", () => {
    const label = "a clickable label long enough to wrap across two lines";
    const wrapped = wrapText(link(LONG_URL, label), 20);
    expect(wrapped[1].startsWith(`${ESC}]8;;${LONG_URL}${BEL}`)).toBe(true);
  });

  it("does not reopen a link after its closer", () => {
    const wrapped = wrapText(`${link(LONG_URL, "site")} then plenty more words here to wrap`, 12);
    expect(wrapped[wrapped.length - 1]).not.toContain(LONG_URL);
  });

  it("still loses no visible text", () => {
    const label = "a clickable label long enough to wrap";
    const joined = wrapText(link(LONG_URL, label), 15).map(stripAnsi).join(" ");
    for (const word of label.split(" ")) {
      expect(joined).toContain(word);
    }
  });
});
