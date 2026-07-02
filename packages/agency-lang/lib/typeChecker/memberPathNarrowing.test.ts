import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";

function check(source: string): string[] {
  const parsed = parseAgency(source);
  if (!parsed.success) throw new Error(`parse failed: ${parsed.message}`);
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  return typeCheck(parsed.result, {}, info).errors.map((e) => e.message);
}

const TRY = `
def tryParse(s: string): Result<number, string> {
  if (s == "ok") { return success(42) }
  return failure("bad")
}`;

describe("member-path scrutinee narrowing (M1)", () => {
  it("member-path Result guard narrows (no spurious strict-access error)", () => {
    expect(check(`${TRY}
type Box = { r: Result<number, string> }
def f(b: Box): void {
  if (isSuccess(b.r)) {
    let n: number = b.r.value
  }
}`)).toEqual([]);
  });

  it("nested object Result pattern narrows the binder (uses v in a numeric context)", () => {
    expect(check(`${TRY}
type Env = { result: Result<number, string> }
def takesNumber(n: number): number { return n }
def f(env: Env): number {
  return match (env) {
    { result: success(v) } => takesNumber(v)
    { result: failure(e) } => 0
  }
}`)).toEqual([]);
  });

  it("CRITICAL: un-narrowed member-path access STILL errors (gate doesn't over-suppress)", () => {
    expect(check(`${TRY}
type Box = { r: Result<number, string> }
def f(b: Box): void {
  let n: number = b.r.value
}`).some((m) => /only available on a success Result/.test(m))).toBe(true);
  });

  it("member-path discriminant narrows — positive AND negative", () => {
    const src = (body: string) => `
type Ev = { payload: { kind: "click", x: number } | { kind: "scroll", d: number } }
def takesNumber(n: number): void {}
def takesString(s: string): void {}
def f(e: Ev): void {
  if (e.payload.kind == "click") { ${body} }
}`;
    expect(check(src("takesNumber(e.payload.x)"))).toEqual([]);
    expect(check(src("takesString(e.payload.x)")).some((m) => /assignable/.test(m))).toBe(true);
  });

  it("member-path presence narrows", () => {
    expect(check(`
type Cfg = { timeout: number | null }
def f(c: Cfg): void {
  if (c.timeout != null) {
    let t: number = c.timeout
  }
}`)).toEqual([]);
  });

  it("member-path else-branch (isFailure else → success)", () => {
    expect(check(`${TRY}
type Box = { r: Result<number, string> }
def f(b: Box): void {
  if (isFailure(b.r)) {
  } else {
    let n: number = b.r.value
  }
}`)).toEqual([]);
  });

  it("member-path post-guard return (the major Result idiom)", () => {
    expect(check(`${TRY}
type Box = { r: Result<number, string> }
def f(b: Box): void {
  if (isFailure(b.r)) { return }
  let n: number = b.r.value
}`)).toEqual([]);
  });

  it("SOUNDNESS: reassigning the base drops the path narrowing — exactly one error", () => {
    const errs = check(`${TRY}
type Box = { r: Result<number, string> }
def other(): Box { return { r: failure("x") } }
def f(b: Box): void {
  if (isSuccess(b.r)) {
    b = other()
    let n: number = b.r.value
  }
}`);
    expect(errs.filter((m) => /only available on a success Result/.test(m)).length).toBe(1);
  });

  it("UNTYPED let infers narrowed member-path RHS without a false positive", () => {
    // Regression: an untyped `let` synthesizes its RHS during the pre-flow
    // scope-building pass (no flowEnv); strict access must stay silent there so
    // the flow-aware checkScopes pass is the single source of the diagnostic.
    expect(check(`${TRY}
type Box = { r: Result<number, string> }
def f(b: Box): void {
  if (isSuccess(b.r)) {
    let v = b.r.value
  }
}`)).toEqual([]);
  });

  it("CRITICAL: UNTYPED let with un-narrowed member-path access STILL errors", () => {
    // The pre-flow suppression must not hide genuine errors: checkScopes
    // re-synthesizes the access with flow and reports it.
    expect(check(`${TRY}
type Box = { r: Result<number, string> }
def f(b: Box): void {
  let v = b.r.value
}`).some((m) => /only available on a success Result/.test(m))).toBe(true);
  });

  it("bare-variable narrowing is unchanged", () => {
    expect(check(`${TRY}
node main() {
  let r = tryParse("ok")
  if (isSuccess(r)) { let n: number = r.value }
}`)).toEqual([]);
  });
});

describe("narrowing inside block bodies", () => {
  const BLOCKDEFS = `
def wrap(value: number, block: (number) => number): number { return block(value) }
def applyN(n: number, block: (number) => number): number { return block(n) }`;

  it("bare var narrows inside an expression-position trailing block", () => {
    expect(check(`${TRY}${BLOCKDEFS}
node main() {
  let r = tryParse("ok")
  if (isSuccess(r)) {
    let n: number = wrap(3) as value {
      let inner: number = r.value
      return inner
    }
  }
}`)).toEqual([]);
  });

  it("bare var narrows inside an inline block", () => {
    expect(check(`${TRY}${BLOCKDEFS}
node main() {
  let r = tryParse("ok")
  if (isSuccess(r)) {
    let n: number = applyN(3, \\x -> r.value)
  }
}`)).toEqual([]);
  });

  it("member path narrows inside an expression-position trailing block", () => {
    expect(check(`${TRY}${BLOCKDEFS}
type Box = { r: Result<number, string> }
def f(b: Box): void {
  if (isSuccess(b.r)) {
    let n: number = wrap(3) as value {
      let inner: number = b.r.value
      return inner
    }
  }
}`)).toEqual([]);
  });

  it("member path narrows inside an inline block", () => {
    expect(check(`${TRY}${BLOCKDEFS}
type Box = { r: Result<number, string> }
def f(b: Box): void {
  if (isSuccess(b.r)) {
    let n: number = applyN(3, \\x -> b.r.value)
  }
}`)).toEqual([]);
  });

  it("narrows inside an inline block passed as a named argument", () => {
    expect(check(`${TRY}${BLOCKDEFS}
node main() {
  let r = tryParse("ok")
  if (isSuccess(r)) {
    let n: number = applyN(n: 3, block: \\x -> r.value)
  }
}`)).toEqual([]);
  });

  it("a guard nested inside a block body narrows within the block", () => {
    expect(check(`${TRY}${BLOCKDEFS}
node main() {
  let r = tryParse("ok")
  let m: number = wrap(3) as value {
    if (isFailure(r)) {
      return 0
    } else {
      let inner: number = r.value
      return inner
    }
  }
}`)).toEqual([]);
  });

  it("statement-position block still narrows (no regression)", () => {
    expect(check(`${TRY}${BLOCKDEFS}
node main() {
  let r = tryParse("ok")
  if (isSuccess(r)) {
    wrap(3) as value {
      let inner: number = r.value
      return inner
    }
  }
}`)).toEqual([]);
  });

  it("reassignment inside a block body drops the narrowing (exactly one error)", () => {
    const errs = check(`${TRY}${BLOCKDEFS}
node main() {
  let r = tryParse("ok")
  let m: number = wrap(3) as value {
    if (isSuccess(r)) {
      r = failure("x")
      let inner: number = r.value
      return inner
    }
    return 0
  }
}`);
    expect(errs.filter((m) => /only available on a success Result/.test(m)).length).toBe(1);
  });

  it("CONTROL: un-guarded access inside a block still errors", () => {
    expect(check(`${TRY}${BLOCKDEFS}
node main() {
  let r = tryParse("ok")
  let n: number = wrap(3) as value {
    let inner: number = r.value
    return inner
  }
}`).some((m) => /only available on a success Result/.test(m))).toBe(true);
  });
});

describe("member-path scrutinee narrowing — multi-hop + index (M2)", () => {
  it("literal-index Result guard narrows (rs[0].value)", () => {
    expect(check(`${TRY}
def f(rs: Result<number, string>[]): void {
  if (isSuccess(rs[0])) {
    let n: number = rs[0].value
  }
}`)).toEqual([]);
  });

  it("HEADLINE: array-nested Result pattern narrows the binder", () => {
    expect(check(`${TRY}
def takesNumber(n: number): number { return n }
def f(pair: Result<number, string>[]): number {
  return match (pair) {
    [success(v), _] => takesNumber(v)
    _ => 0
  }
}`)).toEqual([]);
  });

  it("multi-hop property guard narrows (o.inner.r)", () => {
    expect(check(`${TRY}
type Inner = { r: Result<number, string> }
type Outer = { inner: Inner }
def f(o: Outer): void {
  if (isSuccess(o.inner.r)) {
    let n: number = o.inner.r.value
  }
}`)).toEqual([]);
  });

  it("CRITICAL: un-narrowed index access STILL errors", () => {
    expect(check(`${TRY}
def f(rs: Result<number, string>[]): void {
  let n: number = rs[0].value
}`).some((m) => /only available on a success Result/.test(m))).toBe(true);
  });

  it("index narrowing does not leak across indices (rs[0] guarded, rs[1] not)", () => {
    expect(check(`${TRY}
def f(rs: Result<number, string>[]): void {
  if (isSuccess(rs[0])) {
    let n: number = rs[1].value
  }
}`).some((m) => /only available on a success Result/.test(m))).toBe(true);
  });

  it("narrowing flows through a pipe operand (rs[0].value |> double)", () => {
    // `|>` yields a Result (auto-unwrap semantics), so we don't pin the binding
    // type — assert ONLY that the narrowed operand `rs[0].value` raised no
    // strict-access error (i.e. narrowing reached the pipe operand).
    expect(check(`${TRY}
def double(x: number): number { return x * 2 }
def f(rs: Result<number, string>[]): void {
  if (isSuccess(rs[0])) {
    let n = rs[0].value |> double
  }
}`).some((m) => /only available on a success Result/.test(m))).toBe(false);
  });

  it("narrowing flows into a trailing block body (… as value { rs[0].value })", () => {
    expect(check(`${TRY}
def wrap(value: number, block: (number) => number): number { return block(value) }
def f(rs: Result<number, string>[]): void {
  if (isSuccess(rs[0])) {
    let n: number = wrap(3) as value {
      let inner: number = rs[0].value
      return inner
    }
  }
}`)).toEqual([]);
  });

  it("LONGEST PREFIX: o.inner.r.value reads the longer (more precise) narrowing", () => {
    expect(check(`${TRY}
type In = { r: Result<number, string> }
type Out = { inner: In | null }
def f(o: Out): void {
  if (o.inner != null) {
    if (isSuccess(o.inner.r)) {
      let n: number = o.inner.r.value
    }
  }
}`)).toEqual([]);
  });

  it("BREAK-vs-NULL: a stable (multi-hop) prefix narrows under an unstable later hop", () => {
    // t.mid.item is narrowed (2-hop receiver discriminant); the access
    // t.mid.item.data[pick()] has an UNSTABLE trailing index. stablePrefix must
    // still yield [mid,item,data] (not null) so the narrowed t.mid.item prefix is
    // consulted and `.data` resolves on the ok member. Requires longest-prefix +
    // break-vs-null together.
    expect(check(`
type Item = { kind: "ok", data: number[] } | { kind: "err", msg: string }
type Mid = { item: Item }
type Top = { mid: Mid }
def pick(): number { return 0 }
def f(t: Top): void {
  if (t.mid.item.kind == "ok") {
    let n: number = t.mid.item.data[pick()]
  }
}`)).toEqual([]);
  });

  it("deeper multi-hop: isSuccess(x.a.b.c) narrows x.a.b.c.value", () => {
    expect(check(`${TRY}
type C = { c: Result<number, string> }
type B = { b: C }
type A = { a: B }
def f(x: A): void {
  if (isSuccess(x.a.b.c)) {
    let n: number = x.a.b.c.value
  }
}`)).toEqual([]);
  });

  it("discriminant on an index path: if (rs[0].kind == \"click\") narrows rs[0].x", () => {
    expect(check(`
type Ev = { kind: "click", x: number } | { kind: "scroll", d: number }
def takesNumber(n: number): void {}
def f(rs: Ev[]): void {
  if (rs[0].kind == "click") { takesNumber(rs[0].x) }
}`)).toEqual([]);
  });

  it("index else-branch (isFailure(rs[0]) else → success)", () => {
    expect(check(`${TRY}
def f(rs: Result<number, string>[]): void {
  if (isFailure(rs[0])) {
  } else {
    let n: number = rs[0].value
  }
}`)).toEqual([]);
  });

  it("index post-guard return (the major Result idiom)", () => {
    expect(check(`${TRY}
def f(rs: Result<number, string>[]): void {
  if (isFailure(rs[0])) { return }
  let n: number = rs[0].value
}`)).toEqual([]);
  });
});

describe("member-path scrutinee narrowing — write invalidation (M2 soundness)", () => {
  it("SOUNDNESS: mutating the path (b.r = …) drops the narrowing — exactly one error", () => {
    const errs = check(`${TRY}
type Box = { r: Result<number, string> }
def f(b: Box): void {
  if (isSuccess(b.r)) {
    b.r = failure("x")
    let n: number = b.r.value
  }
}`);
    expect(errs.filter((m) => /only available on a success Result/.test(m)).length).toBe(1);
  });

  it("SOUNDNESS: writing rs[0] = failure(…) drops rs[0] narrowing — exactly one error", () => {
    const errs = check(`${TRY}
def f(rs: Result<number, string>[]): void {
  if (isSuccess(rs[0])) {
    rs[0] = failure("x")
    let n: number = rs[0].value
  }
}`);
    expect(errs.filter((m) => /only available on a success Result/.test(m)).length).toBe(1);
  });

  it("SOUNDNESS: writing b.other = … keeps b.r narrowed (no spurious error)", () => {
    expect(check(`${TRY}
type Box = { r: Result<number, string>, other: number }
def f(b: Box): void {
  if (isSuccess(b.r)) {
    b.other = 5
    let n: number = b.r.value
  }
}`)).toEqual([]);
  });

  it("SOUNDNESS: writing b.inner = … drops the b.inner.r narrowing — exactly one error", () => {
    const errs = check(`${TRY}
type In = { r: Result<number, string> }
type Box = { inner: In }
def otherIn(): In { return { r: failure("x") } }
def f(b: Box): void {
  if (isSuccess(b.inner.r)) {
    b.inner = otherIn()
    let n: number = b.inner.r.value
  }
}`);
    expect(errs.filter((m) => /only available on a success Result/.test(m)).length).toBe(1);
  });

  it("SOUNDNESS: an unstable write target neither errors nor drops unrelated narrowing", () => {
    expect(check(`${TRY}
type Box = { r: Result<number, string>, xs: number[] }
def idx(): number { return 0 }
def f(b: Box): void {
  if (isSuccess(b.r)) {
    b.xs[idx()] = 9
    let n: number = b.r.value
  }
}`)).toEqual([]);
  });
});
