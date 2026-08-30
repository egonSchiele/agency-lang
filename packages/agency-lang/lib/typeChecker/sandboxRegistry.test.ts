import { describe, it, expect } from "vitest";
import {
  resolveCall,
} from "./resolveCall.js";
import { SANDBOX_JS_GLOBALS, JS_GLOBALS, lookupJsMember } from "./resolveCall.js";
import { resolveVariable } from "./resolveVariable.js";

const emptyInput = {
  functionDefs: {},
  nodeDefs: {},
  importedFunctions: {},
  importedNodeNames: [] as string[],
  scopeHas: () => false,
};
const emptyVarInput = {
  functionDefs: {},
  nodeDefs: {},
  importedFunctions: {},
  importedNodeNames: [] as string[],
  scopeHas: () => false,
};

describe("SANDBOX_JS_GLOBALS as a resolver registry", () => {
  const sandbox = SANDBOX_JS_GLOBALS;

  it("refuses host-reaching globals under the sandbox registry", () => {
    for (const name of ["process", "fetch", "eval", "Function", "Reflect", "Symbol", "setTimeout", "console", "globalThis", "Buffer"]) {
      expect(resolveVariable(name, { ...emptyVarInput, registry: sandbox }).kind).toBe("unresolved");
    }
  });

  it("allows pure globals under the sandbox registry", () => {
    for (const name of ["Math", "JSON", "Object", "Set", "Map", "Date", "RegExp", "Intl", "structuredClone", "parseInt", "Boolean", "Promise"]) {
      expect(resolveVariable(name, { ...emptyVarInput, registry: sandbox }).kind).toBe("jsGlobal");
    }
  });

  it("keeps default (JS_GLOBALS) behaviour when no registry is passed", () => {
    expect(resolveVariable("process", emptyVarInput).kind).toBe("jsGlobal");
    expect(resolveVariable("console", emptyVarInput).kind).toBe("jsGlobal");
    expect(resolveCall("setTimeout", emptyInput).kind).toBe("jsGlobal");
  });

  it("member lookup: allows Object.keys, refuses Object.getPrototypeOf under sandbox", () => {
    expect(lookupJsMember(["Object", "keys"], sandbox)).not.toBeNull();
    expect(lookupJsMember(["Object", "getPrototypeOf"], sandbox)).toBeNull();
    expect(lookupJsMember(["Math", "floor"], sandbox)).not.toBeNull();
    // default registry still has getPrototypeOf
    expect(lookupJsMember(["Object", "getPrototypeOf"])).not.toBeNull();
  });
});
