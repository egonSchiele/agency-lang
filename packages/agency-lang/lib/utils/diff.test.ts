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

  it("anchors an insert-only hunk header to the preceding line (context 0)", () => {
    // Insert X after line "a"; with context 0 the hunk has no old line of its
    // own, so oldStart must come from the preceding line, not default to 0.
    const patch = renderPatch(computeHunks("a\nb\nc", "a\nX\nb\nc", 0, false), "a/f", "b/f");
    expect(patch).toContain("@@ -1,0 +2,1 @@");
  });

  it("anchors a delete-only hunk header to the preceding line (context 0)", () => {
    const patch = renderPatch(computeHunks("a\nb\nc", "a\nc", 0, false), "a/f", "b/f");
    expect(patch).toContain("@@ -2,1 +1,0 @@");
  });
});

describe("computeHunks limits", () => {
  it("throws when inputs exceed the unique-line limit", () => {
    const lines: string[] = [];
    for (let i = 0; i < 65537; i++) lines.push("line" + i);
    const big = lines.join("\n");
    expect(() => computeHunks(big, "", 3, false)).toThrow(/unique lines/);
  });
});

describe("renderDiff highlighted path", () => {
  // Stub body renderer: marks kind/width/code so we can assert what renderDiff
  // passed, without depending on a real highlighter.
  const stub = (code: string, kind: string, width: number) => `<${kind}:${width}:${code}>`;

  it("uses renderBody per line with the block width and a colored gutter", () => {
    const hunks = computeHunks("aa\nbb\ncc", "aa\nBB\ncc", -1, false);
    const result = renderDiff(hunks, { colored: true, renderBody: stub, lineNumbers: true });
    const lines = strip(result).split("\n");
    // width is the widest line ("aa"/"bb"/... = 2)
    expect(lines).toEqual([
      "1   <context:2:aa>",
      "2 - <delete:2:bb>",
      "2 + <insert:2:BB>",
      "3   <context:2:cc>",
    ]);
    // changed-line gutters are colored red / green
    expect(result).toContain(color.red("2 - "));
    expect(result).toContain(color.green("2 + "));
  });

  it("falls back to inline when not colored, even if renderBody is set", () => {
    const hunks = computeHunks("a", "b", -1, false);
    const withBody = renderDiff(hunks, { colored: false, renderBody: stub });
    const plain = renderDiff(hunks, { colored: false });
    expect(withBody).toBe(plain);
    expect(withBody).not.toContain("<delete");
  });

  it("uses the inline path when renderBody is absent", () => {
    const hunks = computeHunks("a", "b", -1, false);
    expect(renderDiff(hunks, { colored: true })).toBe(
      `${color.red("- ")}${color.red("a")}\n${color.green("+ ")}${color.green("b")}`,
    );
  });
});
