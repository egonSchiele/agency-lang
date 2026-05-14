import { describe, it, expect } from "vitest";
import { parseStyledText, escapeStyleTags } from "../styleParser.js";

describe("parseStyledText", () => {
  it("returns plain text as a single span", () => {
    expect(parseStyledText("hello")).toEqual([{ text: "hello" }]);
  });

  it("parses bold tags", () => {
    expect(parseStyledText("{bold}hi{/bold}")).toEqual([{ text: "hi", bold: true }]);
  });

  it("parses fg color tags", () => {
    expect(parseStyledText("{red-fg}hi{/red-fg}")).toEqual([{ text: "hi", fg: "red" }]);
  });

  it("parses bg color tags", () => {
    expect(parseStyledText("{blue-bg}hi{/blue-bg}")).toEqual([{ text: "hi", bg: "blue" }]);
  });

  it("handles nested tags", () => {
    const result = parseStyledText("{bold}{red-fg}hi{/red-fg}{/bold}");
    expect(result).toEqual([{ text: "hi", bold: true, fg: "red" }]);
  });

  it("handles mixed styled and unstyled text", () => {
    const result = parseStyledText("hello {bold}world{/bold} foo");
    expect(result).toEqual([
      { text: "hello " },
      { text: "world", bold: true },
      { text: " foo" },
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseStyledText("")).toEqual([]);
  });

  it("escaped braces are not parsed as tags", () => {
    const result = parseStyledText(escapeStyleTags("{bold}hello{/bold}"));
    expect(result).toEqual([{ text: "{bold}hello{/bold}" }]);
  });

  it("closing tag matches by type and color", () => {
    const result = parseStyledText("{red-fg}{green-fg}x{/green-fg}y{/red-fg}");
    expect(result).toEqual([
      { text: "x", fg: "green" },
      { text: "y", fg: "red" },
    ]);
  });

  it("unrecognized tags are preserved as literal text", () => {
    const result = parseStyledText("hello {unknown} world");
    expect(result).toEqual([
      { text: "hello " },
      { text: "{unknown}" },
      { text: " world" },
    ]);
  });
});

describe("parseStyledText: ANSI passthrough", () => {
  it("parses a basic ANSI fg color escape", () => {
    expect(parseStyledText("\x1b[31mred\x1b[0m")).toEqual([
      { text: "red", fg: "red" },
    ]);
  });

  it("parses bright fg color codes", () => {
    expect(parseStyledText("\x1b[91mhi\x1b[0m")).toEqual([
      { text: "hi", fg: "bright-red" },
    ]);
  });

  it("parses 24-bit truecolor as a hex string", () => {
    expect(parseStyledText("\x1b[38;2;86;156;214mtok\x1b[0m")).toEqual([
      { text: "tok", fg: "#569cd6" },
    ]);
  });

  it("treats ESC[m and ESC[0m as full reset", () => {
    const result = parseStyledText("\x1b[1m\x1b[31mhi\x1b[mafter");
    expect(result).toEqual([
      { text: "hi", bold: true, fg: "red" },
      { text: "after" },
    ]);
  });

  it("intermixes ANSI and {tag} forms", () => {
    const result = parseStyledText("\x1b[31m{bold}hi{/bold}\x1b[0m");
    expect(result).toEqual([{ text: "hi", bold: true, fg: "red" }]);
  });

  it("ESC[39m pops fg only", () => {
    const result = parseStyledText("\x1b[1m\x1b[31mhi\x1b[39mafter");
    expect(result).toEqual([
      { text: "hi", bold: true, fg: "red" },
      { text: "after", bold: true },
    ]);
  });
});

describe("escapeStyleTags", () => {
  it("escapes curly braces", () => {
    expect(escapeStyleTags("{bold}")).toBe("\\{bold\\}");
  });

  it("leaves text without braces unchanged", () => {
    expect(escapeStyleTags("hello world")).toBe("hello world");
  });
});
