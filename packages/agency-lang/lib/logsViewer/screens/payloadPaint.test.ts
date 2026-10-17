import { expect, it } from "vitest";
import { parseStyledText } from "../../tui/styleParser.js";
import { visibleWidth } from "../../tui/paint.js";
import { paintPayload } from "./payloadPaint.js";
it("wraps text and JSON, wraps code and preserves literal controls and braces", () => {
  const lines = paintPayload(
    [
      { kind: "text", text: "hello {bold}\u001b[2J\tworld", indent: 2, role: "plain" },
      { kind: "json", text: '{"a":"a long value"}' },
      { kind: "code", text: "def f(): number {\n  return 1\n}", language: "agency" },
    ],
    20,
  );
  const text = lines
    .map((line) =>
      parseStyledText(line)
        .map((part) => part.text)
        .join(""),
    )
    .join("\n");
  expect(text).toContain("{bold}");
  expect(text).toContain("\\u001b");
  expect(text).toContain("\\t");
  expect(text).toContain("def f(): number {");
  expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
});

it("wraps highlighted code without losing content or structured indentation", () => {
  const code = 'const answer = "abcdefghijklmnopqrstuvwxyz"';
  const lines = paintPayload([{ kind: "code", text: code, language: "javascript", indent: 2 }], 14);
  const plain = lines.map((line) =>
    parseStyledText(line)
      .map((span) => span.text)
      .join(""),
  );
  expect(plain.length).toBeGreaterThan(1);
  expect(plain.every((line) => line.startsWith("  ") && line.length <= 14)).toBe(true);
  expect(plain.map((line) => line.slice(2)).join("")).toBe(code);
});

function plainLines(lines: ReturnType<typeof paintPayload>): string[] {
  return lines.map((line) =>
    parseStyledText(line)
      .map((span) => span.text)
      .join(""),
  );
}

it("paints a pair as key and value on one line, the key in its own color", () => {
  const lines = paintPayload([{ kind: "pair", key: "status", text: "completed", indent: 2 }], 40);
  expect(plainLines(lines)).toEqual(["  status: completed"]);
  const spans = parseStyledText(lines[0]);
  expect(spans[0].text).toBe("  status:");
  expect(spans[0].fg).not.toBe(spans[1].fg);
});

it("wraps a long pair value under the key's indent", () => {
  const lines = paintPayload(
    [{ kind: "pair", key: "text", text: "Gather announcement facts and dates", indent: 2 }],
    20,
  );
  const plain = plainLines(lines);
  expect(plain.length).toBeGreaterThan(1);
  expect(plain[0].startsWith("  text: ")).toBe(true);
  expect(plain.every((line) => line.startsWith("  ") && line.length <= 20)).toBe(true);
  expect(plain.map((line) => line.slice(2)).join(" ")).toBe(
    "text: Gather announcement facts and dates",
  );
});

const todos = {
  kind: "table" as const,
  indent: 2,
  columns: ["id", "status", "text"],
  rows: [
    ["1", "completed", "Gather facts"],
    ["2", "pending", "Write it up"],
  ],
};

it("draws a table with a header when the rows fit", () => {
  expect(plainLines(paintPayload([todos], 60))).toEqual([
    "  id  status     text",
    "  1   completed  Gather facts",
    "  2   pending    Write it up",
  ]);
});

it("falls back to indexed pairs when the table is too wide", () => {
  expect(plainLines(paintPayload([todos], 24))).toEqual([
    "  [0]",
    "    id: 1",
    "    status: completed",
    "    text: Gather facts",
    "  [1]",
    "    id: 2",
    "    status: pending",
    "    text: Write it up",
  ]);
});

it("paints a faded line in one muted color with the same text", () => {
  const [bright] = paintPayload([{ kind: "pair", key: "id", text: "1", indent: 2 }], 40);
  const [faded] = paintPayload(
    [{ kind: "pair", key: "id", text: "1", indent: 2, faded: true }],
    40,
  );
  expect(plainLines([faded])).toEqual(plainLines([bright]));
  const spans = parseStyledText(faded);
  expect(spans).toHaveLength(1);
  expect(spans[0].fg).not.toBe(parseStyledText(bright)[0].fg);
});
