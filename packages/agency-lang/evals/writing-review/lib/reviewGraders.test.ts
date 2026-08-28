import { describe, expect, it } from "vitest";
import { editorPoints } from "./testFiles.js";

describe("editorPoints", () => {
  it("takes each top-level bullet as a point", () => {
    expect(editorPoints("- lead with the why\n- no irrelevant context\n")).toEqual([
      "lead with the why",
      "no irrelevant context",
    ]);
  });

  it("keeps prose paragraphs as points alongside bullets", () => {
    const notes = [
      "- lead with the why",
      "",
      "Also removed some awkward lines:",
      '- "so the plugin only ever costs us"',
      "",
      "The overall issue is that it is way too long.",
    ].join("\n");
    expect(editorPoints(notes)).toEqual([
      "lead with the why",
      'Also removed some awkward lines:\n"so the plugin only ever costs us"',
      "The overall issue is that it is way too long.",
    ]);
  });

  it("attaches a bullet's indented continuation lines", () => {
    expect(editorPoints("- first point\n  continues here\n- second")).toEqual([
      "first point\ncontinues here",
      "second",
    ]);
  });

  it("treats notes with no structure as one point", () => {
    expect(editorPoints("Just one paragraph.\n")).toEqual(["Just one paragraph."]);
  });
});
