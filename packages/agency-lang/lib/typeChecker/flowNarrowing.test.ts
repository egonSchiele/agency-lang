import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import { walkNodes } from "../utils/node.js";
import type { AgencyProgram, AgencyNode } from "../types.js";

// Parse + full pipeline; returns errors AND the (post-check) result so tests
// can inspect ctx.flowEnv. The parsed program is returned too, so a test can
// grab the exact node objects the checker walked (identity guard).
function run(source: string): {
  errors: string[];
  result: ReturnType<typeof typeCheck>;
  program: AgencyProgram;
} {
  const parsed = parseAgency(source);
  if (!parsed.success) {
    throw new Error(`parse failed: ${parsed.message}`);
  }
  const info = buildCompilationUnit(parsed.result, undefined, undefined, source);
  const result = typeCheck(parsed.result, {}, info);
  return { errors: result.errors.map((e) => e.message), result, program: parsed.result };
}

const check = (source: string): string[] => run(source).errors;

describe("flow narrowing is consistent across passes (PR 2)", () => {
  const R = `type R = { kind: "a", v: string } | { kind: "b", v: number }`;

  it("a narrowed member access types precisely as a function argument", () => {
    // checkFunctionCallsInScope (Phase B) synths the arg; before PR 2 it used
    // the flat scope and saw `string | number`, mis-erroring against `string`.
    const errors = check(`
${R}
def takesString(s: string): void { }
def f(r: R): void {
  if (r.kind == "a") {
    takesString(r.v)
  }
}`);
    expect(errors).toEqual([]);
  });

  it("a narrowed member access types precisely as a return value", () => {
    // NOTE: g has an *annotated* return type, so this tests Phase B CHECKING,
    // not inference. Do not rewrite to an unannotated return and assert a
    // tightened inferred type — Phase A inference still uses scope.lookup
    // (flowEnv is unset during inferReturnTypes), so the inferred type stays
    // wide until PR 3. See "Notes for PR 3".
    const errors = check(`
${R}
def g(r: R): string {
  if (r.kind == "a") {
    return r.v
  }
  return "x"
}`);
    expect(errors).toEqual([]);
  });

  it("RHS of && sees the LHS narrowing", () => {
    // The right `r.v` is attached (1b) to a flow wrapped with the LHS
    // then-facts; before PR 2 the arg-check synths it flat → string | number.
    const errors = check(`
${R}
def takesStringReturnsBool(s: string): boolean { return true }
def h(r: R): void {
  let ok = r.kind == "a" && takesStringReturnsBool(r.v)
}`);
    expect(errors).toEqual([]);
  });
});

describe("flow graph identity + reassignment (PR 2 guards)", () => {
  const R = `type R = { kind: "a", v: string } | { kind: "b", v: number }`;

  it("GUARD: the flow graph is keyed on the AST nodes the checker sees", () => {
    // If a future AST rewrite between buildFlowGraphs and checkScopes breaks
    // node identity, narrowing silently falls back to scope.lookup — this fails
    // loudly instead. Grab the parsed `r` reference and assert it has a flow.
    const { result, program } = run(`
${R}
def f(r: R): void {
  if (r.kind == "a") {
    print(r.v)
  }
}`);
    let rRef: AgencyNode | undefined;
    for (const { node } of walkNodes(program.nodes)) {
      if (node.type === "variableName" && node.value === "r") {
        rRef = node;
      }
    }
    expect(rRef).toBeDefined();
    expect(result.flowEnv?.flowOf.get(rRef!)).toBeDefined();
  });

  it("PIN: a reassigned variable resolves to its declared type (no per-position)", () => {
    // assign nodes carry scope.lookup (the final declared type), so typeAt is
    // not flow-sensitive across reassignments yet. Pins current behavior; see
    // the reassigned-precision caveat in "Notes for PR 3".
    const errors = check(`
def f(): void {
  let x: number = 1
  x = 2
  let y: number = x
}`);
    expect(errors).toEqual([]);
  });
});

describe("strict equality narrows like loose equality (Gap D)", () => {
  const HEAD = `
type Sa = { tag: "a", payload: string }
type Sb = { tag: "b", payload: number }
type Su = Sa | Sb
def onlyA(a: Sa): string { return a.payload }
def wantNum(n: number): number { return n }`;

  // Discriminant path (the keepThen read).
  it("=== narrows the then-branch", () => {
    expect(
      check(`${HEAD}
def f(u: Su): string {
  if (u.tag === "a") {
    return onlyA(u)
  }
  return "y"
}
node main() {}`),
    ).toEqual([]);
  });

  it("!== narrows after an early return", () => {
    expect(
      check(`${HEAD}
def f(u: Su): string {
  if (u.tag !== "a") {
    return "y"
  }
  return onlyA(u)
}
node main() {}`),
    ).toEqual([]);
  });

  // Presence path (the presentThen read) — null comparisons take a different
  // branch inside the equality block, so these are not redundant with the
  // discriminant rows.
  it("=== null narrows via early return", () => {
    expect(
      check(`${HEAD}
def g(n: number | null): number {
  if (n === null) {
    return 0
  }
  return wantNum(n)
}
node main() {}`),
    ).toEqual([]);
  });

  it("!== null narrows the then-branch", () => {
    expect(
      check(`${HEAD}
def g(n: number | null): number {
  if (n !== null) {
    return wantNum(n)
  }
  return 0
}
node main() {}`),
    ).toEqual([]);
  });
});

describe("matchYield terminates flow within its match region (Gap C)", () => {
  const HEAD = `
effect app::halt { q: string }
type Rr = { kind: "ok", v: number } | { kind: "err", e: string }
type Ua = { tag: "a", s: string }
type Ub = { tag: "b", n: number }
type Uu = Ua | Ub
def mk(x: number): Rr { return { kind: "ok", v: x } }
def onlyA(a: Ua): string { return a.s }`;

  // Path 1: pure-literal expression match — survives as a matchBlock node,
  // arm bodies get matchYield where `return` was written.
  it("guard-then-access inside a literal expression arm", () => {
    expect(
      check(`${HEAD}
def f(x: number): number {
  return match("go") {
    "go" => {
      const r = mk(x)
      if (r.kind == "err") {
        return 0
      }
      return r.v
    }
    _ => 0
  }
}
node main() {}`),
    ).toEqual([]);
  });

  // Path 2: pattern arm — the whole match lowers to a matchExprId-tagged
  // if-chain; the arm body with its matchYields sits inside a chain branch.
  it("guard-then-access inside a lowered pattern arm", () => {
    expect(
      check(`${HEAD}
def f(u: Uu, x: number): number {
  return match(u) {
    { tag: "a" } => {
      const r = mk(x)
      if (r.kind == "err") {
        return 0
      }
      return r.v
    }
    _ => 0
  }
}
node main() {}`),
    ).toEqual([]);
  });

  // Region boundary pins: narrowing established BEFORE a fully-yielding
  // expression match must survive it. Every arm ends in a matchYield, so a
  // boundary-less "matchYield = exit" would drop or corrupt the post-match
  // flow here.
  it("post-match flow survives a literal expression match", () => {
    expect(
      check(`${HEAD}
def g(u: Uu): string {
  if (u.tag != "a") {
    return "no"
  }
  const n = match("k") {
    "k" => 1
    _ => 2
  }
  return onlyA(u)
}
node main() {}`),
    ).toEqual([]);
  });

  it("post-match flow survives a lowered pattern match", () => {
    expect(
      check(`${HEAD}
def h(u: Uu, w: Uu): string {
  if (u.tag != "a") {
    return "no"
  }
  const s = match(w) {
    { tag: "a" } => "x"
    _ => "y"
  }
  return onlyA(u)
}
node main() {}`),
    ).toEqual([]);
  });

  // Fix 1 × Fix 3 interaction: the match scrutinee IS the variable narrowed
  // before the match. After Fix 3 the lowered chain tests `u` itself; the
  // pre-match narrowing must still survive.
  it("post-match flow survives when the scrutinee is the narrowed variable", () => {
    expect(
      check(`${HEAD}
def k(u: Uu): string {
  if (u.tag != "a") {
    return "no"
  }
  const s = match(u) {
    { tag: "a" } => "x"
    _ => "y"
  }
  return onlyA(u)
}
node main() {}`),
    ).toEqual([]);
  });

  // alwaysExits misfire detector: alwaysExits is consulted for if BODIES, so
  // the top-level pins above never exercise it. If a fully-yielding lowered
  // chain ever counts as "always exits the function", factsAfterIf applies
  // then-negation after this if and the EXPECTED error below disappears.
  it("a fully-yielding match inside an if-branch is not a function exit", () => {
    const errs = check(`${HEAD}
def p(u: Uu, w: Uu): string {
  if (u.tag != "a") {
    const s = match(w) {
      { tag: "a" } => "x"
      _ => "y"
    }
    print(s)
  }
  return onlyA(u)
}
node main() {}`);
    expect(errs.some((m) => /not assignable/i.test(m))).toBe(true);
  });

  // May-resume convention, one lowering step down: a yielded interrupt can be
  // approved and fall through, so the then-branch is NOT an exit and `u` must
  // stay un-narrowed after the if — in an arm exactly as at function scope.
  it("an interrupt-carrying return in an arm keeps the may-resume convention", () => {
    const inArm = check(`${HEAD}
def f(u: Uu): string {
  return match("k") {
    "k" => {
      if (u.tag != "a") {
        return interrupt app::halt("m", { q: "x" })
      }
      return onlyA(u)
    }
    _ => "z"
  }
}
node main() {}`);
    const atFnScope = check(`${HEAD}
def f(u: Uu): string {
  if (u.tag != "a") {
    return interrupt app::halt("m", { q: "x" })
  }
  return onlyA(u)
}
node main() {}`);
    // Symmetry is the assertion: whatever the function-scope convention says,
    // the arm must say the same.
    expect(inArm.some((m) => /not assignable/i.test(m))).toBe(
      atFnScope.some((m) => /not assignable/i.test(m)),
    );
  });
});

describe("arm-body assignments invalidate pre-match narrowing", () => {
  const HEAD = `
type Ma = { tag: "a", s: string }
type Mb = { tag: "b", n: number }
type Mu = Ma | Mb
def onlyA(a: Ma): string { return a.s }`;

  // The write is in an ARM and the read is AFTER the match: a post-match flow
  // that discards what the arms did (an early "return the pre-match flow"
  // boundary) accepts this even though the arm set u to the other variant.
  it("a lowered pattern arm that reassigns invalidates post-match narrowing", () => {
    const errs = check(`${HEAD}
def f(w: Mu, x: Mu): string {
  let u: Mu = x
  if (u.tag != "a") {
    return "no"
  }
  const s = match(w) {
    { tag: "a" } => {
      u = { tag: "b", n: 1 }
      return "x"
    }
    _ => "y"
  }
  return onlyA(u)
}
node main() {}`);
    expect(errs.some((m) => /not assignable/i.test(m))).toBe(true);
  });

  it("a literal expression arm that reassigns invalidates post-match narrowing", () => {
    const errs = check(`${HEAD}
def f(k: string, x: Mu): string {
  let u: Mu = x
  if (u.tag != "a") {
    return "no"
  }
  const s = match(k) {
    "go" => {
      u = { tag: "b", n: 1 }
      return "x"
    }
    _ => "y"
  }
  return onlyA(u)
}
node main() {}`);
    expect(errs.some((m) => /not assignable/i.test(m))).toBe(true);
  });

  it("a statement-position literal arm that reassigns invalidates narrowing after the match", () => {
    const errs = check(`${HEAD}
def f(k: string, x: Mu): string {
  let u: Mu = x
  if (u.tag != "a") {
    return "no"
  }
  match(k) {
    "go" => { u = { tag: "b", n: 1 } }
    _ => 0
  }
  return onlyA(u)
}
node main() {}`);
    expect(errs.some((m) => /not assignable/i.test(m))).toBe(true);
  });
});
