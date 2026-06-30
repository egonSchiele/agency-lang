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
  match (env) {
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
