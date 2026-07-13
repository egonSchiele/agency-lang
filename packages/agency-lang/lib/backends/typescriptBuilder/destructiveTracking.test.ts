import { describe, it, expect } from "vitest";
import { DestructiveTracking } from "./destructiveTracking.js";
import { NameClassifier } from "./nameClassifier.js";
import { buildCompilationUnit } from "../../compilationUnit.js";
import { parseAgency } from "../../parser.js";
import { printTs } from "../../ir/prettyPrint.js";
import type { AgencyNode } from "../../types.js";
import type { FunctionDefinition } from "../../types/function.js";

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
    (n): n is FunctionDefinition =>
      n.type === "function" && n.functionName === fnName,
  );
  if (!fn) throw new Error(`function ${fnName} not found`);
  return { tracking, body: fn.body };
}

const flips = (
  t: DestructiveTracking,
  stmt: AgencyNode,
  inDestructive: boolean,
) => {
  const { pre, post } = t.statementFlips(stmt, inDestructive);
  return {
    pre: pre ? printTs(pre).trim() : undefined,
    post: post ? printTs(post).trim() : undefined,
  };
};

describe("DestructiveTracking", () => {
  it("init(false) is the `?? false` default for a non-destructive function", () => {
    expect(printTs(bareTracker().init(false)).trim()).toBe(
      "__self.__destructiveRan = __self.__destructiveRan ?? false;",
    );
  });

  it("init(true) commits at entry for a `destructive def`", () => {
    expect(printTs(bareTracker().init(true)).trim()).toBe(
      "__self.__destructiveRan = true;",
    );
  });

  it("blockEntryFlip() sets the flag true (destructive { } region entry)", () => {
    expect(printTs(bareTracker().blockEntryFlip()).trim()).toBe(
      "__self.__destructiveRan = true;",
    );
  });

  it("exitStamp() folds the flag into the halt result", () => {
    expect(printTs(bareTracker().exitStamp()).trim()).toBe(
      "stampFailureBoundary(runner.haltResult, __self.__destructiveRan)",
    );
  });

  it("an assignment bound to a destructive call gets the outcome-dependent POST flip (ternary parenthesized)", () => {
    const { tracking, body } = setup(
      `destructive def rm(p: string) { return 1 }\n` +
        `def caller() { const r = rm("x") }`,
      "caller",
    );
    const f = flips(tracking, body[0], false);
    expect(f.pre).toBeUndefined();
    // The ternary printer parenthesizes the ternary and each arm; the outer
    // group is what precedence needs (`||` binds tighter than `?:`).
    expect(f.post).toBe(
      "__self.__destructiveRan = __self.__destructiveRan || (isFailure(__self.r) ? (__self.r.destructiveRan) : (true));",
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
      "__self.__destructiveRan = __self.__destructiveRan || (isFailure(__self.r) ? (__self.r.destructiveRan) : (true));",
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
    expect(f.pre).toBe("__self.__destructiveRan = true;");
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
      `destructive def rm(p: string) { return 1 }\n` +
        `def caller() { rm("y") }`,
      "caller",
    );
    const f = flips(tracking, body[0], false);
    expect(f.pre).toBe("__self.__destructiveRan = true;");
    expect(f.post).toBeUndefined();
  });

  it("a statement with no destructive call gets no flip", () => {
    const { tracking, body } = setup(
      `destructive def rm(p: string) { return 1 }\n` +
        `def caller() { const n = 1 }`,
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
      `import { read } from "std::index"\n` +
        `destructive def burn() { const s = read("f") }`,
      "burn",
    );
    expect(flips(tracking, body[0], true)).toEqual({
      pre: undefined,
      post: undefined,
    });
  });
});
