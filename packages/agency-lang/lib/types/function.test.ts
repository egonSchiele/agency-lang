import { describe, it, expect } from "vitest";
import { VALID_CALLBACK_NAMES } from "./function.js";

describe("VALID_CALLBACK_NAMES", () => {
  it("includes the LLM resilience hooks so the runtime accepts them", () => {
    // lib/stdlib/agency.ts validates callback("...") names against this list at
    // runtime; a name not here throws "Unknown callback". hooks.ts also has a
    // compile-time guard keeping this list in sync with CallbackMap.
    expect(VALID_CALLBACK_NAMES).toContain("onLLMRetry");
    expect(VALID_CALLBACK_NAMES).toContain("onLLMTimeout");
  });
});

import {
  callerSuppliedParameters,
  decoratorShapeProblem,
  hasDecoratorShape,
  type FunctionParameter,
} from "./function.js";

describe("decorator shape", () => {
  const param = (name: string, extra: Partial<FunctionParameter> = {}): FunctionParameter => ({
    type: "functionParameter",
    name,
    ...extra,
  });
  const block = param("block", {
    typeHint: {
      type: "blockType",
      params: [],
      returnType: { type: "primitiveType", value: "any" },
    },
  });
  const nullLiteral = { type: "null" } as FunctionParameter["defaultValue"];

  it("accepts your args, then call, then a block", () => {
    const params = [param("cost"), param("call"), block];
    expect(hasDecoratorShape(params)).toBe(true);
    expect(decoratorShapeProblem(params)).toBeNull();
    expect(callerSuppliedParameters(params)).toEqual([param("cost")]);
  });

  it("accepts an untyped last parameter as the block", () => {
    expect(decoratorShapeProblem([param("call"), param("block")])).toBeNull();
  });

  it("refuses a def with no block", () => {
    const params = [
      param("call"),
      param("x", { typeHint: { type: "primitiveType", value: "string" } }),
    ];
    expect(decoratorShapeProblem(params)).toContain("its last parameter must be a block");
  });

  it("refuses a def with fewer than two parameters", () => {
    expect(decoratorShapeProblem([block])).toContain("its last parameter must be a block");
  });

  it("refuses call in the wrong slot", () => {
    const params = [param("call"), param("tag"), block];
    expect(decoratorShapeProblem(params)).toContain("Found 'tag' there");
    expect(hasDecoratorShape(params)).toBe(false);
    expect(callerSuppliedParameters(params)).toEqual(params);
  });

  it("refuses a default on call or the block", () => {
    expect(decoratorShapeProblem([param("call", { defaultValue: nullLiteral }), block])).toContain(
      "'call' has a default",
    );
    expect(
      decoratorShapeProblem([param("call"), { ...block, defaultValue: nullLiteral }]),
    ).toContain("'block' has a default");
  });
});
