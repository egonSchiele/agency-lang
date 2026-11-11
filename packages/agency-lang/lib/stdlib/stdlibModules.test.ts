import { describe, it, expect } from "vitest";
import { _prepareFunctions, _stdlibModuleTable } from "./agencyFunctions.js";
import { STDLIB_MODULES } from "./stdlibModules.data.js";
import { isKnownStdlibModule, missingModuleMessage } from "./stdlibModules.js";

describe("stdlibModules.data.ts", () => {
  it("matches the stdlib folder (run `make` when this fails)", () => {
    expect(STDLIB_MODULES).toEqual(_stdlibModuleTable());
  }, 60_000);

  it("knows where exec lives", () => {
    expect(STDLIB_MODULES["std::shell"]).toContain("exec");
    expect(isKnownStdlibModule("std::shell")).toBe(true);
    expect(isKnownStdlibModule("std::exec")).toBe(false);
  });

  it("leaves out private functions", () => {
    for (const names of Object.values(STDLIB_MODULES)) {
      for (const name of names) {
        expect(name.startsWith("_")).toBe(false);
      }
    }
  });
});

describe("missingModuleMessage", () => {
  it("names the module that exports a requested function", () => {
    expect(missingModuleMessage("std::exec", ["exec"])).toBe(
      "There is no standard library module named std::exec. `exec` is exported by std::shell.",
    );
  });

  it("lists the modules when no requested name is exported anywhere", () => {
    const message = missingModuleMessage("std::nope", ["noSuchFunction"]);
    expect(message).toContain("There is no standard library module named std::nope.");
    expect(message).toContain("std::shell");
  });

  it("lists the modules when no names were requested", () => {
    expect(missingModuleMessage("std::nope", [])).toContain("std::shell");
  });
});

describe("_prepareFunctions with a missing module", () => {
  it("fails with the lookup message instead of a file error", () => {
    expect(() => _prepareFunctions({ kind: "module", module: "std::exec" }, ["exec"])).toThrow(
      "There is no standard library module named std::exec. `exec` is exported by std::shell.",
    );
  });
});
