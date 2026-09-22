import { describe, expect, it } from "vitest";

import {
  clipPainted,
  joinPainted,
  paint,
  paintAnsi,
  paintedLine,
  segment,
  visibleWidth,
} from "../paint.js";
import { parseStyledText } from "../styleParser.js";

const drawn = (content: string) =>
  parseStyledText(content)
    .map((span) => span.text)
    .join("");

describe("paint", () => {
  it("draws the text it was given when that text looks like a style tag", () => {
    expect(drawn(paint("{bold} and {red-fg}"))).toBe("{bold} and {red-fg}");
  });

  it("displays terminal escapes as text without applying their colors", () => {
    expect(parseStyledText(paint("\x1b[31mred\x1b[0m"))).toEqual([{ text: "␛[31mred␛[0m" }]);
    expect(drawn(paint("\x1b[2J\x1b["))).toBe("␛[2J␛[");
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

describe("segment", () => {
  it("is exactly the asked width, short or long, braces or not", () => {
    for (const text of ["ab", "a very long label indeed", "{}{}{}{}{}{}", ""]) {
      expect(visibleWidth(segment(text, 8))).toBe(8);
    }
  });

  it("clips with an ellipsis and keeps the head", () => {
    expect(drawn(segment("abcdefghij", 5))).toBe("abcd…");
  });

  it("right-aligns", () => {
    expect(drawn(segment("42", 5, { align: "right" }))).toBe("   42");
  });

  it("applies the segment style to padding on either side", () => {
    for (const align of ["left", "right"] as const) {
      const output = segment("42", 5, { align, style: { bg: "#3a3a3a", bold: true } });
      expect(drawn(output)).toBe(align === "right" ? "   42" : "42   ");
      for (const span of parseStyledText(output)) {
        expect(span.bg).toBe("#3a3a3a");
        expect(span.bold).toBe(true);
      }
    }
  });

  it("styles padding without overriding individual piece styles", () => {
    const output = segment([{ text: "a", style: { fg: "red" } }, { text: "b" }], 4, {
      align: "right",
      style: { bg: "#3a3a3a" },
    });
    expect(parseStyledText(output)).toEqual([
      { text: "  ", bg: "#3a3a3a" },
      { text: "a", fg: "red" },
      { text: "b" },
    ]);
  });

  it("clips terminal escapes without leaving live ESC bytes in the text", () => {
    for (const content of ["\x1b[31mred", [{ text: "\x1b[31mred" }]]) {
      const output = segment(content, 4);
      expect(drawn(output)).toBe("␛[3…");
      expect(visibleWidth(output)).toBe(4);
    }
  });

  it("replaces line breaks without collapsing ordinary spaces", () => {
    expect(drawn(segment("a\n  b", 6))).toBe("a   b ");
  });

  it("preserves nesting in strings and in separate indentation pieces", () => {
    for (const depth of [0, 1, 2, 3]) {
      const indent = " ".repeat(depth * 2);
      expect(drawn(segment(`  ${indent}child`, 20))).toBe(`  ${indent}child`.padEnd(20));
      expect(drawn(segment([{ text: indent }, { text: "child" }], 20))).toBe(
        `${indent}child`.padEnd(20),
      );
    }
  });

  it("clips across pieces and keeps each piece's color", () => {
    const output = segment(
      [
        { text: "round 4 ", style: { fg: "#00ff00" } },
        { text: "→ grep for a thing", style: { fg: "#ffffff" } },
      ],
      14,
    );
    expect(drawn(output)).toBe("round 4 → gre…");
    const spans = parseStyledText(output);
    expect(spans[0].fg).toBe("#00ff00");
    expect(spans[1].fg).toBe("#ffffff");
  });

  it("marks the cut when a piece ends exactly at the limit and more follows", () => {
    const output = segment([{ text: "abcd" }, { text: "efgh" }], 4);
    expect(drawn(output)).toBe("abc…");
  });

  it("width zero draws nothing", () => {
    expect(segment("abc", 0)).toBe("");
  });
});

describe("clipPainted", () => {
  it("clips highlighted code by what is visible and keeps its colors", () => {
    const code = paintAnsi("\x1b[34mdef\x1b[0m archiveNotes(count) { }");
    const output = clipPainted(code, 10);
    expect(drawn(output)).toBe("def archi…");
    expect(parseStyledText(output)[0].fg).toBe("blue");
  });
});

describe("paintedLine", () => {
  it("is a one-row text element", () => {
    const element = paintedLine(paint("hi"), { width: 10 });
    expect(element).toEqual({ type: "text", content: "hi", style: { height: 1, width: 10 } });
  });
});
