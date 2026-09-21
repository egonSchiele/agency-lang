import { expect, it } from "vitest";
import { parseStyledText } from "../../tui/styleParser.js";
import { visibleWidth } from "../../tui/paint.js";
import { paintPayload } from "./payloadPaint.js";
it("wraps text and JSON, clips code and preserves literal controls and braces", () => {
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
