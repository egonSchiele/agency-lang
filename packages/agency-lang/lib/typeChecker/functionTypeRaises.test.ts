import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

// All error messages joined. My pass's diagnostics contain "exceeds the 'raises".
const msgs = (src: string): string =>
  typecheckSource(src)
    .map((e) => e.message)
    .join("\n");

const PRELUDE = `
type Callback = (string) -> string raises <>
effectSet Fs = <std::read>
def reads(s: string): string raises <std::read> {
  raise std::read("m", { dir: ".", filename: s })
  return s
}
def pure(s: string): string { return s }
`;

describe("raises on function types is enforced", () => {
  it("declaration: names the fn + effect + type", () => {
    const m = msgs(`${PRELUDE}\nnode main() { let cb: Callback = reads }`);
    expect(m).toMatch(/exceeds/);
    expect(m).toMatch(/reads/);
    expect(m).toMatch(/std::read/);
    expect(m).toMatch(/Callback/);
  });

  it("no false positive: a pure fn assigned to raises <>", () => {
    expect(msgs(`${PRELUDE}\nnode main() { let cb: Callback = pure }`)).not.toMatch(/exceeds/);
  });

  it("re-assignment without annotation is checked", () => {
    const src = `${PRELUDE}\nnode main() { let cb: Callback = pure\n  cb = reads }`;
    expect(msgs(src)).toMatch(/exceeds/);
  });

  it("call argument (inline-typed param)", () => {
    const src = `${PRELUDE}\ndef runIt(cb: (string) -> string raises <>) { print(cb("x")) }\nnode main() { runIt(reads) }`;
    expect(msgs(src)).toMatch(/std::read/);
  });

  it("named call argument", () => {
    const src = `${PRELUDE}\ndef runIt(cb: (string) -> string raises <>) { print(cb("x")) }\nnode main() { runIt(cb: reads) }`;
    expect(msgs(src)).toMatch(/std::read/);
  });

  it("return position", () => {
    expect(msgs(`${PRELUDE}\ndef pick(): Callback { return reads }`)).toMatch(/std::read/);
  });

  it("partial/preapprove recovers the base name and errors", () => {
    expect(msgs(`${PRELUDE}\nnode main() { let cb: Callback = reads.preapprove() }`)).toMatch(/std::read/);
  });

  it("a block that raises, passed to a raises <> param, errors", () => {
    const src = `${PRELUDE}\ndef runBlock(cb: (string) -> string raises <>) { print(cb("x")) }\nnode main() { runBlock() as s { return reads(s) } }`;
    expect(msgs(src)).toMatch(/std::read/);
  });

  it("opaque alias-typed source with no clause is strict", () => {
    const src = `${PRELUDE}\ntype Loose = (string) -> string\ndef f(cb: Loose) { let s: Callback = cb }`;
    expect(msgs(src)).toMatch(/exceeds/);
  });

  it("<*> target allows anything", () => {
    const src = `${PRELUDE}\ntype AnyFn = (string) -> string raises <*>\nnode main() { let cb: AnyFn = reads }`;
    expect(msgs(src)).not.toMatch(/exceeds/);
  });

  it("effect-set alias on the target resolves", () => {
    const src = `${PRELUDE}\ntype FsCb = (string) -> string raises Fs\nnode main() { let cb: FsCb = reads }`;
    expect(msgs(src)).not.toMatch(/exceeds/);
  });

  it("reports each offending effect", () => {
    const src = `${PRELUDE}\ndef two(s: string): string raises <std::read, std::write> {
      raise std::read("m", {})
      raise std::write("m", {})
      return s
    }\nnode main() { let cb: Callback = two }`;
    const m = msgs(src);
    expect(m).toMatch(/std::read/);
    expect(m).toMatch(/std::write/);
  });

  it("false-positive sweep: no clauses anywhere → no raises errors", () => {
    const src = `${PRELUDE}\ndef hof(cb: (string) -> string) { print(cb("x")) }\nnode main() { hof(pure) }`;
    expect(msgs(src)).not.toMatch(/exceeds/);
  });

  it("partial on a callback variable is checked (base recovered through scope)", () => {
    const src = `${PRELUDE}\ndef hof(cb: (string) -> string raises <std::read>) { let danger: Callback = cb.preapprove() }`;
    expect(msgs(src)).toMatch(/std::read/);
  });

  it("does NOT check a block-local return against the enclosing function", () => {
    // The block returns `reads` into a raises<*> slot (legal); `pick` returns pure.
    const src = `${PRELUDE}\ndef runBlock(cb: (string) -> string raises <*>): string { return cb("x") }\ndef pick(): Callback {\n  let r = runBlock() as s { return reads }\n  return pure\n}`;
    expect(msgs(src)).not.toMatch(/exceeds/);
  });

  it("does NOT resolve a method call against a same-named global def", () => {
    // `[1].push(reads)` is Array.push, not the global `push(cb: Callback)`.
    const src = `${PRELUDE}\ndef push(cb: Callback) { print("noop") }\nnode main() {\n  let xs = [1]\n  xs.push(reads)\n}`;
    expect(msgs(src)).not.toMatch(/exceeds/);
  });

  it("stops positional pairing at a splat", () => {
    // `reads` sits after a splat, whose width is unknown, so it is not paired.
    const src = `${PRELUDE}\ndef f(a: number, cb: Callback) { print("noop") }\nnode main() {\n  let ns = [1]\n  f(...ns, reads)\n}`;
    expect(msgs(src)).not.toMatch(/exceeds/);
  });
});
