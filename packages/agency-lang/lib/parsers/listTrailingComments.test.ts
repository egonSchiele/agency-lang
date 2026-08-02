import { describe, expect, it } from "vitest";
import { formatSource } from "@/formatter.js";
import { agencyArrayParser } from "./parsers.js";

describe("list trailing trivia", () => {
  it("distinguishes a trailing comment from a comment before the next item", () => {
    const parsed = agencyArrayParser(`[
      first, // explains first
      // prepares second
      second
    ]`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.result.trivia).toEqual([
      {
        anchorIndex: 0,
        placement: "trailing",
        comments: [{ type: "comment", content: " explains first" }],
      },
      {
        anchorIndex: 1,
        comments: [{ type: "comment", content: " prepares second" }],
      },
    ]);
  });

  // Assert the FOLLOWING item too, not just comment text: these pin parser
  // progress and boundary detection, which a text-only assertion misses.
  it("keeps parsing after a non-final trailing comment", () => {
    const parsed = agencyArrayParser(`[\n  first, // one\n  second,\n  third\n]`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.result.items).toHaveLength(3);
    expect(parsed.result.trivia).toEqual([
      {
        anchorIndex: 0,
        placement: "trailing",
        comments: [{ type: "comment", content: " one" }],
      },
    ]);
  });

  it("keeps a trailing comment and following standalone trivia apart", () => {
    const parsed = agencyArrayParser(
      `[\n  first, // one\n\n  // about second\n  second\n]`,
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.result.items).toHaveLength(2);
    const trailing = (parsed.result.trivia ?? []).filter(
      (entry: any) => entry.placement === "trailing",
    );
    expect(trailing).toHaveLength(1);
    expect(trailing[0].anchorIndex).toBe(0);
    const before = (parsed.result.trivia ?? []).filter(
      (entry: any) => entry.placement !== "trailing",
    );
    expect(before.every((entry: any) => entry.anchorIndex === 1)).toBe(true);
  });

  it("does not attach a comment on the line after the item", () => {
    const parsed = agencyArrayParser(`[\n  first,\n  // about second\n  second\n]`);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.result.items).toHaveLength(2);
    expect(parsed.result.trivia).toEqual([
      {
        anchorIndex: 1,
        comments: [{ type: "comment", content: " about second" }],
      },
    ]);
  });

  // `toContain("// one")` alone would pass even if the comment were moved
  // onto its own line, which is the bug. Assert the whole line.
  it.each([
    ["array", `const value = [\n  1, // one\n  2 // two\n]\n`, ["1, // one", "2 // two"]],
    [
      "object",
      `const value = {\n  one: 1, // one\n  two: 2 // two\n}\n`,
      ["one: 1, // one", "two: 2 // two"],
    ],
    [
      "object type",
      `type Value = {\n  one: number // one\n  two: number // two\n}\n`,
      ["one: number; // one", "two: number // two"],
    ],
  ])("formats trailing comments in a %s", (_name, source, expectedLines) => {
    const once = formatSource(source);
    for (const line of expectedLines) {
      expect(once).toContain(line);
    }
    expect(formatSource(once as string)).toBe(once);
  });
});

describe("object type members with tags", () => {
  it("keeps a trailing comment on a tagged property", () => {
    const source = `type Value = {\n  @validate(min.partial(n: 0))\n  count: number // how many\n  name: string // who\n}\n`;
    const once = formatSource(source);
    expect(once).toContain("@validate(min.partial(n: 0))");
    expect(once).toContain("count: number; // how many");
    expect(once).toContain("name: string // who");
    expect(formatSource(once as string)).toBe(once);
  });
});
