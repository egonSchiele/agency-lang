import { describe, expect, it } from "vitest";
import { formatSource } from "@/formatter.js";
import { parseAgency } from "@/parser.js";
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

describe("call and declaration list comments", () => {
  it.each([
    ["positional", `save(\n  first, // first\n  second // second\n)`],
    ["named", `save(\n  value: first, // first\n  retries: 3 // second\n)`],
    ["splat", `save(\n  ...values, // first\n  final // second\n)`],
    ["method", `client.save(\n  first, // first\n  second // second\n)`],
    ["call chain", `handlers[0](\n  first, // first\n  second // second\n)`],
    ["interrupt", `interrupt io::read(\n  first, // first\n  second // second\n)`],
    ["raise", `raise io::failure(\n  first, // first\n  second // second\n)`],
    ["guard", `guard(\n  cost: $1, // first\n  time: 5m // second\n) {\n    print(1)\n  }`],
  ])("preserves %s argument comments", (_name, call) => {
    const source = `node main() {\n  ${call}\n}\n`;
    const once = formatSource(source);
    expect(once).not.toBeNull();
    expect(once).toContain("// first");
    expect(once).toContain("// second");
    expect(parseAgency(once as string, {}, false, false).success).toBe(true);
    expect(formatSource(once as string)).toBe(once);
  });

  it.each([
    [
      "function",
      `def save(\n  value: string, // value\n  ...rest: string[] // rest\n) {\n}\n`,
      ["value: string, // value", "...rest: string[] // rest"],
    ],
    [
      "node",
      `node save(\n  value: string!, // value\n  retries: number = 3 // retries\n) {\n}\n`,
      ["value: string!, // value", "retries: number = 3 // retries"],
    ],
  ])("preserves %s parameter comments", (_name, source, expectedLines) => {
    const once = formatSource(source);
    expect(once).not.toBeNull();
    for (const line of expectedLines) {
      expect(once).toContain(line);
    }
    expect(parseAgency(once as string, {}, false, false).success).toBe(true);
    expect(formatSource(once as string)).toBe(once);
  });
});

describe("inline block canonicalization keeps comments with their argument", () => {
  it.each([
    ["first", `map(\n  \\n -> n * n, // block\n  items // ordinary\n)`],
    ["last", `map(\n  items, // ordinary\n  \\n -> n * n // block\n)`],
    [
      "middle",
      `reduce(\n  items, // ordinary\n  \\n -> n * n, // block\n  0 // seed\n)`,
    ],
  ])("keeps both comments when the block starts %s", (_name, call) => {
    const source = `node main() {\n  const r = ${call}\n}\n`;
    const once = formatSource(source);
    expect(once).not.toBeNull();
    expect(once).toContain("// block");
    expect(once).toContain("// ordinary");
    // The block itself must survive canonicalization, not just its comment.
    expect(once).toContain("\\n -> n * n");
    expect(parseAgency(once as string, {}, false, false).success).toBe(true);
    expect(formatSource(once as string)).toBe(once);
  });
});

// A nested list parser consumes the layout after its own closer, so the next
// line's standalone comment is already sitting where a trailing comment would
// be. These pin the boundary from both sides.
describe("line boundaries around nested members", () => {
  it("leaves a comment on the line AFTER a nested object type standalone", () => {
    const source = `type Value = {\n  nested: {\n    x: number\n  }\n  // describes next\n  next: string\n}\n`;
    const once = formatSource(source);
    expect(once).toContain("nested: { x: number };\n  // describes next");
    expect(formatSource(once as string)).toBe(once);
  });

  it("still attaches a comment ON the nested closing brace's line", () => {
    const source = `type Value = {\n  nested: {\n    x: number\n  } // about nested\n  next: string\n}\n`;
    const once = formatSource(source);
    expect(once).toContain("nested: { x: number }; // about nested");
    expect(formatSource(once as string)).toBe(once);
  });

  it("does not attach across a leading-comma line break", () => {
    const source = `node main() {\n  const xs = [\n    first\n    , // comment\n    second\n  ]\n}\n`;
    const once = formatSource(source);
    expect(once).toContain("first,\n    // comment");
    expect(formatSource(once as string)).toBe(once);
  });

  it("attaches after a multiline item, whose own newlines do not count", () => {
    const source = `node main() {\n  const xs = [\n    [\n      1,\n      2\n    ], // outer\n    third\n  ]\n}\n`;
    const once = formatSource(source);
    expect(once).toContain("], // outer");
    expect(formatSource(once as string)).toBe(once);
  });
});
