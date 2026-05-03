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

});
