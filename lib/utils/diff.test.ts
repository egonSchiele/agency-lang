import { describe, it, expect } from "vitest";
import { formatDiff } from "./diff.js";
import { color } from "./termcolors.js";

describe("formatDiff", () => {
  it("returns all dim text for identical strings", () => {
    const result = formatDiff("hello", "hello");
    expect(result).toContain("hello");
    expect(result).not.toContain("- ");
    expect(result).not.toContain("+ ");
  });

  it("shows deletions in red and insertions in green", () => {
    const result = formatDiff("alice", "bob");
    expect(result).toContain(color.red("- alice"));
    expect(result).toContain(color.green("+ bob"));
  });

  it("shows unchanged parts as dim", () => {
    const result = formatDiff("hello world", "hello there");
    expect(result).toContain(color.dim("  hello "));
  });

  it("handles multiline diffs", () => {
    const expected = "line1\nline2\nline3";
    const actual = "line1\nchanged\nline3";
    const result = formatDiff(expected, actual);
    expect(result).toContain(color.red("- line2"));
    expect(result).toContain(color.green("+ changed"));
  });

  it("handles empty expected string", () => {
    const result = formatDiff("", "new content");
    expect(result).toContain(color.green("+ new content"));
    expect(result).not.toContain("- ");
  });

  it("handles empty actual string", () => {
    const result = formatDiff("old content", "");
    expect(result).toContain(color.red("- old content"));
    expect(result).not.toContain("+ ");
  });

  it("handles both strings empty", () => {
    const result = formatDiff("", "");
    expect(result).toBe("");
  });

  it("works with JSON-like fixture output", () => {
    const expected = JSON.stringify({ name: "Alice", age: 30 }, null, 2);
    const actual = JSON.stringify({ name: "Bob", age: 30 }, null, 2);
    const result = formatDiff(expected, actual);
    expect(result).toContain(color.red("- Alice"));
    expect(result).toContain(color.green("+ Bob"));
    // age is unchanged
    expect(result).toContain("30");
  });
});
