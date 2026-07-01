import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { AgencyConfig } from "../config.js";

function check(source: string, config: Partial<AgencyConfig> = {}): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, config, info).errors.map((e) => e.message);
}

const TRY = `
def tryParse(s: string): Result<number, string> {
  if (s == "ok") { return success(42) }
  return failure("bad")
}`;
const ERROR = { typechecker: { matchExhaustiveness: "error" as const } };

describe("match exhaustiveness — Result", () => {
  it("error: missing the failure arm is non-exhaustive", () => {
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) => v
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e) && /failure/.test(e))).toBe(true);
  });

  it("error: both arms → exhaustive, no diagnostic", () => {
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) => v
    failure(e) => 0
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(false);
  });

  it("error: a `_` catch-all clears it", () => {
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) => v
    _ => 0
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(false);
  });

  it("error: a guarded failure arm does NOT count toward coverage", () => {
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) => v
    failure(e) if (e == "x") => 0
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e) && /failure/.test(e))).toBe(true);
  });

  it("silent config: never reported", () => {
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) => v
  }
}`, { typechecker: { matchExhaustiveness: "silent" } });
    expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(false);
  });

  it("warn is now the DEFAULT: a missing case is reported without the knob", () => {
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) => v
  }
}`);
    expect(errs.some((e) => /not exhaustive/i.test(e) && /failure/.test(e))).toBe(true);
  });

  it("warn: emitted as a warning, not an error", () => {
    const src = `${TRY}
node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) => v
  }
}`;
    const parsed = parseAgency(src);
    if (!parsed.success) throw new Error("parse");
    const info = buildCompilationUnit(parsed.result, undefined, undefined, src);
    const errs = typeCheck(parsed.result, { typechecker: { matchExhaustiveness: "warn" } }, info).errors;
    expect(errs.some((e) => e.severity === "warning" && /not exhaustive/i.test(e.message))).toBe(true);
    expect(errs.some((e) => (e.severity ?? "error") === "error" && /not exhaustive/i.test(e.message))).toBe(false);
  });
});

describe("match exhaustiveness — literal unions", () => {
  // `describeCase` renders a string literal QUOTED (e.g. `"c"`), so assert the
  // missing clause names the case precisely — a bare `/c/` would match many words.
  it("error: missing a literal arm names the missing case", () => {
    const errs = check(`
def f(x: "a" | "b" | "c"): number {
  match (x) {
    "a" => 1
    "b" => 2
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e) && /missing\b.*"c"/.test(e))).toBe(true);
  });

  it("error: all literals covered → exhaustive", () => {
    const errs = check(`
def f(x: "a" | "b"): number {
  match (x) {
    "a" => 1
    "b" => 2
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(false);
  });

  it("error: a `_` catch-all on a literal union clears it", () => {
    const errs = check(`
def f(x: "a" | "b"): number {
  match (x) {
    "a" => 1
    _ => 0
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(false);
  });

  it("error: numeric literal union — missing case named", () => {
    const errs = check(`
def f(x: 1 | 2): number {
  match (x) {
    1 => 10
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e) && /missing\b.*2/.test(e))).toBe(true);
  });

  it("error: a guarded literal arm does NOT count toward coverage", () => {
    const errs = check(`
def f(x: "a" | "b", cond: boolean): number {
  match (x) {
    "a" => 1
    "b" if (cond) => 2
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e) && /missing\b.*"b"/.test(e))).toBe(true);
  });

  it("escaped-string literal: pin armLiteral vs literalCase agreement", () => {
    const errs = check(`
def f(x: "a\\nb" | "c"): number {
  match (x) {
    "a\\nb" => 1
    "c" => 2
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(false);
  });

  it("type-alias scrutinee: resolves through getTypeAliases → safeResolveType", () => {
    const errs = check(`
type Status = "a" | "b"
def f(s: Status): number {
  match (s) {
    "a" => 1
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e) && /missing\b.*"b"/.test(e))).toBe(true);
  });
});

describe("match exhaustiveness — open / unsupported (no false positives)", () => {
  it("error config: match over a plain string is never reported (open)", () => {
    const errs = check(`
def f(x: string): number {
  match (x) {
    "a" => 1
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(false);
  });

  it("error config: match over a non-discriminated object union is not reported (B2 territory)", () => {
    const errs = check(`
type U = { a: string } | { b: number }
def f(u: U): number {
  match (u) {
    { a } => 1
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(false);
  });

  it("error config: match over a plain boolean IS checked (B2 enumerates true|false)", () => {
    const errs = check(`
def f(x: boolean): number {
  match (x) {
    true => 1
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e) && /false/.test(e))).toBe(true);
  });
});

describe("match exhaustiveness — coverage edge cases & structural", () => {
  it("error: a bare-variable arm is a catch-all (exercises isCatchAll variableName branch)", () => {
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) => v
    other => 0
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(false);
  });

  it("error: a guarded success arm does NOT count (symmetric to guarded failure)", () => {
    const errs = check(`${TRY}
node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) if (v > 0) => v
    failure(e) => 0
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e) && /success/.test(e))).toBe(true);
  });

  it("error: a match inside a def body is checked (function-scope coverage)", () => {
    const errs = check(`${TRY}
def use(): number {
  let r = tryParse("ok")
  match (r) {
    success(v) => v
  }
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e))).toBe(true);
  });

  it("error: a match nested in an if body is visited (walkNodes recursion)", () => {
    // match isn't an expression, so nest it in control flow rather than an arm.
    const errs = check(`
def f(x: "a" | "b"): number {
  if (true) {
    match (x) { "a" => 1 }
  }
  return 0
}`, ERROR);
    expect(errs.some((e) => /not exhaustive/i.test(e) && /missing\b.*"b"/.test(e))).toBe(true);
  });

  it("error: per-site — one exhaustive match + one not, only the latter reported", () => {
    const errs = check(`
def f(x: "a" | "b", y: "p" | "q"): number {
  match (x) { "a" => 1
 "b" => 2 }
  match (y) { "p" => 1 }
  return 0
}`, ERROR);
    const reported = errs.filter((e) => /not exhaustive/i.test(e));
    expect(reported.length).toBe(1);
    expect(reported[0]).toMatch(/missing\b.*"q"/);
  });

  it("the no-knob default resolves to warn (same count as explicit warn, one more than silent)", () => {
    const src = `${TRY}
node main() {
  let r = tryParse("ok")
  match (r) {
    success(v) => v
  }
}`;
    const run = (config: Partial<AgencyConfig>) => {
      const p = parseAgency(src);
      if (!p.success) throw new Error("parse");
      const info = buildCompilationUnit(p.result, undefined, undefined, src);
      return typeCheck(p.result, config, info).errors.length;
    };
    const silent = run({ typechecker: { matchExhaustiveness: "silent" } });
    // No-knob default now behaves like explicit `warn` (the B2b flip).
    expect(run({})).toBe(run({ typechecker: { matchExhaustiveness: "warn" } }));
    expect(run({})).toBe(silent + 1);
  });
});

const EV = `type Ev = { kind: "click", x: number } | { kind: "scroll", d: number }`;

describe("match exhaustiveness — discriminated object union (B2)", () => {
  it("missing a discriminant member is non-exhaustive", () => {
    const errs = check(`${EV}
def f(e: Ev): number {
  match (e) { { kind: "click" } => 1 }
}`, ERROR);
    expect(errs.some((m) => /not exhaustive/i.test(m) && /scroll/.test(m))).toBe(true);
  });

  it("all members covered → clean", () => {
    expect(check(`${EV}
def f(e: Ev): number {
  match (e) { { kind: "click" } => 1  { kind: "scroll" } => 2 }
}`, ERROR).some((m) => /not exhaustive/i.test(m))).toBe(false);
  });

  it("a `_` arm clears it", () => {
    expect(check(`${EV}
def f(e: Ev): number {
  match (e) { { kind: "click" } => 1  _ => 0 }
}`, ERROR).some((m) => /not exhaustive/i.test(m))).toBe(false);
  });

  it("a guarded arm does not count as coverage", () => {
    expect(check(`${EV}
def f(e: Ev): number {
  match (e) { { kind: "click" } => 1  { kind: "scroll" } if (e.d > 0) => 2 }
}`, ERROR).some((m) => /not exhaustive/i.test(m) && /scroll/.test(m))).toBe(true);
  });

  it("an ambiguous objectPattern arm (no discriminant literal) → no diagnostic (bail)", () => {
    expect(check(`${EV}
def f(e: Ev): number {
  match (e) { { x } => 1 }
}`, ERROR).some((m) => /not exhaustive/i.test(m))).toBe(false);
  });

  it("a non-discriminated object union is not checked", () => {
    expect(check(`
type U = { a: number } | { b: string }
def f(u: U): number {
  match (u) { { a } => 1 }
}`, ERROR).some((m) => /not exhaustive/i.test(m))).toBe(false);
  });

  it("number discriminant works", () => {
    expect(check(`
type T = { tag: 1, x: number } | { tag: 2, y: number }
def f(t: T): number {
  match (t) { { tag: 1 } => 1 }
}`, ERROR).some((m) => /not exhaustive/i.test(m))).toBe(true);
  });

  it("boolean discriminant works", () => {
    expect(check(`
type T = { open: true, x: number } | { open: false, y: number }
def f(t: T): number {
  match (t) { { open: true } => 1 }
}`, ERROR).some((m) => /not exhaustive/i.test(m))).toBe(true);
  });

  it("multiple missing members are all named", () => {
    const errs = check(`
type T = { kind: "a" } | { kind: "b" } | { kind: "c" }
def f(t: T): number {
  match (t) { { kind: "a" } => 1 }
}`, ERROR);
    expect(errs.some((m) => /not exhaustive/i.test(m) && /b/.test(m) && /c/.test(m))).toBe(true);
  });

  it("a rest binding still covers the member", () => {
    expect(check(`${EV}
def f(e: Ev): number {
  match (e) { { kind: "click", ...rest } => 1  { kind: "scroll" } => 2 }
}`, ERROR).some((m) => /not exhaustive/i.test(m))).toBe(false);
  });

  it("a shorthand discriminant property (`{ kind }`) does not pin → bail", () => {
    expect(check(`${EV}
def f(e: Ev): number {
  match (e) { { kind } => 1 }
}`, ERROR).some((m) => /not exhaustive/i.test(m))).toBe(false);
  });

  it("an interpolated-string discriminant does not pin → bail", () => {
    expect(check(`${EV}
def f(e: Ev, s: string): number {
  match (e) { { kind: "cl${"$"}{s}" } => 1 }
}`, ERROR).some((m) => /not exhaustive/i.test(m))).toBe(false);
  });

  it("a guarded arm alongside `_` is clean", () => {
    expect(check(`${EV}
def f(e: Ev): number {
  match (e) { { kind: "click" } => 1  { kind: "scroll" } if (e.d > 0) => 2  _ => 0 }
}`, ERROR).some((m) => /not exhaustive/i.test(m))).toBe(false);
  });

  it("discriminates through a type alias of the union", () => {
    expect(check(`${EV}
type Wrap = Ev
def f(w: Wrap): number {
  match (w) { { kind: "click" } => 1 }
}`, ERROR).some((m) => /not exhaustive/i.test(m) && /scroll/.test(m))).toBe(true);
  });

  it("default (warn): a missing discriminant member is reported without the knob", () => {
    expect(check(`${EV}
def f(e: Ev): number {
  match (e) { { kind: "click" } => 1 }
}`).some((m) => /not exhaustive/i.test(m) && /scroll/.test(m))).toBe(true);
  });

  it("silent config still suppresses the discriminated-union diagnostic", () => {
    expect(check(`${EV}
def f(e: Ev): number {
  match (e) { { kind: "click" } => 1 }
}`, { typechecker: { matchExhaustiveness: "silent" } }).some((m) => /not exhaustive/i.test(m))).toBe(false);
  });
});

describe("match exhaustiveness — boolean scrutinee (B2)", () => {
  it("both true and false arms → exhaustive", () => {
    expect(check(`
def f(b: boolean): number {
  match (b) { true => 1  false => 0 }
}`, ERROR).some((m) => /not exhaustive/i.test(m))).toBe(false);
  });
  it("missing the false arm is non-exhaustive", () => {
    expect(check(`
def f(b: boolean): number {
  match (b) { true => 1 }
}`, ERROR).some((m) => /not exhaustive/i.test(m) && /false/.test(m))).toBe(true);
  });
  it("a `_` arm clears it", () => {
    expect(check(`
def f(b: boolean): number {
  match (b) { true => 1  _ => 0 }
}`, ERROR).some((m) => /not exhaustive/i.test(m))).toBe(false);
  });
});
