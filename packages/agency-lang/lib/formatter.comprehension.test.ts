import { describe, it, expect } from "vitest";
import { formatSource } from "./formatter.js";

describe("agency fmt preserves comprehensions", () => {
  // [source, expected-after-fmt]. Expected differs only where the
  // formatter's house style normalizes spacing (object patterns print
  // as `{ name, age }`).
  const cases: [string, string][] = [
    ["[f(x) for x in xs]", "[f(x) for x in xs]"],
    ["[f(x) for x in xs if p(x)]", "[f(x) for x in xs if p(x)]"],
    ["[f(x, i) for x, i in xs]", "[f(x, i) for x, i in xs]"],
    [
      "[name for {name, age} in people]",
      "[name for { name, age } in people]",
    ],
    ["fork [f(x) for x in xs]", "fork [f(x) for x in xs]"],
    ["fork [f(x) for x in xs if p(x)]", "fork [f(x) for x in xs if p(x)]"],
  ];

  for (const [expr, expected] of cases) {
    it(`round-trips ${expr}`, () => {
      const out = formatSource(`node main() {\n  const r = ${expr}\n}`);
      expect(out).not.toBeNull();
      expect(out).toContain(expected);
      // the whole point: fmt must NOT print the desugared form
      expect(out).not.toContain("map(");
      expect(out).not.toContain("_pairsOf(");
    });
  }
});
