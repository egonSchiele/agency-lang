import { describe, it, expect } from "vitest";
import {
  referenceKey,
  uniteTypes,
  typeAt,
  applyRefine,
  wrapFacts,
  mergeFlows,
  widenAtLoopBackEdge,
  flowHasNarrowFor,
  isPrefixOf,
  segKey,
  type FlowNode,
  type FlowEnvironment,
} from "./flow.js";
import { Scope } from "./scope.js";
import { NEVER_T } from "./primitives.js";
import type { VariableType } from "../types.js";
import type { PathSegment } from "./flow.js";

const STR: VariableType = { type: "primitiveType", value: "string" };
const NUM: VariableType = { type: "primitiveType", value: "number" };
const NUMA: VariableType = { type: "arrayType", elementType: NUM };

// Path-segment constructors (PathSegment[] replaced string[] chains in M2).
const prop = (name: string): PathSegment => ({ kind: "prop", name });
const idx = (index: number): PathSegment => ({ kind: "index", index });

describe("referenceKey", () => {
  it("is the bare variable for an empty chain", () => {
    expect(referenceKey({ variable: "x", chain: [] })).toBe("x");
  });
  it("dotted-joins a non-empty chain", () => {
    expect(referenceKey({ variable: "u", chain: [prop("profile"), prop("email")] })).toBe("u.profile.email");
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
const ref = (variable: string) => ({ variable, chain: [] as PathSegment[] });

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
        ref: { variable: "u", chain: [] },
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

// ── Property paths (M1) ─────────────────────────────────────────────────────
const RESULT: VariableType = { type: "resultType", successType: NUM, failureType: STR };
// box : { r: Result<number, string> }
const boxType: VariableType = { type: "objectType", properties: [{ key: "r", value: RESULT }] };
const pathRef = (variable: string, ...names: string[]) => ({ variable, chain: names.map(prop) });
const successRefine = {
  kind: "discriminant" as const,
  prop: "success",
  literal: { type: "booleanLiteralType" as const, value: "true" as const },
  keep: true,
};
const boxScope = () => {
  const s = new Scope("p");
  s.declare("box", boxType);
  return s;
};

describe("typeAt — property paths (M1)", () => {
  it("start: plain one-hop resolves to the property type (no narrowing)", () => {
    const s = boxScope();
    expect(typeAt(pathRef("box", "r"), { kind: "start", scope: s }, env(s))).toEqual(RESULT);
  });

  it("start: missing property → any", () => {
    const s = boxScope();
    expect(typeAt(pathRef("box", "bogus"), { kind: "start", scope: s }, env(s))).toBe("any");
  });

  it("start: non-object base → any (no primitive-member lookup)", () => {
    const s = new Scope("p");
    s.declare("str", STR);
    expect(typeAt(pathRef("str", "length"), { kind: "start", scope: s }, env(s))).toBe("any");
  });

  it("start: Record<K,V> base → V", () => {
    const s = new Scope("p");
    s.declare("m", { type: "genericType", name: "Record", typeArgs: [STR, NUM] });
    expect(typeAt(pathRef("m", "anyKey"), { kind: "start", scope: s }, env(s))).toEqual(NUM);
  });

  it("start: resolves through a type alias per hop", () => {
    const s = new Scope("p");
    s.declare("box", { type: "typeAliasVariable", aliasName: "Box" });
    const e: FlowEnvironment = {
      scope: s,
      flowOf: new WeakMap(),
      memo: new WeakMap(),
      typeAliases: { Box: { body: boxType } },
    };
    expect(typeAt(pathRef("box", "r"), { kind: "start", scope: s }, e)).toEqual(RESULT);
  });

  it("narrow: applies the refine to the one-hop path (structural assertion)", () => {
    const s = boxScope();
    const narrow: FlowNode = {
      kind: "narrow",
      prev: { kind: "start", scope: s },
      ref: pathRef("box", "r"),
      refine: successRefine,
    };
    const t = typeAt(pathRef("box", "r"), narrow, env(s));
    expect(typeof t === "object" && t.type).toBe("objectType");
    const succ = (t as { properties: { key: string; value: VariableType }[] }).properties.find((p) => p.key === "success");
    expect(succ?.value).toEqual({ type: "booleanLiteralType", value: "true" });
  });

  it("join: unites a narrowed-path predecessor with an un-narrowed one", () => {
    const s = boxScope();
    const start: FlowNode = { kind: "start", scope: s };
    const narrowed: FlowNode = { kind: "narrow", prev: start, ref: pathRef("box", "r"), refine: successRefine };
    const join: FlowNode = { kind: "join", prev: [narrowed, start] };
    const t = typeAt(pathRef("box", "r"), join, env(s));
    expect(typeof t === "object" && t.type).toBe("unionType");
  });
});

describe("typeAt — path prefix invalidation (M1)", () => {
  const narrowedBoxR = (s: Scope): FlowNode => ({
    kind: "narrow",
    prev: { kind: "start", scope: s },
    ref: pathRef("box", "r"),
    refine: successRefine,
  });

  it("reassigning the base var (box) drops the box.r narrowing → un-narrowed Result", () => {
    const s = boxScope();
    const reassigned: FlowNode = { kind: "assign", prev: narrowedBoxR(s), ref: pathRef("box"), type: boxType };
    const after = typeAt(pathRef("box", "r"), reassigned, env(s));
    // Pin to the SPECIFIC type: after reassigning box, box.r is the un-narrowed
    // Result (a resultType), not the success object member. A regression to "any"
    // would slip past a mere `!== before` check.
    expect(typeof after === "object" && after.type).toBe("resultType");
  });

  it("reassigning the path itself (box.r) drops its narrowing (exact-key branch)", () => {
    const s = boxScope();
    const reassigned: FlowNode = { kind: "assign", prev: narrowedBoxR(s), ref: pathRef("box", "r"), type: RESULT };
    expect(typeAt(pathRef("box", "r"), reassigned, env(s))).toEqual(RESULT);
  });

  it("sibling assignment (box.q) leaves box.r narrowed (the foot-gun)", () => {
    const s = boxScope();
    const assignSibling: FlowNode = { kind: "assign", prev: narrowedBoxR(s), ref: pathRef("box", "q"), type: NUM };
    const t = typeAt(pathRef("box", "r"), assignSibling, env(s));
    expect(typeof t === "object" && t.type).toBe("objectType");
  });

  it("disjoint variable assignment (other) leaves box.r narrowed", () => {
    const s = boxScope();
    s.declare("other", NUM);
    const assignOther: FlowNode = { kind: "assign", prev: narrowedBoxR(s), ref: pathRef("other"), type: STR };
    const t = typeAt(pathRef("box", "r"), assignOther, env(s));
    expect(typeof t === "object" && t.type).toBe("objectType");
  });

  it("multi-hop (M2-ready): reassigning box.r invalidates box.r.value", () => {
    const s = boxScope();
    // box.r narrowed to success; then box.r reassigned to a fresh Result.
    const reassigned: FlowNode = { kind: "assign", prev: narrowedBoxR(s), ref: pathRef("box", "r"), type: RESULT };
    // box.r.value re-resolves from the reassigned (un-narrowed) Result → success
    // member's `.value` is gone; structural resolve of `.value` on a resultType
    // is "any" (diagnostic-free resolvePath).
    expect(typeAt(pathRef("box", "r", "value"), reassigned, env(s))).toBe("any");
  });

  it("loop back-edge: a body reassign of the base re-resolves box.r from widened", () => {
    const s = boxScope();
    // Pre-loop narrowed; the loop body reassigned `box` (bare), so widened["box"]
    // holds the post-body box type. box.r must re-resolve from THAT, not trust
    // the pre-loop narrowed flow.
    const loop: FlowNode = { kind: "loop", prev: narrowedBoxR(s), widened: { box: boxType } };
    const after = typeAt(pathRef("box", "r"), loop, env(s));
    expect(typeof after === "object" && after.type).toBe("resultType");
  });

  it("an access-chain write (path-keyed assign) drops flowHasNarrowFor AND re-resolves typeAt", () => {
    // The flow LAYER already handles a path-keyed assign (referenceKey + isPrefixOf
    // are generic); Task 4 only makes flowBuilder EMIT this node for `box.r = …`.
    const s = boxScope();
    const write: FlowNode = { kind: "assign", prev: narrowedBoxR(s), ref: pathRef("box", "r"), type: RESULT };
    expect(flowHasNarrowFor(pathRef("box", "r"), write)).toBe(false);
    expect(typeAt(pathRef("box", "r"), write, env(s))).toEqual(RESULT);
  });
});

describe("flowHasNarrowFor (M1 strict gate)", () => {
  it("true when a narrow for the exact path applies", () => {
    const s = boxScope();
    const narrow: FlowNode = { kind: "narrow", prev: { kind: "start", scope: s }, ref: pathRef("box", "r"), refine: successRefine };
    expect(flowHasNarrowFor(pathRef("box", "r"), narrow)).toBe(true);
  });

  it("false at a plain start (no narrow on the path)", () => {
    const s = boxScope();
    expect(flowHasNarrowFor(pathRef("box", "r"), { kind: "start", scope: s })).toBe(false);
  });

  it("false after the base var is reassigned (prefix rebind resets it)", () => {
    const s = boxScope();
    const narrow: FlowNode = { kind: "narrow", prev: { kind: "start", scope: s }, ref: pathRef("box", "r"), refine: successRefine };
    const reassigned: FlowNode = { kind: "assign", prev: narrow, ref: pathRef("box"), type: boxType };
    expect(flowHasNarrowFor(pathRef("box", "r"), reassigned)).toBe(false);
  });

  it("true through a sibling assignment (box.q does not reset box.r)", () => {
    const s = boxScope();
    const narrow: FlowNode = { kind: "narrow", prev: { kind: "start", scope: s }, ref: pathRef("box", "r"), refine: successRefine };
    const sibling: FlowNode = { kind: "assign", prev: narrow, ref: pathRef("box", "q"), type: NUM };
    expect(flowHasNarrowFor(pathRef("box", "r"), sibling)).toBe(true);
  });

  it("requires the narrow on ALL join predecessors", () => {
    const s = boxScope();
    const start: FlowNode = { kind: "start", scope: s };
    const narrowed: FlowNode = { kind: "narrow", prev: start, ref: pathRef("box", "r"), refine: successRefine };
    expect(flowHasNarrowFor(pathRef("box", "r"), { kind: "join", prev: [narrowed, narrowed] })).toBe(true);
    expect(flowHasNarrowFor(pathRef("box", "r"), { kind: "join", prev: [narrowed, start] })).toBe(false);
  });
});

describe("isPrefixOf", () => {
  it("a proper same-variable chain prefix is a prefix", () => {
    expect(isPrefixOf(pathRef("box"), pathRef("box", "r"))).toBe(true);
    expect(isPrefixOf(pathRef("box", "r"), pathRef("box", "r", "value"))).toBe(true);
  });

  it("equal chains are NOT a (proper) prefix", () => {
    expect(isPrefixOf(pathRef("box", "r"), pathRef("box", "r"))).toBe(false);
  });

  it("different variables are never a prefix", () => {
    expect(isPrefixOf(pathRef("box"), pathRef("other", "r"))).toBe(false);
  });

  it("a diverging chain segment is not a prefix", () => {
    expect(isPrefixOf(pathRef("box", "q"), pathRef("box", "r", "value"))).toBe(false);
  });
});

describe("PathSegment helpers + index resolution (M2)", () => {
  it("referenceKey encodes property and index segments distinctly", () => {
    expect(referenceKey({ variable: "box", chain: [prop("r")] })).toBe("box.r");
    expect(referenceKey({ variable: "arr", chain: [idx(0)] })).toBe("arr.[0]");
    expect(referenceKey({ variable: "x", chain: [] })).toBe("x");
    expect(referenceKey({ variable: "m", chain: [prop("a"), idx(2), prop("b")] })).toBe("m.a.[2].b");
  });

  it("segKey distinguishes a numeric property from an index", () => {
    expect(segKey(prop("0"))).toBe("0");
    expect(segKey(idx(0))).toBe("[0]");
    expect(segKey(prop("0"))).not.toBe(segKey(idx(0)));
  });

  it("isPrefixOf compares segments structurally (prop vs index do not alias)", () => {
    expect(isPrefixOf({ variable: "arr", chain: [] }, { variable: "arr", chain: [idx(0)] })).toBe(true);
    expect(isPrefixOf({ variable: "arr", chain: [idx(0)] }, { variable: "arr", chain: [idx(0), prop("value")] })).toBe(true);
    expect(isPrefixOf({ variable: "arr", chain: [idx(0)] }, { variable: "arr", chain: [idx(1), prop("value")] })).toBe(false);
    expect(isPrefixOf({ variable: "arr", chain: [prop("0")] }, { variable: "arr", chain: [idx(0), prop("v")] })).toBe(false);
  });

  // resolvePath is module-private (declaredPathType is the public seam); exercise
  // it through typeAt's `start` case, which calls it for a non-empty chain.
  const startWith = (name: string, t: VariableType): FlowNode => {
    const s = new Scope("t");
    s.declare(name, t);
    return { kind: "start", scope: s };
  };
  const at = (variable: string, chain: PathSegment[], t: VariableType) =>
    typeAt({ variable, chain }, startWith(variable, t), env(startWithScope(variable, t)));
  const startWithScope = (name: string, t: VariableType): Scope => {
    const s = new Scope("t");
    s.declare(name, t);
    return s;
  };

  it("resolves an index segment into the array element type", () => {
    expect(at("arr", [idx(0)], NUMA)).toEqual(NUM);
    expect(at("arr", [idx(5)], NUMA)).toEqual(NUM); // any literal index → elementType
  });

  it("returns any for an index on a non-array, non-Record receiver", () => {
    expect(at("n", [idx(0)], NUM)).toBe("any");
  });

  it("resolves an index segment into a Record<K,V> value type", () => {
    const REC: VariableType = { type: "genericType", name: "Record", typeArgs: [STR, NUM] };
    expect(at("m", [idx(0)], REC)).toEqual(NUM);
  });

  it("returns any for an index hop into an objectType", () => {
    const OBJ: VariableType = { type: "objectType", properties: [{ key: "a", value: NUM }] };
    expect(at("o", [idx(0)], OBJ)).toBe("any");
  });

  it("assigning arr[0] invalidates arr[0] (index exact-key + element re-resolve)", () => {
    const s = new Scope("t");
    s.declare("arr", { type: "arrayType", elementType: RESULT });
    const start: FlowNode = { kind: "start", scope: s };
    const narrowed: FlowNode = { kind: "narrow", prev: start, ref: { variable: "arr", chain: [idx(0)] }, refine: successRefine };
    const reassigned: FlowNode = { kind: "assign", prev: narrowed, ref: { variable: "arr", chain: [idx(0)] }, type: RESULT };
    const after = typeAt({ variable: "arr", chain: [idx(0)] }, reassigned, env(s));
    expect(typeof after === "object" && after.type).toBe("resultType");
  });
});
