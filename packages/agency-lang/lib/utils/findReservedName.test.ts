import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { ACCEPTED_SOURCES, REFUSED_SOURCES } from "../parsers/reservedNames.cases.js";
import { findReservedName } from "./findReservedName.js";

const PLACEHOLDER = "zzReserved";

function treeOf(source: string): unknown {
  // Unlowered, which is the shape a `Code` value has.
  const result = parseAgency(source, {}, true, false);
  if (!result.success) {
    throw new Error(result.message);
  }
  return result.result.nodes;
}

/** The parser refuses a reserved name, so the tree is parsed with a legal
 *  placeholder and the reserved spelling is written into it afterwards. This is
 *  what a generator building a `Code` value by hand can do. */
function treeWithReservedNames(source: string): unknown {
  const legal = source.replace(/\b__(\w+)/g, `${PLACEHOLDER}$1`);
  const restore = (_key: string, value: unknown) =>
    typeof value === "string" && value.startsWith(PLACEHOLDER)
      ? `__${value.slice(PLACEHOLDER.length)}`
      : value;
  return JSON.parse(JSON.stringify(treeOf(legal)), restore);
}

describe("findReservedName", () => {
  for (const [what, source] of Object.entries(REFUSED_SOURCES)) {
    it(`finds ${what}`, () => {
      expect(findReservedName(treeWithReservedNames(source))).toMatch(/^__/);
    });
  }

  for (const [what, source] of Object.entries(ACCEPTED_SOURCES)) {
    it(`passes ${what}`, () => {
      expect(findReservedName(treeOf(source))).toBeNull();
    });
  }

  it("passes a destructuring declaration, whose variableName is a placeholder", () => {
    expect(
      findReservedName(treeOf(`node main() {\n  const { a, b } = { a: 1, b: 2 }\n}\n`)),
    ).toBeNull();
  });

  it("checks a field it has never heard of", () => {
    expect(findReservedName([{ type: "someFutureNode", binder: "__ctx" }])).toBe("__ctx");
  });
});
