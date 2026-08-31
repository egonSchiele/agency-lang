import { describe, expect, it } from "vitest";
import { formatSource } from "../formatter.js";
import { parseAgency } from "../parser.js";

describe("agencyGenerator - match block arm printing", () => {
  it.each([
    [
      "multi-statement block arm",
      [
        "node main() {",
        "  match(x) {",
        '    "a" => {',
        '      print("hi")',
        "      let y = 1",
        "    }",
        "    _ => 0",
        "  }",
        "}",
      ].join("\n"),
    ],
    [
      "single-expression arm stays inline",
      ["node main() {", "  match(x) {", '    "a" => 1', "  }", "}"].join("\n"),
    ],
    // NOTE: this case is intentionally a top-level (unwrapped) match rather
    // than `node main() { ... }`. There is a pre-existing parser bug (present
    // on main before this feature branch, verified via a scratch worktree at
    // the branch's merge-base commit fe57dc53) where a match guard clause
    // fails to parse whenever the match block is nested inside a node/def
    // body — `bodyParser`'s statement alternation returns null for any
    // `pattern if (cond) => ...` arm once nested, even though
    // `matchBlockParser`/`matchBlockParserCase` parse the identical text
    // successfully in isolation. That bug is orthogonal to Task 2 (formatter
    // printing) and out of scope here; flagged for separate follow-up. Using
    // a bare top-level match avoids the broken code path while still
    // exercising the guard + multi-statement block printing this task adds.
    [
      "block arm with a guard",
      ["match(x) {", "  y if (y > 2) => {", "    print(y)", "    let z = 1", "  }", "}"].join("\n"),
    ],
    [
      "pattern arm block ending in return",
      [
        "node main() {",
        "  match(x) {",
        "    success(v) => {",
        "      print(v)",
        "      return v",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    ],
    [
      "mixed inline and block arms in one match",
      [
        "node main() {",
        "  match(x) {",
        '    "a" => {',
        '      print("a")',
        "      let n = 1",
        "    }",
        '    "b" => 2',
        "    _ => {",
        '      print("d")',
        "      let m = 2",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    ],
    // Object literals always render multi-line (see processAgencyObject), so
    // the canonical formatted form spreads the entries across lines even
    // though the source parses fine as a single-line arm too. What this case
    // guards is the parens: without them `_ => { label: "hi" }` would parse
    // as a (failing) statement block instead of an object-literal expression.
    [
      "parenthesized object-literal arm stays parenthesized",
      [
        "node main() {",
        "  match(x) {",
        "    _ => ({",
        '      label: "hi"',
        "    })",
        "  }",
        "}",
      ].join("\n"),
    ],
    // The author's choice of form is preserved: a one-statement block
    // stays a block instead of collapsing to an inline arm.
    [
      "single-statement block arm is preserved",
      [
        "node main() {",
        "  match(x) {",
        '    "a" => {',
        '      print("hi")',
        "    }",
        "    _ => 0",
        "  }",
        "}",
      ].join("\n"),
    ],
    // A raise is a STATEMENT the single-statement arm grammar does not
    // accept, so its block must survive formatting — fmt used to collapse
    // it into `=> raise ...`, which does not re-parse (#708).
    [
      "raise-statement arm keeps its block",
      [
        "node main() {",
        "  match(x) {",
        '    "a" => {',
        '      raise("careful")',
        "    }",
        "    _ => 0",
        "  }",
        "}",
      ].join("\n"),
    ],
    [
      "if-statement arm keeps its block",
      [
        "node main() {",
        "  match(x) {",
        '    "a" => {',
        "      if (y) {",
        '        print("hi")',
        "      }",
        "    }",
        "    _ => 0",
        "  }",
        "}",
      ].join("\n"),
    ],
    // The interrupt EXPRESSION form shares the raise statement's node
    // type but IS accepted inline; it must keep collapsing.
    [
      "interrupt-expression arm stays inline",
      [
        "node main() {",
        "  match(x) {",
        '    "a" => interrupt("ask")',
        "    _ => 0",
        "  }",
        "}",
      ].join("\n"),
    ],
  ])("round-trips: %s", (_description, input) => {
    const formatted = formatSource(input + "\n");
    expect(formatted).toBe(input.trimEnd() + "\n");
    // Idempotent: a second pass over the formatted output is identical.
    expect(formatSource(formatted!)).toBe(formatted);
  });
});

describe("type pattern formatting", () => {
  it("round-trips every type-pattern spelling", () => {
    const src = `type Person = {
  name: string,
}

def describe(value: any): string {
  if (value is string) {
    return "text"
  }
  return match (value) {
    null => "null"
    n: number => "number"
    { name }: Person => "person"
    [x, y]: number[] => "pair"
    is boolean => "flag"
    _ => "other"
  }
}
`;
    const first = formatSource(src)!;
    // Idempotent: formatting the formatted output changes nothing.
    expect(formatSource(first)).toBe(first);
    // Every spelling survives.
    expect(first).toContain("value is string");
    expect(first).toContain("n: number =>");
    expect(first).toContain("{ name }: Person =>");
    expect(first).toContain("[x, y]: number[] =>");
    expect(first).toContain("is boolean =>");
  });

  it("normalizes _: Type to is Type (same parse node, documented)", () => {
    const src = `def f(x: any): number {
  return match (x) {
    _: string => 1
    _ => 0
  }
}
`;
    expect(formatSource(src)).toContain("is string =>");
  });
});

describe("effect pattern formatting", () => {
  it("round-trips bare and bound effect patterns", () => {
    const src = `node main() {
  match(intr) {
    std::read => 1
    std::write({ data }) => 2
    _ => 0
  }
}
`;
    const first = formatSource(src)!;
    // Idempotent: formatting the formatted output changes nothing.
    expect(formatSource(first)).toBe(first);
    // Both spellings survive: bare name and name with an object binding.
    expect(first).toContain("std::read => 1");
    expect(first).toContain("std::write({ data }) => 2");
    // Print -> reparse identity: the formatted output parses to the same AST as
    // the source, so no arm silently changed shape on the way through.
    const original = parseAgency(src, {}, false);
    const reparsed = parseAgency(first, {}, false);
    expect(original.success && reparsed.success).toBe(true);
    if (!original.success || !reparsed.success) return;
    expect(reparsed.result.nodes).toEqualWithoutLoc(original.result.nodes);
  });
});
