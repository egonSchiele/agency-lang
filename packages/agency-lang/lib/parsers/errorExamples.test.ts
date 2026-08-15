import { describe, it, expect } from "vitest";
import { parseAgency } from "@/parser.js";
import {
  C_STYLE_FOR_MESSAGE,
  HANDLER_BODY_MESSAGE,
  IF_EXPRESSION_MESSAGE,
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
    ["ternary replacement", TERNARY_MESSAGE, `node main(isProd: boolean) {\n  %s\n}`],
    ["handler", HANDLER_BODY_MESSAGE, `node main() {\n  %s\n}`],
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
