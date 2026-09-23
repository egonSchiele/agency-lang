import { describe, expect, it } from "vitest";
import { paint, visibleWidth } from "../../tui/paint.js";
import { parseStyledText } from "../../tui/styleParser.js";
import { numberedBlocks } from "./lineNumbers.js";
import { paintPayload } from "./payloadPaint.js";

const plain = (line: string) =>
  parseStyledText(line)
    .map((span) => span.text)
    .join("");

describe("line numbers", () => {
  it("numbers continuously across blocks, including blank lines", () => {
    const blocks = numberedBlocks(40, () => [
      { id: "first", lines: [paint("hello"), paint("")] },
      { id: "second", lines: [paint("world")] },
    ]);
    expect(blocks.map((block) => block.id)).toEqual(["first", "second"]);
    expect(blocks.flatMap((block) => block.lines).map(plain)).toEqual([
      " 1 hello",
      " 2 ",
      " 3 world",
    ]);
  });
  it("grows the gutter and rewraps without clipping long content", () => {
    const content = "x".repeat(1800);
    const blocks = numberedBlocks(12, (width) => [
      { lines: paintPayload([{ kind: "text", text: content, indent: 0, role: "plain" }], width) },
    ]);
    const lines = blocks[0].lines;
    expect(lines.length).toBeGreaterThan(100);
    expect(lines.every((line) => visibleWidth(line) <= 12)).toBe(true);
    expect(
      lines
        .map(plain)
        .map((line) => line.replace(/^\s*\d+ /, ""))
        .join(""),
    ).toBe(content);
    expect(plain(lines[99])).toMatch(/^100 /);
  });
});
