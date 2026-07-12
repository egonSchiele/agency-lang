import { ANY_T } from "./primitives.js";
import { describe, it, expect } from "vitest";
import { Scope } from "./scope.js";
import type { VariableType } from "../types.js";

const numberType: VariableType = { type: "primitiveType", value: "number" };
const stringType: VariableType = { type: "primitiveType", value: "string" };

describe("Scope", () => {
  it("declares and looks up a variable in the same scope", () => {
    const scope = new Scope("function:foo");
    scope.declare("x", numberType);
    expect(scope.lookup("x")).toEqual(numberType);
  });

  it("returns undefined for an unknown variable", () => {
    const scope = new Scope("function:foo");
    expect(scope.lookup("missing")).toBeUndefined();
  });

  it("looks up variables from a parent scope through child().lookup()", () => {
    const parent = new Scope("function:foo");
    parent.declare("x", numberType);
    const child = parent.child();
    expect(child.lookup("x")).toEqual(numberType);
  });

  it("declare() on a child writes to the nearest function scope (function-scoped semantics)", () => {
    const parent = new Scope("function:foo");
    const child = parent.child();
    child.declare("y", stringType);
    expect(parent.lookup("y")).toEqual(stringType);
    expect(child.lookup("y")).toEqual(stringType);
  });

  it("has() reports presence including inherited bindings", () => {
    const parent = new Scope("function:foo");
    parent.declare("x", numberType);
    const child = parent.child();
    expect(child.has("x")).toBe(true);
    expect(child.has("missing")).toBe(false);
  });

  it("exposes the current scope key for type-alias resolution", () => {
    const scope = new Scope("function:foo");
    expect(scope.key).toBe("function:foo");
    const child = scope.child("block:if");
    expect(child.key).toBe("block:if");
  });

  it("isConst reflects whether a binding was declared as const", () => {
    const scope = new Scope("function:foo");
    scope.declare("c", numberType, true);
    scope.declare("v", numberType, false);
    scope.declare("d", numberType);
    expect(scope.isConst("c")).toBe(true);
    expect(scope.isConst("v")).toBe(false);
    expect(scope.isConst("d")).toBe(false);
    expect(scope.isConst("missing")).toBe(false);
  });

  it("isConst inherits from parent scopes", () => {
    const parent = new Scope("function:foo");
    parent.declare("c", numberType, true);
    const child = parent.child();
    expect(child.isConst("c")).toBe(true);
  });

  it("treats '__proto__' as an ordinary variable name", () => {
    // With a plain `{}` backing map, `vars["__proto__"] = <object>` would
    // invoke the prototype setter instead of storing a binding — the binding
    // is lost and the map's prototype is mutated.
    const scope = new Scope("function:foo");
    const objType: VariableType = {
      type: "objectType",
      fields: [],
    } as unknown as VariableType;
    scope.declare("__proto__", objType, true);
    expect(scope.lookup("__proto__")).toEqual(objType);
    expect(scope.isConst("__proto__")).toBe(true);
    // Unrelated lookups are unaffected by the declaration.
    expect(scope.lookup("toString")).toBeUndefined();
  });
});

describe("generation counter", () => {
  it("declare bumps the tree-wide generation, readable from any scope", () => {
    const root = new Scope("global");
    const fn = new Scope("fn", root, true);
    const g0 = fn.currentGeneration();
    fn.declare("x", ANY_T);
    expect(fn.currentGeneration()).toBe(g0 + 1);
    expect(root.currentGeneration()).toBe(g0 + 1);
  });

  it("re-declaring the same name and type still bumps", () => {
    // computeMatchExprTypes phase 2 re-declares consumers with a type that can
    // equal the existing entry; the paired assign-node patch relies on the
    // bump regardless. Pins against a skip-if-unchanged "optimization".
    const fn = new Scope("fn");
    fn.declare("x", ANY_T);
    const g0 = fn.currentGeneration();
    fn.declare("x", ANY_T);
    expect(fn.currentGeneration()).toBe(g0 + 1);
  });

  it("declareLocal on a detached child() scope does not bump", () => {
    const fn = new Scope("fn");
    const child = fn.child();
    expect(child.detached).toBe(true);
    const g0 = fn.currentGeneration();
    child.declareLocal("cbParam", ANY_T);
    expect(fn.currentGeneration()).toBe(g0);
  });

  it("declareLocal through a NESTED detached chain does not bump", () => {
    // walkWithNarrowing nests children per nested if — chains are real.
    const fn = new Scope("fn");
    const grandchild = fn.child().child();
    const g0 = fn.currentGeneration();
    grandchild.declareLocal("cbParam", ANY_T);
    expect(fn.currentGeneration()).toBe(g0);
  });

  it("declare from a detached child bumps (delegates to the function scope)", () => {
    const fn = new Scope("fn");
    const child = fn.child();
    const g0 = fn.currentGeneration();
    child.declare("real", ANY_T);
    expect(fn.currentGeneration()).toBe(g0 + 1);
  });

  it("declare through a NESTED detached chain bumps", () => {
    const fn = new Scope("fn");
    const grandchild = fn.child().child();
    const g0 = fn.currentGeneration();
    grandchild.declare("real", ANY_T);
    expect(fn.currentGeneration()).toBe(g0 + 1);
  });

  it("declareLocal on an attached scope bumps", () => {
    const fn = new Scope("fn");
    const g0 = fn.currentGeneration();
    fn.declareLocal("x", ANY_T);
    expect(fn.currentGeneration()).toBe(g0 + 1);
  });
});
