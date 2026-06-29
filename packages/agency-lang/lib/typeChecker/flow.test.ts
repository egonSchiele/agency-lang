import { describe, it, expect } from "vitest";
import {
  referenceKey,
  uniteTypes,
  typeAt,
  applyRefine,
  wrapFacts,
  mergeFlows,
  widenAtLoopBackEdge,
  type FlowNode,
  type FlowEnvironment,
} from "./flow.js";
import { Scope } from "./scope.js";
import { NEVER_T } from "./primitives.js";
import type { VariableType } from "../types.js";

const STR: VariableType = { type: "primitiveType", value: "string" };
const NUM: VariableType = { type: "primitiveType", value: "number" };

describe("referenceKey", () => {
  it("is the bare variable for an empty chain", () => {
    expect(referenceKey({ variable: "x", chain: [] })).toBe("x");
  });
  it("dotted-joins a non-empty chain", () => {
    expect(referenceKey({ variable: "u", chain: ["profile", "email"] })).toBe("u.profile.email");
  });
});

describe("uniteTypes", () => {
  it("any dominates", () => {
    expect(uniteTypes(["any", STR], {})).toBe("any");
  });
  it("drops never members (identity element)", () => {
    expect(uniteTypes([NEVER_T, STR], {})).toEqual(STR);
  });
  it("an all-never (or empty) union is never", () => {
    expect(uniteTypes([NEVER_T, NEVER_T], {})).toEqual(NEVER_T);
    expect(uniteTypes([], {})).toEqual(NEVER_T);
  });
  it("dedupes structurally and unwraps a single member", () => {
    expect(uniteTypes([STR, STR], {})).toEqual(STR);
  });
  it("builds a union of distinct members", () => {
    expect(uniteTypes([STR, NUM], {})).toEqual({ type: "unionType", types: [STR, NUM] });
  });
  it("preserves literal members (does not widen to primitives)", () => {
    const litA: VariableType = { type: "stringLiteralType", value: "a" };
    const litB: VariableType = { type: "stringLiteralType", value: "b" };
    expect(uniteTypes([litA, litB], {})).toEqual({
      type: "unionType",
      types: [litA, litB],
    });
  });
});

function env(scope: Scope): FlowEnvironment {
  return { scope, flowOf: new WeakMap(), typeAliases: {}, memo: new WeakMap() };
}
const ref = (variable: string) => ({ variable, chain: [] as string[] });

// A discriminated union: { kind: "a", v: string } | { kind: "b", v: number }
const memberA: VariableType = {
  type: "objectType",
  properties: [
    { key: "kind", value: { type: "stringLiteralType", value: "a" } },
    { key: "v", value: STR },
  ],
};
const memberB: VariableType = {
  type: "objectType",
  properties: [
    { key: "kind", value: { type: "stringLiteralType", value: "b" } },
    { key: "v", value: NUM },
  ],
};
const ab: VariableType = { type: "unionType", types: [memberA, memberB] };

describe("applyRefine", () => {
  it("filters a union by a literal discriminant", () => {
    const refine = {
      kind: "discriminant" as const,
      prop: "kind",
      literal: { type: "stringLiteralType" as const, value: "a" },
      keep: true,
    };
    expect(applyRefine(ab, refine, {})).toEqual(memberA);
  });
});

describe("typeAt", () => {
  it("start: returns the scope type, or any for an unknown variable", () => {
    const scope = new Scope("t");
    scope.declare("x", STR);
    const start: FlowNode = { kind: "start", scope };
    expect(typeAt(ref("x"), start, env(scope))).toEqual(STR);
    expect(typeAt(ref("y"), start, env(scope))).toBe("any");
  });

  it("assign: overrides the matching reference only", () => {
    const scope = new Scope("t");
    scope.declare("x", STR);
    const start: FlowNode = { kind: "start", scope };
    const assign: FlowNode = { kind: "assign", prev: start, ref: ref("x"), type: NUM };
    expect(typeAt(ref("x"), assign, env(scope))).toEqual(NUM);
  });

  it("narrow: applies the refinement to the matching reference", () => {
    const scope = new Scope("t");
    scope.declare("u", ab);
    const start: FlowNode = { kind: "start", scope };
    const narrow: FlowNode = {
      kind: "narrow",
      prev: start,
      ref: ref("u"),
      refine: {
        kind: "discriminant",
        prop: "kind",
        literal: { type: "stringLiteralType", value: "a" },
        keep: true,
      },
    };
    expect(typeAt(ref("u"), narrow, env(scope))).toEqual(memberA);
  });

  it("narrow: any base is not narrowed", () => {
    const scope = new Scope("t"); // u undefined -> any
    const start: FlowNode = { kind: "start", scope };
    const narrow: FlowNode = {
      kind: "narrow",
      prev: start,
      ref: ref("u"),
      refine: {
        kind: "discriminant",
        prop: "kind",
        literal: { type: "stringLiteralType", value: "a" },
        keep: true,
      },
    };
    expect(typeAt(ref("u"), narrow, env(scope))).toBe("any");
  });

  it("join: unites the predecessors", () => {
    const scope = new Scope("t");
    scope.declare("x", STR);
    const start: FlowNode = { kind: "start", scope };
    const a: FlowNode = { kind: "assign", prev: start, ref: ref("x"), type: STR };
    const b: FlowNode = { kind: "assign", prev: start, ref: ref("x"), type: NUM };
    const join: FlowNode = { kind: "join", prev: [a, b] };
    expect(typeAt(ref("x"), join, env(scope))).toEqual({ type: "unionType", types: [STR, NUM] });
  });

  it("loop: a widened entry overrides, others fall through", () => {
    const scope = new Scope("t");
    scope.declare("x", STR);
    const start: FlowNode = { kind: "start", scope };
    const loop: FlowNode = { kind: "loop", prev: start, widened: { x: NUM } };
    expect(typeAt(ref("x"), loop, env(scope))).toEqual(NUM);
  });

  it("exit: throws (unreachable)", () => {
    const scope = new Scope("t");
    const exit: FlowNode = { kind: "exit" };
    expect(() => typeAt(ref("x"), exit, env(scope))).toThrow();
  });

  it("memoizes: repeated queries return the same result", () => {
    const scope = new Scope("t");
    scope.declare("x", STR);
    const start: FlowNode = { kind: "start", scope };
    const e = env(scope);
    expect(typeAt(ref("x"), start, e)).toEqual(STR);
    expect(typeAt(ref("x"), start, e)).toEqual(STR);
  });

  it("memo does not false-hit on a reserved-word ref (toString)", () => {
    // After caching one ref on a node, a query for a ref named "toString" must
    // not read Object.prototype.toString from a plain-object cache.
    const scope = new Scope("t");
    scope.declare("x", NUM);
    scope.declare("toString", STR);
    const start: FlowNode = { kind: "start", scope };
    const e = env(scope);
    typeAt(ref("x"), start, e); // populate the memo for `start`
    expect(typeAt(ref("toString"), start, e)).toEqual(STR);
  });

  it("loop widened lookup does not false-hit on a reserved-word ref", () => {
    // `widened` maps only "x"; a query for "toString" must fall through to the
    // predecessor, not read Object.prototype.toString.
    const scope = new Scope("t");
    scope.declare("x", STR);
    scope.declare("toString", NUM);
    const start: FlowNode = { kind: "start", scope };
    const loop: FlowNode = { kind: "loop", prev: start, widened: { x: STR } };
    expect(typeAt(ref("toString"), loop, env(scope))).toEqual(NUM);
  });
});

describe("wrapFacts", () => {
  it("returns the flow unchanged for no candidates", () => {
    const start: FlowNode = { kind: "start", scope: new Scope("t") };
    expect(wrapFacts(start, [])).toBe(start);
  });

  it("wraps one narrow node per candidate and narrows through it", () => {
    const scope = new Scope("t");
    scope.declare("u", ab);
    const start: FlowNode = { kind: "start", scope };
    const wrapped = wrapFacts(start, [
      {
        variableName: "u",
        refine: {
          kind: "discriminant",
          prop: "kind",
          literal: { type: "stringLiteralType", value: "a" },
          keep: true,
        },
      },
    ]);
    expect(wrapped.kind).toBe("narrow");
    expect(typeAt(ref("u"), wrapped, env(scope))).toEqual(memberA);
  });
});

describe("mergeFlows", () => {
  it("drops exit predecessors and returns the lone live flow", () => {
    const start: FlowNode = { kind: "start", scope: new Scope("t") };
    const exit: FlowNode = { kind: "exit" };
    expect(mergeFlows([exit, start])).toBe(start);
  });

  it("all-exit merges to exit (dead code after)", () => {
    expect(mergeFlows([{ kind: "exit" }, { kind: "exit" }])).toEqual({ kind: "exit" });
  });

  it("two live flows merge to a join", () => {
    // Real merges share a scope (both branches of one `if`). Use the same
    // Scope here to avoid suggesting cross-scope merges are valid.
    const scope = new Scope("t");
    const a: FlowNode = { kind: "start", scope };
    const b: FlowNode = { kind: "assign", prev: a, ref: ref("x"), type: STR };
    const merged = mergeFlows([a, b]);
    expect(merged.kind).toBe("join");
    if (merged.kind === "join") expect(merged.prev).toEqual([a, b]);
  });
});

describe("widenAtLoopBackEdge", () => {
  it("widens a var reassigned in the body to the union of before and after", () => {
    const scope = new Scope("t");
    scope.declare("x", STR);
    const loopEntry: FlowNode = { kind: "start", scope };
    const bodyEnd: FlowNode = { kind: "assign", prev: loopEntry, ref: ref("x"), type: NUM };
    const widened = widenAtLoopBackEdge(loopEntry, bodyEnd, ["x"], env(scope));
    expect(widened.kind).toBe("loop");
    expect(typeAt(ref("x"), widened, env(scope))).toEqual({ type: "unionType", types: [STR, NUM] });
  });

  it("passes an unchanged var through as its pre-loop type", () => {
    const scope = new Scope("t");
    scope.declare("x", STR);
    const loopEntry: FlowNode = { kind: "start", scope };
    const widened = widenAtLoopBackEdge(loopEntry, loopEntry, ["x"], env(scope));
    expect(typeAt(ref("x"), widened, env(scope))).toEqual(STR);
  });
});
