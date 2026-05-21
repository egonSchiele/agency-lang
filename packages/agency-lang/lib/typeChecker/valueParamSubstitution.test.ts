import { describe, expect, it } from "vitest";
import {
  applyValueArgs,
  substituteValueArgsInExpression,
  substituteValueArgsInTag,
  type ValueArgBindings,
} from "./valueParamSubstitution.js";
import type { Expression, Tag, TypeAliasEntry } from "../types.js";

const nm = (n: string): Expression =>
  ({ type: "number", value: n }) as any;
const sc = (s: string): Expression =>
  ({ type: "string", segments: [{ type: "text", value: s }] }) as any;
const ident = (name: string): Expression =>
  ({ type: "variableName", value: name }) as any;
const obj = (entries: any[]): Expression =>
  ({ type: "agencyObject", entries }) as any;
const kv = (key: string, value: Expression) => ({ key, value });
const splat = (value: Expression) => ({ type: "splat", value });
const fcall = (name: string, args: any[]): Expression =>
  ({ type: "functionCall", functionName: name, arguments: args }) as any;
const named = (name: string, value: Expression) => ({
  type: "namedArgument",
  name,
  value,
});
const va = (base: Expression, chain: any[]): Expression =>
  ({ type: "valueAccess", base, chain }) as any;
const methodCall = (name: string, args: any[]) => ({
  kind: "methodCall",
  functionCall: { type: "functionCall", functionName: name, arguments: args },
});

describe("substituteValueArgsInExpression", () => {
  it("replaces a bare value-param identifier with a clone of the bound expression", () => {
    const bindings: ValueArgBindings = { low: nm("0") };
    const out = substituteValueArgsInExpression(ident("low"), bindings);
    expect(out).toEqual(nm("0"));
    // Ensure clone, not same reference (otherwise a future mutation could leak).
    expect(out).not.toBe(bindings.low);
  });

  it("leaves identifiers not in bindings unchanged", () => {
    const e = ident("DEFAULT_AGE");
    const out = substituteValueArgsInExpression(e, { low: nm("0") });
    expect(out).toBe(e);
  });

  it("returns literals unchanged", () => {
    const a = nm("5");
    const b = sc("hello");
    expect(substituteValueArgsInExpression(a, { low: nm("0") })).toBe(a);
    expect(substituteValueArgsInExpression(b, { low: nm("0") })).toBe(b);
  });

  it("substitutes an identifier inside an object value", () => {
    const e = obj([kv("minimum", ident("low")), kv("format", sc("email"))]);
    const out = substituteValueArgsInExpression(e, { low: nm("0") });
    expect(out).toEqual(
      obj([kv("minimum", nm("0")), kv("format", sc("email"))]),
    );
  });

  it("substitutes an identifier inside a spread", () => {
    const e = obj([splat(ident("low"))]);
    const out = substituteValueArgsInExpression(e, { low: ident("other") });
    expect(out).toEqual(obj([splat(ident("other"))]));
  });

  it("substitutes an identifier inside a nested object", () => {
    const e = obj([
      kv(
        "outer",
        obj([kv("inner", ident("low")), kv("static", sc("k"))]),
      ),
    ]);
    const out = substituteValueArgsInExpression(e, { low: nm("42") });
    expect(out).toEqual(
      obj([
        kv("outer", obj([kv("inner", nm("42")), kv("static", sc("k"))])),
      ]),
    );
  });

  it("substitutes an identifier inside a PFA .partial(n: low) arg", () => {
    const e = va(ident("min"), [
      methodCall("partial", [named("n", ident("low"))]),
    ]);
    const out = substituteValueArgsInExpression(e, { low: nm("3") });
    expect(out).toEqual(
      va(ident("min"), [methodCall("partial", [named("n", nm("3"))])]),
    );
  });

  it("returns equal-but-not-same tree when no substitution applies", () => {
    const e = obj([kv("a", nm("1"))]);
    const out = substituteValueArgsInExpression(e, { unused: nm("0") });
    // structurally equal
    expect(out).toEqual(e);
  });

  it("does not mutate the input expression", () => {
    const inner = ident("low");
    const e = obj([kv("k", inner)]);
    const before = JSON.parse(JSON.stringify(e));
    substituteValueArgsInExpression(e, { low: nm("9") });
    expect(e).toEqual(before);
  });
});

describe("substituteValueArgsInTag", () => {
  it("replaces value-param identifiers in tag arguments", () => {
    const tag: Tag = {
      type: "tag",
      name: "jsonSchema",
      arguments: [obj([kv("minimum", ident("low")), kv("maximum", ident("high"))])],
    } as any;
    const out = substituteValueArgsInTag(tag, {
      low: nm("0"),
      high: nm("100"),
    });
    expect(out.arguments).toEqual([
      obj([kv("minimum", nm("0")), kv("maximum", nm("100"))]),
    ]);
    // Original untouched
    expect((tag.arguments[0] as any).entries[0].value).toEqual(ident("low"));
  });

  it("handles PFA validators with value-param refs in @validate", () => {
    const tag: Tag = {
      type: "tag",
      name: "validate",
      arguments: [
        va(ident("min"), [methodCall("partial", [named("n", ident("low"))])]),
        va(ident("max"), [methodCall("partial", [named("n", ident("high"))])]),
      ],
    } as any;
    const out = substituteValueArgsInTag(tag, {
      low: nm("0"),
      high: nm("150"),
    });
    expect(out.arguments).toEqual([
      va(ident("min"), [methodCall("partial", [named("n", nm("0"))])]),
      va(ident("max"), [methodCall("partial", [named("n", nm("150"))])]),
    ]);
  });
});

const numType = { type: "primitiveType", value: "number" } as any;
const strType = { type: "primitiveType", value: "string" } as any;

function entry(opts: {
  valueParams?: any[];
  tags?: Tag[];
}): TypeAliasEntry {
  return {
    body: numType,
    valueParams: opts.valueParams,
    tags: opts.tags,
  };
}

const jsonSchemaTag = (entries: any[]): Tag =>
  ({
    type: "tag",
    name: "jsonSchema",
    arguments: [obj(entries)],
  }) as any;

describe("applyValueArgs", () => {
  it("substitutes a single value-param into the alias's tags (happy path)", () => {
    const e = entry({
      valueParams: [{ name: "low", type: numType }],
      tags: [jsonSchemaTag([kv("minimum", ident("low"))])],
    });
    const out = applyValueArgs(e, [nm("0")], "Age");
    expect(out.tags).toEqual([
      jsonSchemaTag([kv("minimum", nm("0"))]),
    ]);
    // Original entry tags untouched
    expect(e.tags?.[0].arguments[0]).toEqual(
      obj([kv("minimum", ident("low"))]),
    );
  });

  it("fills missing tail args from defaults", () => {
    const e = entry({
      valueParams: [
        { name: "low", type: numType, default: nm("0") },
        { name: "high", type: numType, default: nm("150") },
      ],
      tags: [
        jsonSchemaTag([
          kv("minimum", ident("low")),
          kv("maximum", ident("high")),
        ]),
      ],
    });
    const out = applyValueArgs(e, [nm("18")], "Age");
    expect(out.tags).toEqual([
      jsonSchemaTag([kv("minimum", nm("18")), kv("maximum", nm("150"))]),
    ]);
  });

  it("uses all defaults when no args are passed", () => {
    const e = entry({
      valueParams: [{ name: "min", type: numType, default: nm("0") }],
      tags: [jsonSchemaTag([kv("minimum", ident("min"))])],
    });
    const out = applyValueArgs(e, [], "Age");
    expect(out.tags).toEqual([
      jsonSchemaTag([kv("minimum", nm("0"))]),
    ]);
  });

  it("errors on too many args", () => {
    const e = entry({
      valueParams: [{ name: "low", type: numType }],
    });
    expect(() => applyValueArgs(e, [nm("0"), nm("1")], "Age")).toThrow(
      /Age expects 1 value arguments, got 2/,
    );
  });

  it("errors when a required defaultless param is missing", () => {
    const e = entry({
      valueParams: [{ name: "low", type: numType }],
    });
    expect(() => applyValueArgs(e, [], "Age")).toThrow(
      /Age requires 'low': number/,
    );
  });

  it("errors on arg-type mismatch for literals", () => {
    const e = entry({
      valueParams: [{ name: "low", type: numType }],
    });
    expect(() => applyValueArgs(e, [sc("hi")], "Age")).toThrow(
      /argument low expected number, got string/,
    );
  });

  it("accepts non-literal args without trying to type-check", () => {
    const e = entry({
      valueParams: [{ name: "low", type: numType }],
      tags: [jsonSchemaTag([kv("minimum", ident("low"))])],
    });
    // Identifier — we can't infer its type, so we accept it.
    const out = applyValueArgs(e, [ident("DEFAULT_AGE")], "Age");
    expect(out.tags).toEqual([
      jsonSchemaTag([kv("minimum", ident("DEFAULT_AGE"))]),
    ]);
  });

  it("returns entry unchanged when alias has no tags", () => {
    const e = entry({ valueParams: [{ name: "low", type: numType }] });
    const out = applyValueArgs(e, [nm("0")], "Age");
    expect(out.tags).toEqual([]);
  });

  it("accepts string args matching declared string type", () => {
    const e = entry({
      valueParams: [{ name: "pat", type: strType }],
      tags: [jsonSchemaTag([kv("pattern", ident("pat"))])],
    });
    const out = applyValueArgs(e, [sc("[a-z]+")], "MatchesPattern");
    expect(out.tags).toEqual([
      jsonSchemaTag([kv("pattern", sc("[a-z]+"))]),
    ]);
  });
});
