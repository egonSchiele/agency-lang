import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

// checkRaisesDeclarations emits "exceeds its declared 'raises ..." — that is the
// signal that calling a callback contributed to the caller's inferred effects.
const exceeds = (src: string): boolean =>
  typecheckSource(src).some((e) => /exceeds/.test(e.message));

describe("a callback call contributes to the caller's inferred effects", () => {
  it("node: calling a raises<std::read> callback in a raises<> node errors", () => {
    const src = `node run(cb: (string) -> string raises <std::read>) raises <> { print(cb("x")) }`;
    expect(exceeds(src)).toBe(true);
  });

  it("alias-typed callback param is resolved", () => {
    const src = `type Cb = (string) -> string raises <std::read>\ndef f(cb: Cb) raises <> { print(cb("x")) }`;
    expect(exceeds(src)).toBe(true);
  });

  it("positive: inferred ⊆ declared through the callback path (no error)", () => {
    const src = `def f(cb: (string) -> string raises <std::read>) raises <std::read> { print(cb("x")) }`;
    expect(exceeds(src)).toBe(false);
  });

  it("does not double-count a named def callee", () => {
    const src = `def reads(): string raises <std::read> { raise std::read("m", {}) return "" }\ndef g() raises <std::read> { reads() }`;
    expect(exceeds(src)).toBe(false);
  });

  it("a raises<*> callback is a documented non-attribution (no error in v1)", () => {
    const src = `def f(cb: (string) -> string raises <*>) raises <> { print(cb("x")) }`;
    expect(exceeds(src)).toBe(false);
  });
});
