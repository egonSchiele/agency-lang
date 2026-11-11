import { describe, it, expect, vi } from "vitest";
import { _prepareFunctions } from "./agencyFunctions.js";

// A stale table that predates std::shell.
vi.mock("./stdlibModules.data.js", () => ({
  STDLIB_MODULES: { "std::system": ["env"] },
}));

describe("a module missing from a stale table", () => {
  it("still loads when its file exists", () => {
    const prepared = _prepareFunctions({ kind: "module", module: "std::shell" }, ["exec"]);
    expect(prepared.exportNames).toEqual(["exec"]);
  });

  it("is refused when its file does not exist", () => {
    expect(() => _prepareFunctions({ kind: "module", module: "std::exec" }, ["exec"])).toThrow(
      "There is no standard library module named std::exec.",
    );
  });
});
