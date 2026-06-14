import { describe, it, expect } from "vitest";
import { formatDiff } from "./diff.js";
import { color } from "./termcolors.js";

// Strip ANSI escape codes so assertions can check rendered content
// independent of where color wraps begin and end.
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("formatDiff", () => {
  it("returns all dim text for identical strings", () => {
    const result = formatDiff("hello", "hello");
    expect(strip(result)).toBe("  hello");
    expect(result).not.toContain("- ");
    expect(result).not.toContain("+ ");
  });

  it("shows deletions in red and insertions in green", () => {
    const result = formatDiff("alice", "bob");
    expect(strip(result)).toBe("- alice\n+ bob");
    // alice is painted red, bob green
    expect(result).toContain(color.red("alice"));
    expect(result).toContain(color.green("bob"));
  });

  it("shows unchanged parts of a replaced line as dim, highlighting only the change", () => {
    const result = formatDiff("hello world", "hello there");
    // The common prefix stays dim on both lines...
    expect(result).toContain(color.dim("hello "));
    // ...while the changed words are highlighted.
    expect(result).toContain(color.red("world"));
    expect(result).toContain(color.green("there"));
    // And the line is never split across multiple output lines.
    expect(strip(result)).toBe("- hello world\n+ hello there");
  });

  it("does not split a single line into multiple lines", () => {
    // The motivating bug: "What is the capital of France?" -> "...India?"
    const result = formatDiff(
      "What is the capital of France?",
      "What is the capital of India?",
    );
    expect(strip(result)).toBe(
      "- What is the capital of France?\n+ What is the capital of India?",
    );
    expect(result).toContain(color.red("France"));
    expect(result).toContain(color.green("India"));
  });

  it("handles multiline diffs", () => {
    const expected = "line1\nline2\nline3";
    const actual = "line1\nchanged\nline3";
    const result = formatDiff(expected, actual);
    expect(strip(result)).toBe("  line1\n- line2\n+ changed\n  line3");
  });

  it("handles empty expected string", () => {
    const result = formatDiff("", "new content");
    expect(result).toBe(color.green("+ new content"));
    expect(result).not.toContain("- ");
  });

  it("handles empty actual string", () => {
    const result = formatDiff("old content", "");
    expect(result).toBe(color.red("- old content"));
    expect(result).not.toContain("+ ");
  });

  it("handles both strings empty", () => {
    const result = formatDiff("", "");
    expect(result).toBe("");
  });

  it("emits plain text without ANSI codes when colorize is off", () => {
    const result = formatDiff("line1\nline2\nline3", "line1\nchanged\nline3", { colorize: false });
    expect(result).not.toContain("\x1b");
    expect(result).toBe("  line1\n- line2\n+ changed\n  line3");
  });

  it("does not split lines in plain-text replacement mode", () => {
    const result = formatDiff(
      "What is the capital of France?",
      "What is the capital of India?",
      { colorize: false },
    );
    expect(result).toBe(
      "- What is the capital of France?\n+ What is the capital of India?",
    );
  });

  it("colorizes by default", () => {
    expect(formatDiff("alice", "bob")).toContain(color.red("alice"));
  });

  it("works with JSON-like fixture output", () => {
    const expected = JSON.stringify({ name: "Alice", age: 30 }, null, 2);
    const actual = JSON.stringify({ name: "Bob", age: 30 }, null, 2);
    const result = formatDiff(expected, actual);
    expect(result).toContain(color.red("Alice"));
    expect(result).toContain(color.green("Bob"));
    // age line is unchanged and shown dim with a 2-space prefix
    expect(strip(result)).toContain('  "age": 30');
  });
});
