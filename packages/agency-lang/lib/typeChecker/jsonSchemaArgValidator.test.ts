import { describe, expect, it } from "vitest";
import {
  validateJsonSchemaArg,
  type JsonSchemaArgScope,
} from "./jsonSchemaArgValidator.js";
import type { Expression } from "../types.js";

function scope(opts: Partial<JsonSchemaArgScope> = {}): JsonSchemaArgScope {
  return {
    topLevelConstNames: opts.topLevelConstNames ?? new Set(),
    importedNames: opts.importedNames ?? new Set(),
    topLevelFunctionNames: opts.topLevelFunctionNames ?? new Set(),
  };
}

const sc = (s: string): Expression => ({ type: "string", segments: [{ type: "text", value: s }] }) as any;
const nm = (n: string): Expression => ({ type: "number", value: n }) as any;
const bool = (b: boolean): Expression => ({ type: "boolean", value: b }) as any;
const nullLit = (): Expression => ({ type: "null" }) as any;
const ident = (name: string): Expression => ({ type: "variableName", value: name }) as any;
const obj = (entries: any[]): Expression =>
  ({ type: "agencyObject", entries }) as any;
const fcall = (name: string, args: Expression[]): Expression =>
  ({ type: "functionCall", functionName: name, arguments: args }) as any;
const splat = (value: Expression) => ({ type: "splat", value });

describe("validateJsonSchemaArg", () => {
  it("accepts string literal", () => {
    expect(validateJsonSchemaArg(sc("email"), scope()).ok).toBe(true);
  });

  it("accepts number / boolean / null", () => {
    expect(validateJsonSchemaArg(nm("0"), scope()).ok).toBe(true);
    expect(validateJsonSchemaArg(bool(true), scope()).ok).toBe(true);
    expect(validateJsonSchemaArg(nullLit(), scope()).ok).toBe(true);
  });

  it("accepts a plain object literal of allowed values", () => {
    const e = obj([{ key: "format", value: sc("email") }, { key: "minimum", value: nm("0") }]);
    expect(validateJsonSchemaArg(e, scope()).ok).toBe(true);
  });

  it("rejects identifier not bound to a const / import", () => {
    const r = validateJsonSchemaArg(ident("someLet"), scope());
    expect(r.ok).toBe(false);
  });

  it("accepts identifier bound to a top-level const", () => {
    const r = validateJsonSchemaArg(
      ident("emailFormat"),
      scope({ topLevelConstNames: new Set(["emailFormat"]) }),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts identifier bound to an imported name", () => {
    const r = validateJsonSchemaArg(
      ident("emailFormat"),
      scope({ importedNames: new Set(["emailFormat"]) }),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts function call to a top-level def", () => {
    const r = validateJsonSchemaArg(
      fcall("minimum", [nm("0")]),
      scope({ topLevelFunctionNames: new Set(["minimum"]) }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects function call to an unknown name", () => {
    const r = validateJsonSchemaArg(fcall("mystery", [nm("0")]), scope());
    expect(r.ok).toBe(false);
  });

  it("rejects function call whose argument is forbidden", () => {
    // Pretend "x" is not const-bound — argument is rejected before checking the call.
    const r = validateJsonSchemaArg(
      fcall("min", [ident("x")]),
      scope({ topLevelFunctionNames: new Set(["min"]) }),
    );
    expect(r.ok).toBe(false);
  });

  it("accepts a spread entry that points to an allowed expression", () => {
    const e = obj([splat(ident("emailFormat"))]);
    const r = validateJsonSchemaArg(
      e,
      scope({ topLevelConstNames: new Set(["emailFormat"]) }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects ternary / binop / template / array literal", () => {
    const ternary = { type: "binOpExpression", op: "?" } as any;
    expect(validateJsonSchemaArg(ternary, scope()).ok).toBe(false);
    const binop = { type: "binOpExpression" } as any;
    expect(validateJsonSchemaArg(binop, scope()).ok).toBe(false);
    const arr = { type: "agencyArray", items: [] } as any;
    expect(validateJsonSchemaArg(arr, scope()).ok).toBe(false);
  });
});
