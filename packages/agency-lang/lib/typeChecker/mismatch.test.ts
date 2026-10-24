import { describe, it, expect } from "vitest";
import type { FunctionCall } from "../types.js";
import type { BlockType } from "../types/typeHints.js";
import { draftTarget, mismatchEntry, type MismatchSite } from "./mismatch.js";

function call(name: string, decorator?: string): FunctionCall {
  return {
    type: "functionCall",
    functionName: name,
    arguments: [],
    ...(decorator === undefined
      ? {}
      : {
          decorator: { name: decorator, tagLoc: undefined, target: "f" },
        }),
  };
}

const LITERAL = { type: "number", value: "5" } as const;
const PARAMS = { actual: "number", expected: "string", context: "block return" };

describe("mismatchEntry", () => {
  const rows: [MismatchSite, string, string][] = [
    ["argument", "argNotAssignable", "decoratorArgType"],
    ["blockReturn", "typeNotAssignableInContext", "decoratorBodyReturn"],
    ["declaredReturn", "typeNotAssignableInContext", "decoratorReturnMismatch"],
    ["draft", "typeNotAssignableInContext", "decoratorDraftType"],
  ];

  for (const [site, plain, decorated] of rows) {
    it(`gives ${site} its plain entry for an ordinary call`, () => {
      const entry = mismatchEntry({ site, owner: call("g"), value: LITERAL, params: PARAMS });
      expect(entry).toEqual({ name: plain, params: PARAMS });
    });

    it(`gives ${site} its decorator entry, naming the decorator and the def`, () => {
      const entry = mismatchEntry({
        site,
        owner: call("budgeted", "budgeted"),
        value: LITERAL,
        params: PARAMS,
      });
      expect(entry.name).toBe(decorated);
      expect(entry.params).toMatchObject({ name: "budgeted", target: "f", declared: "string" });
    });
  }

  it("uses the stacked entry when a block return's value is another decorator's call", () => {
    const entry = mismatchEntry({
      site: "blockReturn",
      owner: call("outer", "outer"),
      value: call("inner", "inner"),
      params: PARAMS,
    });
    expect(entry.name).toBe("decoratorStackedReturn");
    expect(entry.params).toMatchObject({ name: "outer", inner: "inner" });
  });

  it("has no stacked form for a declared return", () => {
    const outer = call("outer", "outer");
    const entry = mismatchEntry({
      site: "declaredReturn",
      owner: outer,
      value: outer,
      params: PARAMS,
    });
    expect(entry.name).toBe("decoratorReturnMismatch");
  });
});

describe("draftTarget", () => {
  const STRING = { type: "primitiveType", value: "string" } as const;
  const RESULT = { type: "resultType", successType: STRING, dataType: STRING } as const;
  const SLOT: BlockType = { type: "blockType", params: [], returnType: STRING };

  it("is the scope's return type outside any block, and in an ordinary call's block", () => {
    expect(draftTarget(undefined, undefined, RESULT)).toBe(RESULT);
    expect(draftTarget(call("map"), SLOT, RESULT)).toBe(RESULT);
  });

  it("is the block slot's return type in a decorator's block", () => {
    expect(draftTarget(call("budgeted", "budgeted"), SLOT, RESULT)).toBe(STRING);
  });

  it("is any in a decorator's block with no typed slot", () => {
    expect(draftTarget(call("logged", "logged"), undefined, RESULT)).toEqual({
      type: "primitiveType",
      value: "any",
    });
  });
});
