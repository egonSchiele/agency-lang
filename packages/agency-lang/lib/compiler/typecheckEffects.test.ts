import { describe, it, expect } from "vitest";
import * as path from "path";
import { getEffectsFromFile, getEffectsFromSource } from "./typecheck.js";

describe("getEffectsFromSource", () => {
  it("reports the effects of a stdlib function that wraps another", () => {
    // Measured before the propagation pass: { f: [] }. runFile runs arbitrary
    // Agency code and this said it did nothing at all.
    const effects = getEffectsFromSource(
      `import { runFile } from "std::agency"\n` +
        `export def f(): string {\n  return runFile("x.agency")\n}\n`,
    );
    expect(effects["f"]).toEqual(["std::guard", "std::run"]);
  });

  it("throws rather than answering short for a relative import", () => {
    // No directory to resolve against, so it fails loud. That is documented
    // behaviour and the safe direction to be wrong in.
    expect(() =>
      getEffectsFromSource(
        `import { h } from "./helper.agency"\n` + `export def f(): string {\n  return h()\n}\n`,
      ),
    ).toThrow();
  });
});

describe("the documented Throws list", () => {
  it("lists effects that come from a call rather than a literal interrupt", () => {
    // runFile has no `interrupt` in its body; its effects come entirely from
    // what it calls. Before propagation crossed file boundaries, its Throws
    // column in `agency doc` was empty.
    const effects = getEffectsFromFile(path.resolve("stdlib/agency.agency"));
    expect(effects["runFile"]).toEqual(["std::guard", "std::run"]);
    expect(effects["runCode"]).toEqual(["std::guard", "std::run"]);
    expect(effects["run"]).toEqual(["std::guard", "std::run"]);
  });

  it("lists effects for a stdlib function whose work is one file away", () => {
    const policy = getEffectsFromFile(path.resolve("stdlib/policy.agency"));
    expect(policy["parsePolicyFile"]).toEqual(["std::read"]);
    const supervise = getEffectsFromFile(path.resolve("stdlib/supervise.agency"));
    expect(supervise["supervise"]).toEqual(["std::guard"]);
  });
});
