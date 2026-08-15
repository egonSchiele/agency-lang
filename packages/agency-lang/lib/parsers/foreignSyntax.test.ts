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

describe("switch statements are refused with a message naming match", () => {
  it("catches `case` arms", () => {
    const message = failure(`node main() { switch (x) { case 1: print(1) } }`);
    expect(message).toMatch(/no `switch` statement/);
    expect(message).toContain("match (x)");
  });

  it("catches a `default`-only body", () => {
    expect(failure(`node main() { switch (x) { default: print(1) } }`)).toMatch(
      /no `switch` statement/,
    );
  });

  it("explains the two things match does differently", () => {
    const message = failure(`node main() { switch (x) { case 1: print(1) } }`);
    expect(message).toContain("break");
    expect(message).toContain("_");
  });

  // `switch` is a legal identifier and the stdlib already has a
  // `std::git::switch` effect, so the probe must not fire on an ordinary call.
  it("leaves a call to something named switch alone", () => {
    expect(parses(`node main() { switch(x) }`)).toBe(true);
    expect(parses(`def switch(x: number) { print(x) }\nnode main() { switch(1) }`)).toBe(true);
  });

  it("catches a computed condition", () => {
    // A probe that scanned to the first `)` would stop at the one closing
    // `f(x)` and decline. Switching on a computed value is at least as common
    // as switching on a name.
    expect(failure(`node main() { switch (f(x)) { case 1: print(1) } }`)).toMatch(
      /no `switch` statement/,
    );
  });

  it("catches a parenthesized case label", () => {
    expect(failure(`node main() { switch (x) { case (1): print(1) } }`)).toMatch(
      /no `switch` statement/,
    );
  });

  // The label's `:` is what disambiguates. A block that merely starts with
  // something *named* `case` is ordinary Agency.
  it("leaves a call whose block starts with a call to `case` alone", () => {
    expect(parses(`def switch(b) { return b() }\nnode main() { switch(1) { case(1) } }`)).toBe(
      true,
    );
  });

  it("leaves a block containing a variable named case alone", () => {
    expect(parses(`node main() { doThing(1) { case } }`)).toBe(true);
  });

  it("leaves a match block alone", () => {
    expect(parses(`node main() { match (x) { 1 => print(1) _ => print(2) } }`)).toBe(true);
  });
});

describe("C-style for loops are refused with a message naming the alternatives", () => {
  it("catches the `let` form", () => {
    const message = failure(`node main() { for (let i = 0; i < 10; i++) { print(i) } }`);
    expect(message).toMatch(/no C-style `for` loop/);
    expect(message).toContain("range(0, 10)");
  });

  it("catches the form with no declaration keyword", () => {
    expect(failure(`node main() { for (i = 0; i < 10; i++) { print(i) } }`)).toMatch(
      /no C-style `for` loop/,
    );
  });

  it("offers iteration, comprehensions and while as alternatives", () => {
    const message = failure(`node main() { for (let i = 0; i < 10; i++) { print(i) } }`);
    expect(message).toContain("for (item in items)");
    expect(message).toContain("[x * 2 for x in items]");
    expect(message).toContain("while (cond)");
  });

  it.each([
    ["plain", `node main() { for (x in xs) { print(x) } }`],
    ["with index", `node main() { for (x, i in xs) { print(x) } }`],
    ["object destructuring", `node main() { for ({ a, b } in xs) { print(a) } }`],
    ["array destructuring", `node main() { for ([a, b] in xs) { print(a) } }`],
    // A probe that scanned for `;` instead of keying on the initializer shape
    // would misfire here.
    ["semicolon inside a string", `node main() { for (x in ["a;b"]) { print(x) } }`],
    ["over a range call", `node main() { for (i in range(0, 10)) { print(i) } }`],
  ])("leaves an Agency for loop alone: %s", (_name, src) => {
    expect(parses(src)).toBe(true);
  });

  it("leaves a while loop alone", () => {
    expect(parses(`node main() { let i = 0\nwhile (i < 3) { i = i + 1 } }`)).toBe(true);
  });

  it("does not fire on an equality comparison in a for header", () => {
    expect(parses(`node main() { for (x in xs) { if (x == 1) { print(x) } } }`)).toBe(true);
  });
});
