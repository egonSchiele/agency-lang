import { describe, it, expect } from "vitest";
import { formatDiff, computeHunks, renderDiff, renderPatch } from "./diff.js";
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

describe("renderDiff options", () => {
  const OLD = "a\nb\nc\nd\ne\nf\ng";
  const NEW = "a\nb\nc\nD\ne\nf\ng";

  it("limits context and emits separate hunks", () => {
    const hunks = computeHunks(OLD, NEW, 1, false);
    const result = renderDiff(hunks, {});
    // 1 line of context each side of the change to line 4 ("c","D"/"d","e")
    expect(strip(result)).toBe("  c\n- d\n+ D\n  e");
  });

  it("renders per-side line numbers (old on delete, new elsewhere)", () => {
    const hunks = computeHunks("one\ntwo\nthree", "one\nTWO\nthree", -1, false);
    const result = renderDiff(hunks, { lineNumbers: true });
    expect(strip(result)).toBe("1   one\n2 - two\n2 + TWO\n3   three");
  });

  it("emits hunk headers", () => {
    const hunks = computeHunks("one\ntwo\nthree", "one\nTWO\nthree", 1, false);
    const result = renderDiff(hunks, { hunkHeaders: true });
    expect(strip(result)).toContain("@@ -1,3 +1,3 @@");
  });

  it("renders labels", () => {
    const hunks = computeHunks("x", "y", -1, false);
    const result = renderDiff(hunks, { oldLabel: "a.txt", newLabel: "b.txt" });
    expect(strip(result)).toContain("--- a.txt");
    expect(strip(result)).toContain("+++ b.txt");
  });

  it("renders a summary line", () => {
    const hunks = computeHunks("one\ntwo", "one\nTWO\nthree", -1, false);
    const result = renderDiff(hunks, { summary: true });
    expect(strip(result).split("\n")[0]).toBe("2 insertions, 1 deletion");
  });

  it("ignores whitespace-only changes when asked", () => {
    const hunks = computeHunks("a   b", "a b", -1, true);
    // normalized equal -> single context line, no -/+ markers
    const result = renderDiff(hunks, {});
    expect(strip(result)).not.toContain("- ");
    expect(strip(result)).not.toContain("+ ");
  });
});

describe("renderPatch", () => {
  it("produces an applicable unified-diff body for a modification", () => {
    const hunks = computeHunks("one\ntwo\nthree\n", "one\nTWO\nthree\n", 3, false);
    const patch = renderPatch(hunks, "a/f.txt", "b/f.txt");
    expect(patch.startsWith("--- a/f.txt\n+++ b/f.txt\n")).toBe(true);
    expect(patch).toContain("@@ -1");
    expect(patch).toContain("\n one");
    expect(patch).toContain("\n-two");
    expect(patch).toContain("\n+TWO");
    expect(patch.endsWith("\n")).toBe(true);
    // No ANSI, no two-space display prefixes.
    expect(patch).not.toContain("\x1b");
  });

  it("uses /dev/null for new and deleted files", () => {
    const created = renderPatch(computeHunks("", "hello\nworld", 3, false), "/dev/null", "b/new.txt");
    expect(created).toContain("--- /dev/null");
    expect(created).toContain("@@ -0,0 +1");
    expect(created).toContain("+hello");

    const deleted = renderPatch(computeHunks("bye\n", "", 3, false), "a/old.txt", "/dev/null");
    expect(deleted).toContain("+++ /dev/null");
    expect(deleted).toContain("-bye");
  });

  it("supports renames via differing labels", () => {
    const patch = renderPatch(computeHunks("x\n", "y\n", 3, false), "a/old.txt", "b/new.txt");
    expect(patch).toContain("--- a/old.txt");
    expect(patch).toContain("+++ b/new.txt");
  });
});
