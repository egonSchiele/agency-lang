import { describe, it, expect } from "vitest";
import { variableTypeParser } from "../parsers/parsers.js";
import {
  VALID_CALLBACK_NAMES,
  callerSuppliedParameters,
  decoratorShapeProblem,
  isDecoratorDef,
  isDecoratorMissingKeyword,
  orderCheckedParameters,
  recordSlotName,
  requiredParameterAfterDefault,
  withDecoratorTypes,
  type AliasResolver,
  type Decoratable,
  type FunctionParameter,
} from "./function.js";

describe("VALID_CALLBACK_NAMES", () => {
  it("includes the LLM resilience hooks so the runtime accepts them", () => {
    // lib/stdlib/agency.ts validates callback("...") names against this list at
    // runtime; a name not here throws "Unknown callback". hooks.ts also has a
    // compile-time guard keeping this list in sync with CallbackMap.
    expect(VALID_CALLBACK_NAMES).toContain("onLLMRetry");
    expect(VALID_CALLBACK_NAMES).toContain("onLLMTimeout");
  });
});

const typeOf = (text: string) => {
  const parsed = variableTypeParser(text);
  if (!parsed.success) {
    throw new Error(`cannot parse type ${text}`);
  }
  return parsed.result;
};
const param = (name: string, extra: Partial<FunctionParameter> = {}): FunctionParameter => ({
  type: "functionParameter",
  name,
  ...extra,
});
const blockParam = (name = "block") => param(name, { typeHint: typeOf("(args: object) -> any") });
const decorator = (parameters: FunctionParameter[]): Decoratable => ({
  parameters,
  markers: { decorator: true },
});

describe("isDecoratorDef", () => {
  it("is the marker and nothing else", () => {
    expect(isDecoratorDef(decorator([]))).toBe(true);
    expect(isDecoratorDef({ parameters: [param("call"), blockParam()] })).toBe(false);
  });
});

describe("recordSlotName", () => {
  it("is the second-to-last parameter, or call when there is no such slot", () => {
    expect(recordSlotName([param("tag"), param("ctx"), blockParam()])).toBe("ctx");
    expect(recordSlotName([blockParam()])).toBe("call");
  });
});

describe("decoratorShapeProblem", () => {
  it("accepts your args, then an untyped record slot, then a block", () => {
    expect(decoratorShapeProblem([param("tag"), param("call"), blockParam()])).toBeNull();
  });

  it("accepts any names and an untyped block", () => {
    expect(decoratorShapeProblem([param("ctx"), param("body")])).toBeNull();
  });

  it("accepts Call and any on the record slot", () => {
    const typedCall = param("call", { typeHint: typeOf("Call") });
    const anyCall = param("call", { typeHint: typeOf("any") });
    expect(decoratorShapeProblem([typedCall, blockParam()])).toBeNull();
    expect(decoratorShapeProblem([anyCall, blockParam()])).toBeNull();
  });

  it("follows an alias to Call, and refuses a Call that is not the prelude's", () => {
    const aliases: Record<string, string> = {
      Ctx: "Call",
      Twice: "Ctx",
      Call: "{ name: string, args: object, id: string, inToolCall: boolean }",
    };
    const resolve: AliasResolver = (name) =>
      aliases[name] === undefined ? undefined : typeOf(aliases[name]);
    const slot = (type: string) => [param("call", { typeHint: typeOf(type) }), blockParam()];
    expect(decoratorShapeProblem(slot("Ctx"), resolve)).toBeNull();
    expect(decoratorShapeProblem(slot("Twice"), resolve)).toBeNull();
    expect(decoratorShapeProblem(slot("Call"), resolve)).toBeNull();
    expect(decoratorShapeProblem(slot(aliases.Call), resolve)).toBeNull();
    // Without a resolver only the name is known, and `Call` is the prelude's.
    expect(decoratorShapeProblem(slot("Call"))).toBeNull();
    expect(decoratorShapeProblem(slot("Ctx"))).toContain("must be `Call` or left off");
    // A file that redefines Call types the slot against a record it never gets.
    const redefined: AliasResolver = (name) =>
      name === "Call" ? typeOf("{ foo: number }") : undefined;
    expect(decoratorShapeProblem(slot("Call"), redefined)).toContain("must be `Call`");
    // An alias loop is not Call.
    const loop: AliasResolver = (name) => typeOf(name === "A" ? "B" : "A");
    expect(decoratorShapeProblem(slot("A"), loop)).toContain("must be `Call`");
  });

  it("needs two parameters", () => {
    expect(decoratorShapeProblem([blockParam()])).toBe(
      "a decorator takes at least two parameters: the call record and the body as a block.",
    );
  });

  it("needs a block last", () => {
    const params = [param("call"), param("x", { typeHint: typeOf("number") })];
    expect(decoratorShapeProblem(params)).toBe(
      "its last parameter must take the body as a block, such as `block: (args: object) -> any`. Found 'x: number'.",
    );
  });

  it("refuses a record slot typed as anything but Call or any", () => {
    const params = [
      param("call", { typeHint: typeOf("Call") }),
      param("tag", { typeHint: typeOf("string") }),
      blockParam(),
    ];
    expect(decoratorShapeProblem(params)).toBe(
      "'tag' receives the call record, so its type must be `Call` or left off.",
    );
  });

  it("refuses a default on either slot", () => {
    const nullLiteral = { type: "null" } as FunctionParameter["defaultValue"];
    const defaulted = { ...blockParam(), defaultValue: nullLiteral };
    expect(decoratorShapeProblem([param("call"), defaulted])).toBe(
      "'block' has a default, and a decorator always receives the call record and the block. Remove the default.",
    );
  });

  it("refuses a variadic slot", () => {
    expect(decoratorShapeProblem([param("call"), param("block", { variadic: true })])).toBe(
      "'block' is variadic, but the call record and the block are one argument each.",
    );
  });
});

describe("withDecoratorTypes", () => {
  it("fills Call and the block type on untyped slots and keeps written ones", () => {
    const tagged = param("tag", { typeHint: typeOf("string") });
    const [tag, ctx, body] = withDecoratorTypes(decorator([tagged, param("ctx"), param("body")]));
    expect(tag.typeHint).toEqual(typeOf("string"));
    expect(ctx.typeHint).toEqual(typeOf("Call"));
    expect(body.typeHint).toEqual(typeOf("(args: object) -> any"));
  });

  it("keeps a narrower block type", () => {
    const narrow = param("block", { typeHint: typeOf("() -> string") });
    const [, block] = withDecoratorTypes(decorator([param("call"), narrow]));
    expect(block.typeHint).toEqual(typeOf("() -> string"));
  });

  it("leaves a decorator with fewer than two parameters alone", () => {
    const input = [param("block")];
    expect(withDecoratorTypes(decorator(input))).toBe(input);
    expect(input[0].typeHint).toBeUndefined();
  });

  it("builds a fresh type node for every slot it fills", () => {
    // The hints are spliced into defs across the program; a pass that
    // annotates one in place must not reach every decorator.
    const [first] = withDecoratorTypes(decorator([param("call"), param("block")]));
    const [second] = withDecoratorTypes(decorator([param("call"), param("block")]));
    expect(first.typeHint).toEqual(second.typeHint);
    expect(first.typeHint).not.toBe(second.typeHint);
  });

  it("leaves a plain def alone and never mutates", () => {
    const input = [param("call"), param("block")];
    expect(withDecoratorTypes({ parameters: input })).toBe(input);
    withDecoratorTypes(decorator(input));
    expect(input[0].typeHint).toBeUndefined();
    expect(input[1].typeHint).toBeUndefined();
  });
});

describe("callerSuppliedParameters", () => {
  it("drops the last two only for a decorator", () => {
    const parameters = [param("a"), param("call"), blockParam()];
    expect(callerSuppliedParameters(decorator(parameters)).map((p) => p.name)).toEqual(["a"]);
    expect(callerSuppliedParameters({ parameters }).map((p) => p.name)).toEqual([
      "a",
      "call",
      "block",
    ]);
  });
});

describe("requiredParameterAfterDefault", () => {
  const defaulted = (name: string) => param(name, { defaultValue: { type: "null" } as never });

  it("is the first parameter without a default after one with a default", () => {
    expect(requiredParameterAfterDefault([param("a"), defaulted("b")])).toBeNull();
    expect(requiredParameterAfterDefault([defaulted("a"), param("b"), param("c")])?.name).toBe("b");
  });

  it("lets a variadic parameter follow a default", () => {
    const rest = param("rest", { variadic: true });
    expect(requiredParameterAfterDefault([defaulted("a"), rest])).toBeNull();
  });
});

describe("isDecoratorMissingKeyword", () => {
  const defaulted = (name: string) => param(name, { defaultValue: { type: "null" } as never });
  const shaped = [defaulted("tag"), param("call", { typeHint: typeOf("Call") }), blockParam()];

  it("is a plain def whose only order problem is the two trailing slots", () => {
    expect(isDecoratorMissingKeyword({ parameters: shaped })).toBe(true);
  });

  it("is not a declared decorator, a def whose own parameters are out of order, or a def in the wrong shape", () => {
    expect(isDecoratorMissingKeyword(decorator(shaped))).toBe(false);
    expect(isDecoratorMissingKeyword({ parameters: [defaulted("a"), param("b"), ...shaped] })).toBe(
      false,
    );
    const notABlock = param("last", { typeHint: typeOf("string") });
    expect(isDecoratorMissingKeyword({ parameters: [defaulted("a"), param("b"), notABlock] })).toBe(
      false,
    );
    // Defaults last is fine on any def.
    expect(isDecoratorMissingKeyword({ parameters: [param("call"), blockParam()] })).toBe(false);
  });

  it("is what the order check leaves out", () => {
    expect(orderCheckedParameters({ parameters: shaped }).map((p) => p.name)).toEqual(["tag"]);
    expect(orderCheckedParameters(decorator(shaped)).map((p) => p.name)).toEqual(["tag"]);
    const plain = [param("a"), param("call"), blockParam()];
    expect(orderCheckedParameters({ parameters: plain }).map((p) => p.name)).toEqual([
      "a",
      "call",
      "block",
    ]);
  });
});
