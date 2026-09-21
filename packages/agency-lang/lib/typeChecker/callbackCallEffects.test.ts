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

// Issue #605: the callback is never called here, only handed on as a tool.
describe("a callback passed as an argument contributes its declared effects", () => {
  it("inline function type in a tools list", () => {
    const src = `def f(cb: () -> string raises <std::read>) raises <> { const r: string = llm("pick", tools: [cb]) }`;
    expect(exceeds(src)).toBe(true);
  });

  it("alias-typed callback in a tools list", () => {
    const src = `type Cb = () -> string raises <std::read>\ndef f(cb: Cb) raises <> { const r: string = llm("pick", tools: [cb]) }`;
    expect(exceeds(src)).toBe(true);
  });

  it("positive: the declared clause covers the passed callback", () => {
    const src = `def f(cb: () -> string raises <std::read>) raises <std::read> { const r: string = llm("pick", tools: [cb]) }`;
    expect(exceeds(src)).toBe(false);
  });

  it("a recursive alias among the arguments terminates", () => {
    const src = `type Tree = { kids: Tree[] }\ndef f(t: Tree) raises <> { print(t) }`;
    expect(exceeds(src)).toBe(false);
  });
});

// The "handler body calls a raising callback" cases asserted AG3010,
// which is retired: handler bodies may raise, so there is no handler
// diagnostic for a raising callback to trip. Callback effect propagation
// itself is covered by the `exceeds` cases above.
