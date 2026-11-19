import { expect, test } from "vitest";
import { MAX_DIFF_INPUT_CHARS, MAX_DIFF_LINE_CHARS, editDiff } from "./editDiff.js";

function lineTexts(hunks: ReturnType<typeof editDiff>): string[] {
  return hunks.flatMap((hunk) =>
    hunk.lines.map((line) => `${line.kind} ${line.tokens.map((token) => token.text).join("")}`),
  );
}

test("a replaced line is a delete and an insert, with context and line numbers", () => {
  const hunks = editDiff("a\nb\nc\n", "a\nB\nc\n");

  expect(hunks).toHaveLength(1);
  // Agency's diff counts the empty text after the last newline as a line,
  // as `agency agent` shows it.
  expect(lineTexts(hunks)).toEqual(["context a", "delete b", "insert B", "context c", "context "]);
  const deleted = hunks[0]?.lines[1];
  expect(deleted).toMatchObject({ kind: "delete", oldNumber: 2, newNumber: null });
  expect(deleted?.tokens).toEqual([{ text: "b", scope: null, changed: true }]);
});

// An approval must show every change. Spacing changes what code does in
// Python and YAML, and inside strings.
test("a whitespace-only change has hunks", () => {
  expect(lineTexts(editDiff("  x\n", "    x\n"))).toEqual([
    "delete   x",
    "insert     x",
    "context ",
  ]);
});

/** Lines no edit touches, so a change sits more than 3 lines from any other. */
const UNCHANGED = "a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\n";

test("a dedent far from any other change shows", () => {
  const loop = (saveLine: string): string =>
    `for user in users:\n    check(user)\n${saveLine}\n${UNCHANGED}`;

  const texts = lineTexts(editDiff(loop("    save(user)"), loop("save(user)")));

  expect(texts).toContain("delete     save(user)");
  expect(texts).toContain("insert save(user)");
});

test("spaces changed inside a line show", () => {
  const opener = (name: string): string => `${UNCHANGED}open("${name}")\n${UNCHANGED}`;

  const texts = lineTexts(editDiff(opener("annual  report.txt"), opener("annual report.txt")));

  expect(texts).toContain('delete open("annual  report.txt")');
  expect(texts).toContain('insert open("annual report.txt")');
});

test("an edit that won't apply (empty before and after) has no hunks", () => {
  expect(editDiff("", "")).toEqual([]);
});

test("a payload that isn't two texts has no hunks", () => {
  expect(editDiff(null, "x")).toEqual([]);
  expect(editDiff("x", undefined)).toEqual([]);
});

test("Windows line endings don't show as an escaped character on every line", () => {
  const hunks = editDiff("a\r\nb\r\n", "a\r\nB\r\n");

  expect(lineTexts(hunks)).toEqual(["context a", "delete b", "insert B", "context "]);
});

// The diff runs on the engine's thread, and its word diff has no time
// limit on long lines, so a big edit gets no diff and the approval shows
// its raw details instead.
test("texts too long to diff on the engine's thread have no hunks", () => {
  const half = "x\n".repeat(MAX_DIFF_INPUT_CHARS / 4 + 1);

  expect(editDiff(half, `${half}y\n${half}`)).toEqual([]);
});

test("a huge one-line file is refused before any diffing, so it returns fast", () => {
  const line = "x".repeat(1_000_000);
  const started = performance.now();

  expect(editDiff(line, `y${line.slice(1)}`)).toEqual([]);
  expect(performance.now() - started).toBeLessThan(50);
});

test("a line too long to diff word by word means no hunks", () => {
  const long = "x".repeat(MAX_DIFF_LINE_CHARS + 1);

  expect(editDiff(`${long}\n`, `${long}y\n`)).toEqual([]);
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function tokenTexts(hunks: ReturnType<typeof editDiff>): string[] {
  return hunks.flatMap((hunk) =>
    hunk.lines.flatMap((line) => line.tokens.map((token) => token.text)),
  );
}

// Agency's word diff works on UTF-16 units and can cut an emoji in two. A
// token holding half an emoji can't be decoded by the app, which would
// then show neither the diff nor the edits the card left out for it.
test("an emoji swap keeps every token a whole character", () => {
  const hunks = editDiff('x = "😀"\n', 'x = "😃"\n');

  expect(hunks).not.toEqual([]);
  expect(tokenTexts(hunks).filter((text) => LONE_SURROGATE.test(text))).toEqual([]);
  expect(lineTexts(hunks)).toEqual(['delete x = "😀"', 'insert x = "😃"', "context "]);
});

// Agency's diff throws past 65,535 distinct lines; the engine must get no
// hunks, not an exception.
test("a diff Agency can't compute has no hunks", () => {
  const side = (base: number): string =>
    Array.from({ length: 33_000 }, (_, index) =>
      String.fromCharCode(base + (index % 20_000), base + Math.floor(index / 20_000)),
    ).join("\n");

  expect(editDiff(side(0x4e00), side(0x6000))).toEqual([]);
});

// Each replaced line gets a word diff, so the total length of changed lines
// is what costs time, not one line's length.
test("many long changed lines are refused before any diffing, so it returns fast", () => {
  const paragraph = (index: number, word: string): string =>
    `${index} ${word} `.repeat(1_500 / (word.length + 3));
  const before = Array.from({ length: 20 }, (_, index) => paragraph(index, "alpha")).join("\n");
  const after = Array.from({ length: 20 }, (_, index) => paragraph(index, "beta")).join("\n");
  const started = performance.now();

  expect(editDiff(before, after)).toEqual([]);
  expect(performance.now() - started).toBeLessThan(50);
});

test("a few changed lines in a big file still get their diff", () => {
  const lines = Array.from({ length: 2_000 }, (_, index) => `const value${index} = ${index};`);
  const after = lines.map((line, index) => (index % 100 === 0 ? `${line} // checked` : line));

  expect(editDiff(lines.join("\n"), after.join("\n")).length).toBe(20);
});

// Line counts live in a plain object, so a line whose text is an
// Object.prototype key must not read an inherited function and turn the
// budget into NaN.
test("a line named like an Object.prototype key doesn't turn the budget off", () => {
  const paragraph = (index: number, word: string): string =>
    `${index} ${word} `.repeat(1_500 / (word.length + 3));
  const lines = (word: string): string[] =>
    Array.from({ length: 20 }, (_, index) => paragraph(index, word));
  const before = ["constructor", "toString", ...lines("alpha")].join("\n");
  const after = ["constructor", "toString", ...lines("beta")].join("\n");

  expect(editDiff(before, after)).toEqual([]);
});
