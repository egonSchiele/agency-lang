import { describe, it, expect } from "vitest";
import { buildLineIndex, locFromOffsets } from "./util.js";

describe("locFromOffsets line index", () => {
  // The indexed path is a performance optimization (O(log n) per lookup vs an
  // O(offset) rescan). It must produce byte-identical results to the scan, or
  // it silently corrupts every finding's line/col on large files.
  it("the indexed path matches the linear scan at every offset", () => {
    const source = [
      `import { map } from "std::index"`,
      ``,
      `export def first(): number {`,
      `  return 1`,
      `}`,
      `export def second(): number {`,
      `  return 2`,
      `}`,
      ``,
    ].join("\n");
    const lineIndex = buildLineIndex(source);
    for (let offset = 0; offset <= source.length; offset++) {
      expect(locFromOffsets(source, offset, offset + 1, lineIndex)).toEqual(
        locFromOffsets(source, offset, offset + 1),
      );
    }
  });

  it("matches the scan for a source with no newlines", () => {
    const source = `export def only(): number { return 1 }`;
    const lineIndex = buildLineIndex(source);
    for (let offset = 0; offset <= source.length; offset++) {
      expect(locFromOffsets(source, offset, offset, lineIndex)).toEqual(
        locFromOffsets(source, offset, offset),
      );
    }
  });

  it("agrees on an offset sitting exactly on a newline (it belongs to the next line)", () => {
    const source = `a\nb\nc`;
    const newlineOffset = source.indexOf("\n"); // offset 1
    const lineIndex = buildLineIndex(source);
    expect(locFromOffsets(source, newlineOffset, newlineOffset, lineIndex)).toEqual(
      locFromOffsets(source, newlineOffset, newlineOffset),
    );
  });
});
