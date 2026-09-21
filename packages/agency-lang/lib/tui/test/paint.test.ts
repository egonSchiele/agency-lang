import { describe, expect, it } from "vitest";

import { joinPainted, paint, paintAnsi, visibleWidth } from "../paint.js";
import { parseStyledText } from "../styleParser.js";

const drawn = (content: string) =>
  parseStyledText(content)
    .map((span) => span.text)
    .join("");

describe("paint", () => {
  it("draws the text it was given when that text looks like a style tag", () => {
    expect(drawn(paint("{bold} and {red-fg}"))).toBe("{bold} and {red-fg}");
  });

  it("keeps a JSON payload intact", () => {
    const json = '{"code":"def f() { return 1 }"}';
    expect(drawn(paint(json, { fg: "#cdd6f4" }))).toBe(json);
  });

  it("applies the style to the text and to nothing after it", () => {
    const spans = parseStyledText(
      joinPainted(paint("a", { fg: "#ff0000", bold: true }), paint("b")),
    );
    expect(spans[0]).toEqual({ text: "a", fg: "#ff0000", bold: true });
    expect(spans[1]).toEqual({ text: "b" });
  });
});

describe("paint boundaries", () => {
  it("preserves trailing backslashes and closes their style", () => {
    for (const count of [1, 2, 3]) {
      const content = `command ${"\\".repeat(count)}`;
      const result = joinPainted(paint(content, { fg: "#ff0000" }), paint("next"));
      expect(drawn(result)).toBe(`${content}next`);
      expect(parseStyledText(result).at(-1)).toEqual({ text: "next" });
      expect(visibleWidth(result)).toBe(content.length + 4);
    }
  });

  it("an unstyled backslash cannot escape the next fragment's opening tag", () => {
    const result = joinPainted(paint("\\"), paint("next", { bold: true }));
    expect(drawn(result)).toBe("\\next");
    expect(parseStyledText(result).at(-1)).toEqual({ text: "next", bold: true });
  });

  it("an ANSI fragment does not color the following plain fragment", () => {
    const result = joinPainted(paintAnsi("\x1b[31mred"), paint("plain"));
    expect(parseStyledText(result).at(-1)).toEqual({ text: "plain" });
  });
});

describe("paintAnsi", () => {
  it("escapes braces and leaves color escapes working", () => {
    const highlighted = "\x1b[34mdef\x1b[0m f() { return 1 }";
    const spans = parseStyledText(paintAnsi(highlighted));
    expect(spans.map((span) => span.text).join("")).toBe("def f() { return 1 }");
    expect(spans[0].fg).toBe("blue");
  });
});

describe("visibleWidth", () => {
  it("ignores tags and counts an escaped brace once", () => {
    expect(visibleWidth(paint("{}", { fg: "#ff0000" }))).toBe(2);
    expect(visibleWidth(paintAnsi("\x1b[34mab\x1b[0m"))).toBe(2);
  });
});
