import { describe, it, expect } from "vitest";
import { narrowUnionByPresence } from "./narrowing.js";
import { NULL_T, STRING_T, NUMBER_T } from "./primitives.js";
import type { VariableType } from "../types.js";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

const union = (...types: VariableType[]): VariableType => ({
  type: "unionType",
  types,
});

describe("narrowUnionByPresence", () => {
  const strOrNull = union(STRING_T, NULL_T);

  it("present: true strips the null member (string | null → string)", () => {
    expect(narrowUnionByPresence(strOrNull, true, {})).toEqual(STRING_T);
  });

  it("present: false keeps only null (string | null → null)", () => {
    expect(narrowUnionByPresence(strOrNull, false, {})).toEqual(NULL_T);
  });

  it("present: true on a 3-member union drops only null (string | number | null → string | number)", () => {
    expect(
      narrowUnionByPresence(union(STRING_T, NUMBER_T, NULL_T), true, {}),
    ).toEqual(union(STRING_T, NUMBER_T));
  });

  it("present: true with no null member → null (no narrowing)", () => {
    expect(narrowUnionByPresence(union(STRING_T, NUMBER_T), true, {})).toBeNull();
  });

  it("present: false with no null member → null (no narrowing, no narrow-to-never)", () => {
    expect(narrowUnionByPresence(union(STRING_T, NUMBER_T), false, {})).toBeNull();
  });

  it("non-union type → null (no narrowing)", () => {
    expect(narrowUnionByPresence(STRING_T, true, {})).toBeNull();
  });

  it("present: true on a union of only-null members → null (hits the empty-kept guard, no narrow-to-never)", () => {
    // All members are null; stripping them would leave `never`, so return null.
    // (NULL_T alone is a primitive, not a union, and bails at the first guard —
    // this exercises the `kept.length === 0` guard specifically.)
    expect(narrowUnionByPresence(union(NULL_T, NULL_T), true, {})).toBeNull();
  });
});

function check(source: string): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) {
    throw new Error(`parse failed: ${parsed.message}`);
  }
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, info).errors.map((e) => e.message);
}

describe("null / truthiness narrowing (e2e)", () => {
  it("if (x != null): strips null so x type-checks against string", () => {
    expect(check(`
def f(x: string | null): void {
  if (x != null) {
    let s: string = x
  }
}`)).toEqual([]);
  });

  it("if (x): truthiness strips null in the then-branch", () => {
    expect(check(`
def f(x: string | null): void {
  if (x) {
    let s: string = x
  }
}`)).toEqual([]);
  });

  it("SOUNDNESS: if (x) else-branch is NOT narrowed to null (falsy may be non-null)", () => {
    // The runtime uses JS truthiness, so a falsy `x: string | null` may be `""`,
    // not just `null`. Narrowing the else to `null` would be unsound, so x stays
    // `string | null` there — assigning it to a `null` annotation must error.
    const errs = check(`
def f(x: string | null): void {
  if (x) {
  } else {
    let n: null = x
  }
}`);
    expect(errs.some((e) => e.includes("not assignable"))).toBe(true);
  });

  it("SOUNDNESS: post-while(x) region is NOT narrowed to null", () => {
    // Symmetric to the else case: after `while (x)` exits, x is falsy (possibly
    // a non-null `""`), so it must NOT be narrowed to `null`.
    const errs = check(`
def f(x: string | null): void {
  while (x) {
  }
  let n: null = x
}`);
    expect(errs.some((e) => e.includes("not assignable"))).toBe(true);
  });

  it("if (x == null) else: the else-branch is narrowed to non-null", () => {
    expect(check(`
def f(x: string | null): void {
  if (x == null) {
  } else {
    let s: string = x
  }
}`)).toEqual([]);
  });

  it("if (x == null) / else: then narrows to null, else to string (both sides)", () => {
    // Pin the exact narrowed type on BOTH sides. `let s: null = x` in the
    // then-branch type-checks ONLY if x narrowed to null; `let t: string = x`
    // in the else ONLY if x narrowed to string.
    expect(check(`
def f(x: string | null): void {
  if (x == null) {
    let s: null = x
  } else {
    let t: string = x
  }
}`)).toEqual([]);
  });

  it("truthiness strips ONLY null, keeping every non-null member", () => {
    // `if (s)` strips the null member but keeps both literal members. If the impl
    // wrongly dropped a non-null member, `let t: "a" | "b" = s` would fail. (The
    // unit suite pins the same property structurally: `string | number | null`
    // narrows to `string | number`, not to a single member.)
    expect(check(`
def f(s: "a" | "b" | null): void {
  if (s) {
    let t: "a" | "b" = s
  }
}`)).toEqual([]);
  });

  it("non-optional value in if (x != null): no narrowing, no error (sound no-op)", () => {
    expect(check(`
def f(x: string): void {
  if (x != null) {
    let s: string = x
  }
}`)).toEqual([]);
  });

  it("non-optional value in if (x == null): x stays string, no narrow-to-never", () => {
    expect(check(`
def f(x: string): void {
  if (x == null) {
    let s: string = x
  }
}`)).toEqual([]);
  });

  it("&& composes: (x != null && other) narrows x in the then-branch", () => {
    expect(check(`
def f(x: string | null, other: boolean): void {
  if (x != null && other) {
    let s: string = x
  }
}`)).toEqual([]);
  });

  // (No `!` composition test: Agency's `!` does not prefix a parenthesized
  // comparison — `!(x == null)` is a parse error, and the natural negation of a
  // presence test is the opposite operator (`!=` vs `==`). The `!` combinator in
  // analyzeCondition is kind-agnostic and is already covered by the existing
  // Result narrowing tests via `!isSuccess(r)`.)

  it("|| composes: if (x == null || y == null) {} else {…} narrows both in else", () => {
    expect(check(`
def f(x: string | null, y: string | null): void {
  if (x == null || y == null) {
  } else {
    let s: string = x
    let t: string = y
  }
}`)).toEqual([]);
  });

  it("early return: code after if (x == null) { return } sees x as non-null", () => {
    expect(check(`
def f(x: string | null): void {
  if (x == null) {
    return
  }
  let s: string = x
}`)).toEqual([]);
  });

  it("reassignment inside the narrowed branch invalidates the narrowing", () => {
    // After x is rebound to string | null, the next read must NOT still see the
    // pre-assignment narrowed string.
    const errs = check(`
def lookup(): string | null { return null }
def f(x: string | null): void {
  if (x != null) {
    x = lookup()
    let s: string = x
  }
}`);
    expect(errs.some((e) => e.includes("not assignable"))).toBe(true);
  });

  it("aliased optional: type Maybe<T> = T | null narrows under if (x != null)", () => {
    expect(check(`
type Maybe<T> = T | null
def f(x: Maybe<string>): void {
  if (x != null) {
    let s: string = x
  }
}`)).toEqual([]);
  });

  it("object union with null: presence then discriminant compose", () => {
    expect(check(`
def f(x: { kind: "a", a: string } | { kind: "b", b: number } | null): void {
  if (x != null) {
    if (x.kind == "a") {
      let s: string = x.a
    } else {
      let n: number = x.b
    }
  }
}`)).toEqual([]);
  });

  it("nested presence guards narrow independently", () => {
    expect(check(`
def f(x: string | null, y: string | null): void {
  if (x != null) {
    if (y != null) {
      let s: string = x
      let t: string = y
    }
  }
}`)).toEqual([]);
  });
});
