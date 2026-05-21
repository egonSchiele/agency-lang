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
    valueParamNames: opts.valueParamNames,
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

  it("rejects ternary / binop", () => {
    const ternary = { type: "binOpExpression", op: "?" } as any;
    expect(validateJsonSchemaArg(ternary, scope()).ok).toBe(false);
    const binop = { type: "binOpExpression" } as any;
    expect(validateJsonSchemaArg(binop, scope()).ok).toBe(false);
  });

  it("accepts array literals of allowed items (e.g. enum lists)", () => {
    const arr = {
      type: "agencyArray",
      items: [
        { type: "string", segments: [{ type: "text", value: "a" }] },
        { type: "string", segments: [{ type: "text", value: "b" }] },
      ],
    } as any;
    expect(validateJsonSchemaArg(arr, scope()).ok).toBe(true);
  });

  it("rejects array literals whose items are disallowed", () => {
    const arr = {
      type: "agencyArray",
      items: [{ type: "binOpExpression" }],
    } as any;
    expect(validateJsonSchemaArg(arr, scope()).ok).toBe(false);
  });

  it("accepts regex and unit literals (post-substitution leaves)", () => {
    const re = { type: "regex", pattern: "abc", flags: "" } as any;
    expect(validateJsonSchemaArg(re, scope()).ok).toBe(true);
    const u = {
      type: "unitLiteral",
      value: "30",
      unit: "s",
      canonicalValue: 30000,
      dimension: "time",
    } as any;
    expect(validateJsonSchemaArg(u, scope()).ok).toBe(true);
  });

  it("accepts value-param identifiers when in scope", () => {
    const r = validateJsonSchemaArg(
      ident("low"),
      scope({ valueParamNames: new Set(["low", "high"]) }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects unbound value-param identifier when scope omits it", () => {
    const r = validateJsonSchemaArg(ident("low"), scope());
    expect(r.ok).toBe(false);
  });

  it("accepts PFA expression: foo.partial(n: 0)", () => {
    const pfa: Expression = {
      type: "valueAccess",
      base: ident("min"),
      chain: [
        {
          kind: "methodCall",
          functionCall: {
            type: "functionCall",
            functionName: "partial",
            arguments: [{ type: "namedArgument", name: "n", value: nm("0") }],
          },
        },
      ],
    } as any;
    const r = validateJsonSchemaArg(
      pfa,
      scope({ topLevelFunctionNames: new Set(["min"]) }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects PFA whose base is a function-call (must be a plain identifier)", () => {
    // `getMin(1).partial(n: 0)` — the receiver of `.partial(...)` is the
    // result of a runtime call. PFA must be rooted at a plain identifier
    // (a top-level validator or imported function), never at the result
    // of another call. This mirrors `_identOrPfaParser` in the parser.
    const pfa: Expression = {
      type: "valueAccess",
      base: {
        type: "functionCall",
        functionName: "getMin",
        arguments: [nm("1")],
      } as any,
      chain: [
        {
          kind: "methodCall",
          functionCall: {
            type: "functionCall",
            functionName: "partial",
            arguments: [{ type: "namedArgument", name: "n", value: nm("0") }],
          },
        },
      ],
    } as any;
    const r = validateJsonSchemaArg(
      pfa,
      scope({ topLevelFunctionNames: new Set(["getMin"]) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/PFA base must be a plain identifier/);
  });

  it("rejects bare valueAccess with only property accesses", () => {
    const expr: Expression = {
      type: "valueAccess",
      base: ident("foo"),
      chain: [{ kind: "property", name: "bar" }],
    } as any;
    const r = validateJsonSchemaArg(expr, scope());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/PFA expression/);
  });

  it("rejects string literals that contain interpolation segments", () => {
    const interpolated: Expression = {
      type: "string",
      segments: [
        { type: "text", value: "hello " },
        {
          type: "interpolation",
          expression: { type: "variableName", value: "name" } as any,
        },
      ],
    } as any;
    const r = validateJsonSchemaArg(interpolated, scope());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/plain literals|interpolation/i);
    }
  });
});
