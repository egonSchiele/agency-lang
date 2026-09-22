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
