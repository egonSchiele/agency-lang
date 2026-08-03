import { describe, expect, it } from "vitest";

import { parseStyledText } from "./styleParser.js";

const ESC = "\x1b";
const BEL = "\x07";

/** An OSC 8 hyperlink: opener carrying the URL, the visible label, the closer. */
function link(url: string, label: string): string {
  return `${ESC}]8;;${url}${BEL}${label}${ESC}]8;;${BEL}`;
}

function visibleText(input: string): string {
  return parseStyledText(input).map((span) => span.text).join("");
}

describe("OSC sequences in styled text", () => {
  it("keeps a hyperlink's label and drops its URL", () => {
    expect(visibleText(link("https://example.com/a/long/path", "site"))).toBe("site");
  });

  it("keeps the surrounding prose intact", () => {
    expect(visibleText(`see ${link("https://example.com", "site")} now`)).toBe("see site now");
  });

  it("handles a link terminated with ST rather than BEL", () => {
    const withSt = `${ESC}]8;;https://example.com${ESC}\\label${ESC}]8;;${ESC}\\`;
    expect(visibleText(withSt)).toBe("label");
  });

  it("drops a non-8 OSC sequence too, such as a clipboard write", () => {
    expect(visibleText(`before${ESC}]52;c;cGF5bG9hZA==${BEL}after`)).toBe("beforeafter");
  });

  it("still applies SGR styling around a link", () => {
    const spans = parseStyledText(`${ESC}[1mbold ${link("https://example.com", "site")}${ESC}[0m`);
    expect(spans.map((span) => span.text).join("")).toBe("bold site");
    expect(spans.some((span) => span.bold === true)).toBe(true);
  });

  it("leaves text with no escapes unchanged", () => {
    expect(visibleText("just words")).toBe("just words");
  });
});
