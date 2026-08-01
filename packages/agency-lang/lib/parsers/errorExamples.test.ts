import { describe, it, expect } from "vitest";
import { parseAgency } from "@/parser.js";

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
 * Each entry is the example as it appears in its message, wrapped in the least
 * scaffolding needed to stand alone.
 */
describe("every example in a parser message is valid Agency", () => {
  it.each([
    ["match arms", `type Shape = { kind: "circle", r: number } | { kind: "square", side: number }
node main(shape: Shape) {
  const area = match (shape) {
    { kind: "circle", r } => 3.14 * r * r
    { kind: "square", side } if (side > 0) => side * side
    _ => {
      print("unknown")
      return 0
    }
  }
  print(area)
}`],
    ["if-then-else, also quoted by the ternary message", `node main(isProd: boolean) {
  const label = if isProd then "Production" else "Local"
  print(label)
}`],
    ["handler", `node main() {
  handle {
    read("./notes.md")
  } with (intr) {
    if (intr.effect == "std::read") { return approve() }
    return reject()
  }
}`],
    ["the C-style-for alternatives", `node main(items: string[]) {
  for (i in range(0, 10)) { print(i) }
  for (item in items) { print(item) }
  for (item, i in items) { print(i, item) }
  const doubled = [x * 2 for x in items]
  print(doubled)
}`],
    ["the switch replacement", `node main(x: string) {
  match (x) {
    "a" => doThing()
    "b" => doOtherThing()
    _   => fallback()
  }
}`],
  ])("%s", (_name, example) => {
    expect(parses(example)).toBe(true);
  });
});
