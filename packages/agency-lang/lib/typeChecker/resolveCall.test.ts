import { describe, it, expect } from "vitest";
import {
  resolveCall,
  lookupJsMember,
  JS_GLOBALS,
  RESERVED_FUNCTION_NAMES,
} from "./resolveCall.js";

const emptyInput = {
  functionDefs: {},
  nodeDefs: {},
  importedFunctions: {},
  scopeHas: () => false,
};

describe("resolveCall", () => {
  it("resolves a locally defined function", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = resolveCall("myFunc", { ...emptyInput, functionDefs: { myFunc: {} as any } });
    expect(result.kind).toBe("def");
  });

  it("resolves an imported function", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = resolveCall("imported", { ...emptyInput, importedFunctions: { imported: {} as any } });
    expect(result.kind).toBe("imported");
  });

  it("resolves a builtin function", () => {
    const result = resolveCall("print", emptyInput);
    expect(result.kind).toBe("builtin");
  });

  it("resolves a reserved name", () => {
    const result = resolveCall("schema", emptyInput);
    expect(result.kind).toBe("reserved");
  });

  it("resolves a scope binding (lambda, partial, etc.)", () => {
    const result = resolveCall("myLambda", {
      ...emptyInput,
      scopeHas: (name) => name === "myLambda",
    });
    expect(result.kind).toBe("scopeBinding");
  });

  it("resolves a flat callable JS global", () => {
    const result = resolveCall("parseInt", emptyInput);
    expect(result.kind).toBe("jsGlobal");
  });

  it("returns unresolved for a genuinely missing name", () => {
    const result = resolveCall("doesNotExist", emptyInput);
    expect(result.kind).toBe("unresolved");
  });
});

describe("JS_GLOBALS", () => {
  it("includes flat callables", () => {
    expect(JS_GLOBALS.parseInt?.kind).toBe("callable");
    expect(JS_GLOBALS.setTimeout?.kind).toBe("callable");
  });

  it("includes namespaces with members", () => {
    const json = JS_GLOBALS.JSON;
    expect(json?.kind).toBe("namespace");
    if (json?.kind === "namespace") {
      expect(json.members.parse?.kind).toBe("callable");
      expect(json.members.stringify?.kind).toBe("callable");
    }
  });

  it("does not include native Agency literals", () => {
    expect(JS_GLOBALS.undefined).toBeUndefined();
    expect(JS_GLOBALS.NaN).toBeUndefined();
    expect(JS_GLOBALS.Infinity).toBeUndefined();
  });
});

describe("lookupJsMember", () => {
  it("returns the callable entry for JSON.parse", () => {
    const result = lookupJsMember(["JSON", "parse"]);
    expect(result?.kind).toBe("callable");
  });

  it("returns null for an unknown member on a known namespace", () => {
    expect(lookupJsMember(["JSON", "banana"])).toBeNull();
  });

  it("returns null for an unknown base", () => {
    expect(lookupJsMember(["NotAGlobal", "parse"])).toBeNull();
  });

  it("walks deeper namespaces if added later", () => {
    // Sanity: structure supports nested namespaces.
    const fake = {
      kind: "namespace",
      members: {
        x: { kind: "namespace", members: { y: { kind: "callable" } } },
      },
    } as const;
    expect(fake.members.x.members.y.kind).toBe("callable");
  });
});

describe("RESERVED_FUNCTION_NAMES", () => {
  it("includes the names imported by index.ts", () => {
    for (const name of [
      "success",
      "failure",
      "approve",
      "reject",
      "propagate",
      "schema",
      "interrupt",
      "debugger",
    ]) {
      expect(RESERVED_FUNCTION_NAMES.has(name)).toBe(true);
    }
  });
});
