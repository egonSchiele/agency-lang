import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

/** The chain-newline boundary: an index or slice element must not
 *  continue an expression across a line break. Expression parsers eat
 *  trailing newlines, so before the boundary existed, a match arm whose
 *  pattern was a SINGLE-element array parsed as an index on the previous
 *  arm's value — `failure("a")[sub]` — and the whole match failed with
 *  the generic "expected match cases" error. Multi-element patterns were
 *  immune only because `expr["a", "b"]` is not valid index syntax.
 *
 *  Tests go through `parseAgency`, the real entry point, because the
 *  boundary reads the parse-wide input that entry point installs. */

function parses(source: string): boolean {
  return parseAgency(source, {}, false, false).success;
}

describe("array-pattern arms after expression arms", () => {
  const programs: Array<[string, string]> = [
    [
      "a literal single-element pattern in second position",
      `def f(args: any): any {
  return match(args) {
    ["status"] => failure("a")
    ["log"] => failure("b")
    _ => failure("nope")
  }
}`,
    ],
    [
      "a binder pattern in second position",
      `def f(args: any): any {
  return match(args) {
    ["status"] => failure("a")
    [sub] => failure("no rule for \${sub}")
    _ => failure("nope")
  }
}`,
    ],
    [
      "after a multiline arm expression ending in a close paren",
      `def f(args: any): any {
  return match(args) {
    ["status"] => success(
      [1, 2]
    )
    [sub] => failure("no rule")
    _ => failure("nope")
  }
}`,
    ],
    [
      "a guarded single-element pattern in second position",
      `def f(args: any, n: number): any {
  return match(args) {
    ["status"] => failure("a")
    ["log"] if (n == 0) => failure("b")
    _ => failure("nope")
  }
}`,
    ],
  ];

  programs.forEach(([name, source]) => {
    it(`parses ${name}`, () => {
      expect(parses(source)).toBe(true);
    });
  });
});

describe("same-line chains keep working", () => {
  const programs: Array<[string, string]> = [
    [
      "plain chained indexing",
      `def f(arr: number[][]): number {
  return arr[0][1]
}`,
    ],
    [
      "a slice",
      `def f(arr: number[]): number[] {
  return arr[:2]
}`,
    ],
    [
      "an index directly after a multiline call's close paren",
      `def g(a: number, b: number): number[] {
  return [a, b]
}
def f(): number {
  return g(
    1,
    2,
  )[0]
}`,
    ],
  ];

  programs.forEach(([name, source]) => {
    it(`still chains: ${name}`, () => {
      expect(parses(source)).toBe(true);
    });
  });
});

describe("a bracket on a new line is not a chain", () => {
  it("does not fold a next-line bracket into the call", () => {
    // Under the old behavior `g()` chained with `[0]` into `g()[0]`.
    // With the boundary the bracket stays separate, so no index element
    // may appear anywhere in the parsed program.
    const source = `def g(): number[] {
  return [1]
}
node main() {
  const x = g()
  [0]
  return x
}`;
    const result = parseAgency(source, {}, false, false);
    if (result.success) {
      expect(JSON.stringify(result.result.nodes)).not.toContain('"index"');
    }
    // Whether the bare `[0]` line parses as a statement or is rejected is
    // the statement grammar's business; the boundary only guarantees it
    // never glues onto the previous expression.
  });
});
