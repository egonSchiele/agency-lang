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

describe("remaining multiline surfaces", () => {
  it.each([
    [
      "named import",
      `import {\n  alpha, // alpha\n  beta // beta\n} from "./tools"\n`,
      ["alpha, // alpha", "beta // beta"],
    ],
    [
      "node import",
      `import node {\n  first, // first\n  second // second\n} from "./nodes.agency"\n`,
      ["first, // first", "second // second"],
    ],
    [
      "named export",
      `export {\n  alpha, // alpha\n  beta // beta\n} from "./tools"\n`,
      ["alpha, // alpha", "beta // beta"],
    ],
    [
      "array binding pattern",
      `node main() {\n  const [\n    first, // first\n    second // second\n  ] = values\n}\n`,
      ["first, // first", "second // second"],
    ],
    [
      "object binding pattern",
      `node main() {\n  const {\n    name, // name\n    age // age\n  } = user\n}\n`,
      ["name, // name", "age // age"],
    ],
    [
      "match array pattern",
      `node main() {\n  match (value) {\n    [\n      "ok", // tag\n      result // payload\n    ] => result\n  }\n}\n`,
      [`"ok", // tag`, "result // payload"],
    ],
    [
      "thread arguments",
      `node main() {\n  thread(\n    label: "work", // label\n    hidden: true // visibility\n  ) {\n    print(1)\n  }\n}\n`,
      [`label: "work", // label`, "hidden: true // visibility"],
    ],
    [
      "parallel arguments",
      `node main() {\n  parallel(\n    shared: true // state mode\n  ) {\n    print(1)\n  }\n}\n`,
      ["shared: true // state mode"],
    ],
  ])("preserves %s comments", (_name, source, expectedLines) => {
    const once = formatSource(source);
    expect(once).not.toBeNull();
    for (const line of expectedLines) {
      expect(once).toContain(line);
    }
    expect(parseAgency(once as string, {}, false, false).success).toBe(true);
    expect(formatSource(once as string)).toBe(once);
  });

  it("moves a thread comment with its argument when the order is canonicalized", () => {
    // Written hidden-first; the formatter prints label first. Each comment
    // must travel with the argument it described, not stay at its index.
    const source = `node main() {\n  thread(\n    hidden: true, // about hidden\n    label: "work" // about label\n  ) {\n    print(1)\n  }\n}\n`;
    const once = formatSource(source);
    expect(once).toContain(`label: "work", // about label`);
    expect(once).toContain("hidden: true // about hidden");
    expect(parseAgency(once as string, {}, false, false).success).toBe(true);
    expect(formatSource(once as string)).toBe(once);
  });

  // A mixed import renders through a different path than a sole named
  // import, so it needs its own coverage — it silently dropped the comment
  // until the second path learned about trivia.
  it.each([
    [
      "default plus named",
      `import tools, {\n  alpha // keep\n} from "./tools"\n`,
      `import tools, {\n  alpha // keep\n} from "./tools"\n`,
    ],
    [
      "namespace plus named",
      `import * as t, {\n  alpha // keep\n} from "./tools"\n`,
      `import * as t, {\n  alpha // keep\n} from "./tools"\n`,
    ],
  ])("keeps a comment in a %s import", (_name, source, expected) => {
    const once = formatSource(source);
    expect(once).toBe(expected);
    expect(parseAgency(once as string, {}, false, false).success).toBe(true);
    expect(formatSource(once as string)).toBe(once);
  });

  it("keeps inner and trailing import comments with the right import when sorting", () => {
    // Written zeta-first; the formatter sorts alpha first. Both the name
    // comment inside each list and the comment after each `from` clause must
    // travel with their own import.
    const source =
      `import {\n  zeta // the zeta name\n} from "./zeta" // trailing zeta\nimport {\n  alpha // the alpha name\n} from "./alpha" // trailing alpha\n`;
    const formatted = formatSource(source);
    expect(formatted).not.toBeNull();
    const once = formatted as string;
    expect(once.indexOf("alpha // the alpha name")).toBeLessThan(
      once.indexOf("zeta // the zeta name"),
    );
    expect(once).toContain("alpha // the alpha name");
    expect(once).toContain(`from "./alpha" // trailing alpha`);
    expect(once).toContain("zeta // the zeta name");
    expect(once).toContain(`from "./zeta" // trailing zeta`);
    expect(formatSource(once)).toBe(once);
  });
});

// Each `reject` policy needs its own negative test, or migrating a site to the
// shared parser could silently start accepting a trailing comma.
describe("trailing commas stay rejected where they always were", () => {
  it.each([
    ["node import", `import node { first, second, } from "./nodes.agency"\n`],
    ["array binding pattern", `node main() {\n  const [first, second, ] = values\n}\n`],
    ["object binding pattern", `node main() {\n  const { name, age, } = user\n}\n`],
  ])("rejects a trailing comma in a %s", (_name, source) => {
    expect(parseAgency(source, {}, false, false).success).toBe(false);
  });

  it.each([
    ["named import", `import { alpha, beta, } from "./tools"\n`],
    ["named export", `export { alpha, beta, } from "./tools"\n`],
    ["call arguments", `node main() {\n  save(first, second, )\n}\n`],
  ])("still accepts a trailing comma in a %s", (_name, source) => {
    expect(parseAgency(source, {}, false, false).success).toBe(true);
  });
});
