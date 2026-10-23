import { describe, it, expect } from "vitest";
import type { FunctionCall } from "../types.js";
import { mismatchEntry, type MismatchSite } from "./mismatch.js";

function call(name: string, decorator?: string): FunctionCall {
  return {
    type: "functionCall",
    functionName: name,
    arguments: [],
    ...(decorator === undefined
      ? {}
      : {
          decorator: { name: decorator, tagLoc: undefined, target: "f", passesCallRecord: false },
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
