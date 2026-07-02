import { describe, expect, it } from "vitest";
import { formatSource } from "../formatter.js";

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
      [
        "node main() {",
        "  match(x) {",
        '    "a" => 1',
        "  }",
        "}",
      ].join("\n"),
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
      [
        "match(x) {",
        "  y if (y > 2) => {",
        "    print(y)",
        "    let z = 1",
        "  }",
        "}",
      ].join("\n"),
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
        '    _ => ({',
        '      label: "hi"',
        "    })",
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
