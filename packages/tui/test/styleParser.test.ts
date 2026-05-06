import { describe, it, expect } from "vitest";
import { parseStyledText, escapeStyleTags } from "../lib/styleParser.js";

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
});

describe("escapeStyleTags", () => {
  it("escapes curly braces", () => {
    expect(escapeStyleTags("{bold}")).toBe("\\{bold\\}");
  });

  it("leaves text without braces unchanged", () => {
    expect(escapeStyleTags("hello world")).toBe("hello world");
  });
});
