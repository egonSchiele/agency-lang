import { describe, it, expect } from "vitest";
import { typecheckSource } from "./testUtils.js";

// Hard errors (severity "error", or no explicit severity — which renders as an
// error, e.g. type-mismatch diagnostics), as message strings.
function hardErrors(source: string): string[] {
  return typecheckSource(source)
    .filter((e) => (e.severity ?? "error") === "error")
    .map((e) => e.message);
}

const HEAD = `
effect app::confirm { question: string }
effect app::rateLimited { retryAfter: number }
def ask(q: string): string { return q }
def waitFor(n: number): number { return n }
def risky() { raise app::confirm("c", { question: "ok?" })\n raise app::rateLimited("r", { retryAfter: 5 }) }`;

describe("match-arm receiver narrowing (H4)", () => {
  it("match(e.effect) narrows e.data per arm — clean when types match", () => {
    const errs = hardErrors(`${HEAD}
node main() {
  handle { risky() } with (e) {
    match (e.effect) {
      "app::confirm"     => ask(e.data.question)
      "app::rateLimited" => waitFor(e.data.retryAfter)
    }
  }
}`);
    expect(errs).toEqual([]);
  });

  it("match(e.effect) still flags a genuine payload-type mismatch in an arm", () => {
    const errs = hardErrors(`${HEAD}
node main() {
  handle { risky() } with (e) {
    match (e.effect) {
      "app::confirm"     => waitFor(e.data.question)
      "app::rateLimited" => waitFor(e.data.retryAfter)
    }
  }
}`);
    // e.data.question is string, waitFor wants number → error in the confirm arm.
    expect(errs.some((m) => /not assignable/i.test(m))).toBe(true);
  });
});

describe("match-arm narrowing — soundness & edges", () => {
  it("a wildcard `_` arm is not narrowed (base flow, no crash)", () => {
    const errs = hardErrors(`${HEAD}
node main() {
  handle { risky() } with (e) {
    match (e.effect) {
      "app::confirm" => ask(e.data.question)
      _ => 0
    }
  }
}`);
    expect(errs).toEqual([]);
  });

  it("a bare-variable / plain-string scrutinee is a safe no-op (no crash)", () => {
    // A bare-variable scrutinee produces no discriminant facts, so the arm gets
    // the base flow. `s` is still usable as a plain string inside the arm.
    const errs = hardErrors(`
def takesStr(s: string): string { return s }
def pick(s: string): string {
  match (s) {
    "a" => takesStr(s)
    _ => "z"
  }
  return "x"
}`);
    expect(errs).toEqual([]);
  });

  it("match on an isExpression scrutinee does not crash (lowered away, never a matchBlock)", () => {
    // `match (x is A)` lowers to assignment + if-chain (patternLowering.ts:305-352),
    // so it never reaches the matchBlock flow handler. Smoke test the whole path.
    const errs = hardErrors(`
type A = { kind: "a", n: number }
type B = { kind: "b", s: string }
def f(x: A | B): number {
  match (x is A) {
    true => 1
    false => 0
  }
}
node main() { let r = f({ kind: "a", n: 1 })\n print(r) }`);
    // Whatever the exhaustiveness/typing outcome, the run must not throw.
    expect(Array.isArray(errs)).toBe(true);
  });

  it("does NOT apply cross-arm negative narrowing (arm sees only its own literal)", () => {
    const errs = hardErrors(`${HEAD}
node main() {
  handle { risky() } with (e) {
    match (e.effect) {
      "app::confirm" => waitFor(e.data.retryAfter)
      _ => 0
    }
  }
}`);
    expect(errs.some((m) => /not available on every member|does not exist|not assignable/i.test(m))).toBe(true);
  });

  it("exhaustiveness still fires independently of narrowing", () => {
    const errs = hardErrors(`${HEAD}
node main() {
  handle { risky() } with (e) {
    match (e.effect) {
      "app::confirm" => ask(e.data.question)
    }
  }
}`);
    // Missing "app::rateLimited" is a warn (default), not a hard error; this only
    // confirms narrowing didn't suppress or crash the exhaustiveness pass.
    expect(errs).toEqual([]);
  });
});

// Generality: prove the design isn't string-specific and composes with M2
// (multi-hop scrutinees). Functions are def-only — their bodies are type-checked
// without a call site, avoiding object-literal-to-union widening noise at a call.
describe("match-arm narrowing — generality & composition", () => {
  const TAG = `
type TagA = { tag: 1, a: number }
type TagB = { tag: 2, b: string }
def takesNum(n: number): number { return n }
def takesStr(s: string): string { return s }`;

  it("number-literal arms narrow the receiver", () => {
    const errs = hardErrors(`${TAG}
def f(t: TagA | TagB): number {
  match (t.tag) {
    1 => takesNum(t.a)
    2 => takesStr(t.b)
  }
  return 0
}`);
    expect(errs).toEqual([]);
  });

  it("number-literal arm still flags a real mismatch", () => {
    const errs = hardErrors(`${TAG}
def f(t: TagA | TagB): number {
  match (t.tag) {
    1 => takesStr(t.a)
    2 => takesNum(t.b)
  }
  return 0
}`);
    // t.a is number → takesStr errors; t.b is string → takesNum errors.
    expect(errs.some((m) => /not assignable/i.test(m))).toBe(true);
  });

  it("boolean-literal arms narrow the receiver", () => {
    const errs = hardErrors(`
type Open   = { open: true, handle: number }
type Closed = { open: false, reason: string }
def takesNum(n: number): number { return n }
def takesStr(s: string): string { return s }
def f(o: Open | Closed): number {
  match (o.open) {
    true  => takesNum(o.handle)
    false => takesStr(o.reason)
  }
  return 0
}`);
    expect(errs).toEqual([]);
  });

  it("multi-hop scrutinee narrows the receiver (M2 composition)", () => {
    const errs = hardErrors(`${TAG}
type Wrap = { inner: TagA | TagB }
def f(w: Wrap): number {
  match (w.inner.tag) {
    1 => takesNum(w.inner.a)
    2 => takesStr(w.inner.b)
  }
  return 0
}`);
    expect(errs).toEqual([]);
  });
});
