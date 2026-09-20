import { describe, it, expect } from "vitest";
import { parseAgency, replaceBlankLines } from "@/parser.js";
import {
  CATCH_ALL_NOT_LAST,
  C_STYLE_FOR_MESSAGE,
  DECLARATION_WITHOUT_VALUE_MESSAGE,
  DUPLICATE_ON_CLAUSE,
  EMPTY_HANDLER_BLOCK,
  MALFORMED_ON_CLAUSE,
  HANDLER_BODY_MESSAGE,
  IF_EXPRESSION_MESSAGE,
  IF_IN_INTERPOLATION_MESSAGE,
  JS_REGEX_MESSAGE,
  MATCH_CASES_MESSAGE,
  SWITCH_MESSAGE,
  TERNARY_MESSAGE,
} from "./messages.js";

/** Pull the code example out of a message. `messages.ts` requires every example
 *  to be indented by exactly two spaces, which is what makes this possible;
 *  prose lines are flush left. */
function exampleFrom(message: string): string {
  return message
    .split("\n")
    .filter((line) => line.startsWith("  "))
    .map((line) => line.slice(2))
    .join("\n");
}

function failure(src: string) {
  const parsed = parseAgency(src, {}, false);
  if (parsed.success) throw new Error(`expected a failed parse for: ${src}`);
  return parsed.message ?? "";
}

function parses(src: string) {
  return parseAgency(src, {}, false).success;
}

describe("ternaries are refused with the if-then-else form", () => {
  it.each([
    ["a const value", `node main() { const y = x ? 1 : 2 }`],
    ["a return value", `def f(x: boolean): number { return x ? 1 : 2 }`],
    ["a call argument", `node main() { print(x ? 1 : 2) }`],
    ["an object field", `node main() { const o = { a: x ? 1 : 2 } }`],
  ])("catches a ternary as %s", (_name, src) => {
    const message = failure(src);
    expect(message).toMatch(/no ternary/);
    expect(message).toContain("if isProd then");
  });

  // Prettier wraps any ternary past the line limit onto three lines, so this
  // is the shape a model has seen most. Skipping only spaces missed it
  // entirely and fell through to the catch-all.
  it.each([
    ["wrapped across three lines", `node main() {\n  const y = cond\n    ? a\n    : b\n}`],
    ["a newline after the question mark", `node main() { const y = cond ?\n a : b }`],
    ["a newline before the colon", `node main() { const y = cond ? a\n : b }`],
  ])("catches a ternary %s", (_name, src) => {
    expect(failure(src)).toMatch(/no ternary/);
  });

  // The inner refusal fires first and anchors the message at the inner `?`.
  // Recorded because the behaviour is a consequence of the wrapper running on
  // every expression, not something designed.
  it("reports a nested ternary at the inner question mark", () => {
    const message = failure(`node main() { const y = a ? b ? c : d : e }`);
    expect(message).toMatch(/no ternary/);
    expect(message).toMatch(/^Line 1, col 3[0-9]:/);
  });

  // Unlike the statement-level probes, this one runs inside speculative
  // branches. A ternary refusal recorded in a branch that is later discarded
  // must not outrank the real failure.
  it("does not hijack an unrelated later failure", () => {
    const message = failure(
      `node main() {\n  match (x) {\n    1 => print(1)\n    _ => print(2)\n  }\n  switch (y) { case 1: print(1) }\n}`,
    );
    expect(message).toMatch(/no `switch` statement/);
    expect(message).not.toMatch(/no ternary/);
  });

  it("reports a real position rather than the body catch-all", () => {
    const message = failure(`node main() { const y = x ? 1 : 2 }`);
    expect(message).toMatch(/^Line \d+, col \d+:/);
    expect(message).not.toContain("expected node body");
  });

  // `?.` and `??` are real Agency operators; only a bare `?` is a ternary.
  it.each([
    ["optional chaining", `node main() { const o = { a: 1 }\nprint(o?.a) }`],
    ["nullish coalescing", `node main() { const y = a ?? 1 }`],
    ["an optional parameter", `def f(a?: number) { print(a) }\nnode main() { f(1) }`],
    ["an optional property", `type T = { a?: string }\nnode main() { print(1) }`],
    ["a question mark in a string", `node main() { const s = "a ? b : c" }`],
    ["an object literal", `node main() { const o = { a: 1, b: 2 } }`],
    ["match arms", `node main() { match (x) { 1 => print(1) _ => print(2) } }`],
  ])("leaves %s alone", (_name, src) => {
    expect(parses(src)).toBe(true);
  });
});

describe("messages carry a worked example", () => {
  it("match arms show patterns, a guard, a block arm and the catch-all", () => {
    const message = failure(`node main() { match (x) { 1: print(1) } }`);
    expect(message).toContain("match (shape)");
    expect(message).toContain("if (side > 0) =>");
    expect(message).toContain("_ =>");
  });

  it("if-then-else names itself as the ternary replacement", () => {
    const message = failure(`node main() { const y = if x then 1 }`);
    expect(message).toContain("if isProd then");
    expect(message).toContain("ternary");
  });

  it("the handler body shows the `with` form and the verbs", () => {
    const message = failure(`node main() { handle { read("a") } with (i) }`);
    expect(message).toContain("} with (intr) {");
    expect(message).toContain("approve()");
    expect(message).toContain("with approve");
  });
});

/**
 * Every code example embedded in a parser error message must itself be valid
 * Agency. An example that does not parse is worse than no example: it teaches
 * the wrong thing to exactly the reader who is already stuck.
 *
 * The example is EXTRACTED from the real message string rather than
 * transcribed here, so editing a message cannot leave this passing on a stale
 * copy. Extraction keys on the two-space indent that `messages.ts` requires of
 * every example.
 *
 * The scaffolding around each example (the types and node it needs to stand
 * alone) still has to be written by hand; `%s` in it marks where the extracted
 * block goes.
 */
describe("every example in a parser message is valid Agency", () => {
  const cases: [string, string, string][] = [
    [
      "match arms",
      MATCH_CASES_MESSAGE,
      `type Shape = { kind: "circle", r: number } | { kind: "square", side: number }
node main(shape: Shape) {
  const area = %s
  print(area)
}`,
    ],
    ["if-then-else", IF_EXPRESSION_MESSAGE, `node main(isProd: boolean) {\n  %s\n}`],
    [
      "if inside an interpolation",
      IF_IN_INTERPOLATION_MESSAGE,
      `node main(count: number) {\n  %s\n}`,
    ],
    ["ternary replacement", TERNARY_MESSAGE, `node main(isProd: boolean) {\n  %s\n}`],
    ["handler", HANDLER_BODY_MESSAGE, `node main() {\n  %s\n}`],
    ["empty handler block", EMPTY_HANDLER_BLOCK, `node main() {\n  %s\n}`],
    ["malformed on clause", MALFORMED_ON_CLAUSE, `node main() {\n  %s\n}`],
    ["on _ not last", CATCH_ALL_NOT_LAST, `node main() {\n  %s\n}`],
    ["duplicate on clause", DUPLICATE_ON_CLAUSE("std::read"), `node main() {\n  %s\n}`],
    ["switch replacement", SWITCH_MESSAGE, `node main(x: string) {\n  %s\n}`],
    [
      "C-style-for alternatives",
      C_STYLE_FOR_MESSAGE,
      `node main(items: string[]) {\n  %s\n  print(1)\n}`,
    ],
  ];

  it.each(cases)("%s", (_name, message, scaffold) => {
    const example = exampleFrom(message);
    expect(example).not.toBe("");
    const source = scaffold.replace("%s", example.split("\n").join("\n  "));
    if (!parses(source)) {
      throw new Error(`example does not parse:\n${source}`);
    }
  });
});

describe("a statement the parser cannot read is reported where it starts", () => {
  // The enclosing block's own "expected `{`" message must not win: the `{`
  // is there.
  it.each([
    ["a function", `def f(lines: string[]): number {\n  const n = +lines\n  return 1\n}`, 2],
    [
      "an if block",
      `def f(n: number): number {\n  if (n > 1) {\n    const m = +n\n  }\n  return 1\n}`,
      3,
    ],
    [
      "a for loop",
      `def f(xs: number[]): number {\n  for (x in xs) {\n    const m = +x\n  }\n  return 1\n}`,
      3,
    ],
    ["a node", `node main() {\n  const m = +1\n}`, 2],
  ])("inside %s", (_name, src, line) => {
    const message = failure(src);
    expect(message).toMatch(new RegExp(`^Line ${line}, col \\d+: cannot read the statement`));
    expect(message).not.toMatch(/to open|function body|node body/);
  });

  it("still reports a missing `{`", () => {
    expect(
      failure(`def f(n: number): number {\n  if (n > 1)\n    return 2\n  return 1\n}`),
    ).toMatch(/expected `\{` to open if block body/);
  });
});

// `x as Type` is a real cast now; see lib/parsers/cast.test.ts.
describe("an `as` cast parses", () => {
  it.each([
    ["a return value", `def f(r: number): number {\n  return (r as number)\n}`],
    ["a const value", `def f(r: number): number {\n  const n = r as number\n  return n\n}`],
    ["an object", `def f(): Json {\n  return ({ ok: true } as Json)\n}`],
    [
      "a trailing block",
      `def f(xs: number[]): number[] {\n  return map(xs) as x {\n    return x + 1\n  }\n}`,
    ],
  ])("as %s", (_name, src) => {
    expect(parses(src)).toBe(true);
  });
});

describe("a JavaScript regex literal is refused", () => {
  it("catches it as a call argument", () => {
    expect(failure(`def f(t: string): string[] {\n  return t.split(/\\r?\\n/)\n}`)).toMatch(
      /^Line 2, col \d+: Agency writes a regex literal as `re\/...\/`/,
    );
  });

  it.each([
    ["division", `def f(a: number, b: number): number {\n  return a / b / 2\n}`],
    ["a comment after a value", `def f(a: number): number {\n  return a // half / done\n}`],
    ["an Agency regex", `def f(t: string): string[] {\n  return t.split(re/,/)\n}`],
  ])("leaves %s alone", (_name, src) => {
    expect(parses(src)).toBe(true);
  });

  it("gives an example that parses", () => {
    expect(parses(`def f(text: string) {\n${exampleFrom(JS_REGEX_MESSAGE)}\n}`)).toBe(true);
  });
});

describe("the line in a message is the user's line", () => {
  // Every file is parsed behind a two-line template, which the line in a
  // message must not count.
  it.each([
    ["a refusal", `def f(a: number): number {\n  const x = a > 1 ? 2 : 3\n  return x\n}`],
    ["a thrown error", `def f(a: number): number {\n  const x = +a\n  return x\n}`],
  ])("for %s", (_name, src) => {
    const parsed = parseAgency(src, {}, true);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.message).toMatch(/^Line 2, col /);
    expect(parsed.errorData?.line).toBe(1);
    expect(parsed.errorData?.prettyMessage).not.toMatch(/^Line [^2]/);
  });
});

describe("blank lines do not shift the line in a message", () => {
  // The formatter, `agency ast`, and `parseAST` in std::agency keep blank
  // lines by turning each one's newline into a sentinel before parsing.
  const src = `def f(): number {\n\n\n  const a = 1\n\n  const b = +a\n  return b\n}\n`;

  it.each([
    ["as written", src],
    ["with blank lines kept", replaceBlankLines(src)],
  ])("%s", (_name, input) => {
    const parsed = parseAgency(input, {}, false, false);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.message).toMatch(/^Line 6, col /);
    expect(parsed.errorData?.line).toBe(5);
  });
});

describe("a declaration with no value is refused", () => {
  it.each([
    ["a typed let", `def f(): string {\n  let s: string\n  s = "a"\n  return s\n}`],
    ["an untyped let", `def f(): string {\n  let s\n  s = "a"\n  return s\n}`],
    ["the last statement", `node main() {\n  let s: string\n}`],
    ["a trailing comment", `node main() {\n  let s: string // set below\n  s = "a"\n}`],
    [
      "the top level of a file",
      `import { a } from "./a.agency"\nconst subject: string\n\nnode main() {\n}`,
    ],
  ])("catches %s on its own line", (_name, src) => {
    expect(failure(src)).toMatch(/^Line 2, col \d+: a `let` or `const` needs a value/);
  });

  it.each([
    [
      "a typed declaration with a value",
      `def f(): number[] {\n  let xs: number[] = []\n  return xs\n}`,
    ],
    ["a name that starts with let", `def f(letter: string): string {\n  return letter\n}`],
  ])("leaves %s alone", (_name, src) => {
    expect(parses(src)).toBe(true);
  });

  it("gives an example that parses", () => {
    expect(parses(`node main() {\n${exampleFrom(DECLARATION_WITHOUT_VALUE_MESSAGE)}\n}`)).toBe(
      true,
    );
  });
});

describe("an if-expression inside a string interpolation is refused", () => {
  const source = (hole: string) =>
    `node main(): string {\n  const x = 5\n  const s = "value: \${${hole}}"\n  return s\n}`;

  it.each([
    ["bare", `if x > 3 then "big" else "small"`],
    ["parenthesized", `(if x > 3 then "big" else "small")`],
    ["parenthesized with a space", `( if x > 3 then "big" else "small")`],
  ])("catches it %s, on the line of the string", (_name, hole) => {
    const message = failure(source(hole));
    expect(message).toContain(IF_IN_INTERPOLATION_MESSAGE);
    expect(message).toMatch(/^Line 3, /);
  });

  it("leaves a name that only starts with `if` alone", () => {
    expect(parses(source("ifCount"))).toBe(true);
  });
});
