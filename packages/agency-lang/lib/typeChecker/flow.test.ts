import { describe, it, expect } from "vitest";
import {
  referenceKey,
  uniteTypes,
  typeAt,
  applyRefine,
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
});
