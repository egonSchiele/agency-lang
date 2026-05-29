import { describe, it, expect } from "vitest";
import { codeFence, escapeTableCell, markdownTable } from "./markdown.js";

describe("codeFence", () => {
  it("uses a 3-backtick fence by default", () => {
    expect(codeFence("hello", "ts")).toBe("```ts\nhello\n```");
  });

  it("escalates to 4 backticks when content contains triple backticks", () => {
    expect(codeFence("see ```js\nfoo\n```", "md")).toBe(
      "````md\nsee ```js\nfoo\n```\n````",
    );
  });

  it("escalates to 5 backticks when content contains quadruple backticks", () => {
    expect(codeFence("a ```` b", "md")).toBe("`````md\na ```` b\n`````");
  });

  it("trims trailing whitespace from the code", () => {
    expect(codeFence("hello\n\n", "ts")).toBe("```ts\nhello\n```");
  });
});

describe("escapeTableCell", () => {
  it("escapes pipe characters", () => {
    expect(escapeTableCell("a | b")).toBe("a \\| b");
  });

  it("replaces newlines with spaces", () => {
    expect(escapeTableCell("line1\nline2")).toBe("line1 line2");
    expect(escapeTableCell("line1\r\nline2")).toBe("line1 line2");
  });

  it("handles both pipes and newlines", () => {
    expect(escapeTableCell("a | b\nc")).toBe("a \\| b c");
  });

  it("returns plain strings unchanged", () => {
    expect(escapeTableCell("hello")).toBe("hello");
  });
});

describe("markdownTable", () => {
  it("generates a simple table", () => {
    const result = markdownTable(
      ["Name", "Type"],
      [["foo", "string"], ["bar", "number"]],
    );
    expect(result).toBe(
      "| Name | Type |\n" +
      "|---|---|\n" +
      "| foo | string |\n" +
      "| bar | number |",
    );
  });

  it("escapes pipe characters in cell values", () => {
    const result = markdownTable(
      ["Value"],
      [["a | b"]],
    );
    expect(result).toContain("| a \\| b |");
  });

  it("escapes newlines in cell values", () => {
    const result = markdownTable(
      ["Value"],
      [["line1\nline2"]],
    );
    expect(result).toContain("| line1 line2 |");
  });

  it("handles empty rows", () => {
    const result = markdownTable(["A", "B"], []);
    expect(result).toBe(
      "| A | B |\n" +
      "|---|---|",
    );
  });
});
