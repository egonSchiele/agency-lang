import { describe, it, expect } from "vitest";
import { DestructiveTracking } from "./destructiveTracking.js";
import { NameClassifier } from "./nameClassifier.js";
import { buildCompilationUnit } from "../../compilationUnit.js";
import { parseAgency } from "../../parser.js";
import { printTs } from "../../ir/prettyPrint.js";
import type { AgencyNode } from "../../types.js";
import type { FunctionDefinition } from "../../types/function.js";
import type { ForLoop } from "../../types/forLoop.js";
import { ts } from "../../ir/builders.js";

function buildUnit(source: string) {
  const parsed = parseAgency(source, {}, false);
  if (!parsed.success) throw new Error(parsed.message ?? "parse failed");
  return { unit: buildCompilationUnit(parsed.result), program: parsed.result };
}

/** A tracker whose init()/exitStamp() (which read no deps) can be printed. */
function bareTracker() {
  const { unit } = buildUnit("node m() { return 1 }");
  return new DestructiveTracking(new NameClassifier(unit), {
    destructiveFunctions: {},
  });
}

/** Build a DestructiveTracking plus the parsed body of the named function. */
function setup(source: string, fnName: string) {
  const { unit, program } = buildUnit(source);
  const tracking = new DestructiveTracking(new NameClassifier(unit), unit);
  const fn = program.nodes.find(
    (n): n is FunctionDefinition => n.type === "function" && n.functionName === fnName,
  );
  if (!fn) throw new Error(`function ${fnName} not found`);
  return { tracking, body: fn.body };
}

const flips = (t: DestructiveTracking, stmt: AgencyNode, inDestructive: boolean) => {
  const { pre, post } = t.statementFlips(stmt, inDestructive);
  return {
    pre: pre ? printTs(pre).trim() : undefined,
    post: post ? printTs(post).trim() : undefined,
  };
};

describe("DestructiveTracking", () => {
  it("init(false) is the `?? false` default for a non-destructive function", () => {
    expect(printTs(bareTracker().init(false)).trim()).toBe(
      "__activation.__destructiveRan = __activation.__destructiveRan ?? false;",
    );
  });

  it("init(true) commits at entry for a `destructive def`", () => {
    expect(printTs(bareTracker().init(true)).trim()).toBe("__activation.__destructiveRan = true;");
  });

  it("markDestructiveRan() sets the flag true (destructive { } region entry)", () => {
    expect(printTs(bareTracker().markDestructiveRan()).trim()).toBe(
      "__activation.__destructiveRan = true;",
    );
  });

  it("exitStamp() folds the flag into the halt result, false when step 0 never set it", () => {
    expect(printTs(bareTracker().exitStamp()).trim()).toBe(
      "stampFailureBoundary(runner.haltResult, __activation.__destructiveRan ?? false)",
    );
  });

  it("an assignment bound to a destructive call gets the outcome-dependent POST flip (ternary parenthesized)", () => {
    const { tracking, body } = setup(
      `destructive def rm(p: string) { return 1 }\n` + `def caller() { const r = rm("x") }`,
      "caller",
    );
    const f = flips(tracking, body[0], false);
    expect(f.pre).toBeUndefined();
    // The ternary printer parenthesizes the ternary and each arm; the outer
    // group is what precedence needs (`||` binds tighter than `?:`).
    expect(f.post).toBe(
      "__activation.__destructiveRan = __activation.__destructiveRan || (isFailure(__self.r) ? (__self.r.destructiveRan) : (true));",
    );
  });

  it("a `try`-wrapped destructive call still gets the outcome POST flip", () => {
    const { tracking, body } = setup(
      `destructive def rm(p: string): Result { return failure("x") }\n` +
        `def caller(): Result { const r = try rm("x")\n  return r }`,
      "caller",
    );
    const f = flips(tracking, body[0], false);
    expect(f.pre).toBeUndefined();
    expect(f.post).toBe(
      "__activation.__destructiveRan = __activation.__destructiveRan || (isFailure(__self.r) ? (__self.r.destructiveRan) : (true));",
    );
  });

  it("a destructive call nested in an expression falls through to the conservative PRE flip", () => {
    // `wrap(rm(...))` is not a simple assignment-bound call, so
    // destructiveOutcomeVar returns null and the containsDestructiveCall
    // fallback fires the pre-flip. Pins the else-branch ordering.
    const { tracking, body } = setup(
      `destructive def rm(p: string): string { return p }\n` +
        `def wrap(s: string): string { return s }\n` +
        `def caller(): string { const r = wrap(rm("x"))\n  return r }`,
      "caller",
    );
    const f = flips(tracking, body[0], false);
    expect(f.pre).toBe("__activation.__destructiveRan = true;");
    expect(f.post).toBeUndefined();
  });

  it("a call to a function whose name is a prototype key is NOT treated as destructive", () => {
    // `toString` lives on Object.prototype; a truthy index read would
    // misclassify it. Object.hasOwn keeps it out of the destructive set.
    const { tracking, body } = setup(
      `def toString(): string { return "x" }\n` +
        `def caller(): string { const r = toString()\n  return r }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({
      pre: undefined,
      post: undefined,
    });
  });

  it("a bare destructive call (not assignment-bound) gets the conservative PRE flip", () => {
    const { tracking, body } = setup(
      `destructive def rm(p: string) { return 1 }\n` + `def caller() { rm("y") }`,
      "caller",
    );
    const f = flips(tracking, body[0], false);
    expect(f.pre).toBe("__activation.__destructiveRan = true;");
    expect(f.post).toBeUndefined();
  });

  it("a statement with no destructive call gets no flip", () => {
    const { tracking, body } = setup(
      `destructive def rm(p: string) { return 1 }\n` + `def caller() { const n = 1 }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({
      pre: undefined,
      post: undefined,
    });
  });

  it("inside a destructive function, no per-statement flips (commit is at entry)", () => {
    // A `destructive def` commits at entry via init(true); statementFlips emits
    // nothing per-statement, regardless of what the statement calls.
    const { tracking, body } = setup(
      `import { read } from "std::index"\n` + `destructive def burn() { const s = read("f") }`,
      "burn",
    );
    expect(flips(tracking, body[0], true)).toEqual({
      pre: undefined,
      post: undefined,
    });
  });

  // #1278: a compound statement leaves a destructive call in a nested body
  // to that body's own flips.
  const PRE = "__activation.__destructiveRan = true;";
  const RM = `destructive def rm(p: string): Result { return failure("x") }\n`;

  it("a loop whose body binds a destructive call to a local gets NO pre-flip (#1278)", () => {
    const { tracking, body } = setup(
      RM + `def caller(xs: string[]) { for (x in xs) { const r = rm(x) } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
  });

  it("an if whose branch binds a destructive call to a local gets NO pre-flip", () => {
    const { tracking, body } = setup(
      RM + `def caller(b: boolean) { if (b) { const r = rm("x") } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
  });

  it("a tracked assignment nested two bodies deep is still covered", () => {
    const { tracking, body } = setup(
      RM +
        `def caller(xs: string[], b: boolean) { for (x in xs) { if (b) { const r = try rm(x) } } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
  });

  it("a match arm that binds a destructive call to a local gets NO pre-flip", () => {
    const { tracking, body } = setup(
      RM + `def caller(s: string) { match (s) { "a" => { const r = rm(s) } } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
  });

  it("a thread whose body binds a destructive call to a local gets NO pre-flip", () => {
    const { tracking, body } = setup(
      RM + `def caller() { thread { const r = rm("x") } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
  });

  it("a block argument that binds a destructive call to a local gets NO pre-flip", () => {
    // `run() { ... }` as a bare call statement: bodySlots(functionCall) returns the block body.
    const { tracking, body } = setup(
      RM +
        `def run(block: () -> any): any { return block() }\n` +
        `def caller() { run() { const r = rm("x") } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
  });

  it("a tracked assignment under a `with` modifier gets NO pre-flip", () => {
    const { tracking, body } = setup(
      RM + `def caller() { const r = rm("x") with approve }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
  });

  it("a destructive call on the right of && in a nested if: the if gets the pre-flip, not the loop", () => {
    // Hoisting does not move a call out of the right side of &&, so this
    // shape reaches codegen as written.
    const { tracking, body } = setup(
      `destructive def burn(): number { return 1 }\n` +
        `def caller(xs: string[], b: boolean) { for (x in xs) { if (b && burn() > 0) { return 1 } } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false).pre).toBeUndefined();
    const loop = body[0] as ForLoop;
    expect(flips(tracking, loop.body[0], false).pre).toBe(PRE);
  });

  it("a destructive call in the statement's own condition gets the pre-flip", () => {
    const { tracking, body } = setup(
      `destructive def burn(): number { return 1 }\n` +
        `def caller(b: boolean) { if (b && burn() > 0) { return 1 } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false).pre).toBe(PRE);
  });

  it("a loop whose ITERABLE is a destructive call keeps the pre-flip (parse-level shape only)", () => {
    // In a real compile hoisting turns the iterable into `const __hoist_0 =
    // items()`, a tracked assignment, so codegen never sees this shape. The
    // test pins the function's answer for it anyway; it is not a guard.
    const { tracking, body } = setup(
      `destructive def items(): string[] { return [] }\n` +
        `def caller() { for (x in items()) { const n = 1 } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false).pre).toBe("__activation.__destructiveRan = true;");
  });

  it("a bare destructive call inside a loop body gets its own pre-flip, not the loop's", () => {
    const { tracking, body } = setup(
      RM + `def caller(xs: string[]) { for (x in xs) { rm(x) } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false).pre).toBeUndefined();
    const loop = body[0] as ForLoop;
    expect(flips(tracking, loop.body[0], false).pre).toBe(PRE);
  });

  it("a destructured assignment inside a loop body is covered", () => {
    // The parser lowers `const [a, b] = pair()` to `const __tmp_N = pair()`
    // plus element reads, so the call is a tracked assignment.
    const { tracking, body } = setup(
      `destructive def pair(): number[] { return [1, 2] }\n` +
        `def caller(xs: string[]) { for (x in xs) { const [a, b] = pair() } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
  });

  it("a tracked call whose try operand calls another destructive function gets both flips", () => {
    // A `try` operand is not hoisted, so `name()` stays inside the
    // statement and the post-flip only describes `rm`.
    const { tracking, body } = setup(
      RM +
        `destructive def name(): string { return "x" }\n` +
        `def caller() { const r = try rm(name()) }`,
      "caller",
    );
    const f = flips(tracking, body[0], false);
    expect(f.pre).toBe(PRE);
    expect(f.post).toContain("isFailure(__self.r)");
  });

  it("a value-position block argument with a tracked call gets NO pre-flip", () => {
    const { tracking, body } = setup(
      RM +
        `def run(block: () -> any): any { return block() }\n` +
        `def caller() { const y = run() { const r = rm("x") } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
  });

  it("a returned block argument with a tracked call gets NO pre-flip", () => {
    const { tracking, body } = setup(
      RM +
        `def run(block: () -> any): any { return block() }\n` +
        `def caller() { return run() { const r = rm("x") } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
  });

  it("a handle nested in a loop body: the handle carries its handler body's pre-flip, not the loop", () => {
    const { tracking, body } = setup(
      RM +
        `def caller(xs: string[]) { for (x in xs) { handle { return interrupt("go?") } with (intr) { const r = rm("x")\n  return reject() } } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false).pre).toBeUndefined();
    const loop = body[0] as ForLoop;
    expect(flips(tracking, loop.body[0], false).pre).toBe(PRE);
  });

  it("markOnThrow marks the activation on any throw but a run-control signal, then rethrows", () => {
    const { tracking } = setup(RM + `def caller() { const n = 1 }`, "caller");
    const printed = printTs(tracking.markOnThrow(ts.raw("work();")));
    expect(printed).toContain("try {");
    expect(printed).toContain("if (!(__error instanceof RunControlSignal)) {");
    expect(printed).toContain(PRE);
    expect(printed).toContain("throw __error");
  });

  it("nestedRoots names the nested statements a compound statement relies on", () => {
    const { tracking, body } = setup(
      RM + `def caller(xs: string[]) { for (x in xs) { const r = rm(x)\n  const n = 1 } }`,
      "caller",
    );
    const loop = body[0] as ForLoop;
    expect(tracking.nestedRoots(loop)).toEqual([loop.body[0]]);
  });

  it("a tracked assignment inside an inline handler body is NOT covered: the handle keeps the pre-flip", () => {
    const { tracking, body } = setup(
      RM +
        `def caller() { handle { return interrupt("go?") } with (intr) { const r = rm("x")\n  return reject() } }`,
      "caller",
    );
    expect(flips(tracking, body[0], false).pre).toBe("__activation.__destructiveRan = true;");
  });

  it("a tracked assignment in the handle BODY is covered", () => {
    const { tracking, body } = setup(
      RM + `def caller() { handle { const r = rm("x") } with approve }`,
      "caller",
    );
    expect(flips(tracking, body[0], false)).toEqual({ pre: undefined, post: undefined });
  });
});
