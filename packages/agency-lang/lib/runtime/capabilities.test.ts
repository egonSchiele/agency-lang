import { describe, it as baseIt, expect } from "vitest";
import { enterCallable, refusalAtEntry } from "./capabilities.js";
import { AgencyFunction } from "./agencyFunction.js";
import { isFailure } from "./result.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import { memoryHost } from "../host/memoryHost.js";
import { inFrameOf, withTestFrame } from "./__tests__/testHelpers.js";
import type { Capability } from "../host/host.js";

const it = withTestFrame(baseIt);

function makeCtx(capabilities: Capability[]): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
    host: memoryHost({ capabilities }),
  });
}

describe("enterCallable", () => {
  it("runs the body when the host has every capability", async () => {
    const ctx = makeCtx(["fileRead", "terminal"]);
    const result = await inFrameOf(ctx, new StateStack(), (run) =>
      enterCallable(run, "exists", ["fileRead"], async () => "ran"),
    );
    expect(result).toBe("ran");
  });

  it("returns the host's refusal and never runs the body when one is missing", async () => {
    const ctx = makeCtx(["terminal"]);
    let ran = false;
    const result = await inFrameOf(ctx, new StateStack(), (run) =>
      enterCallable(run, "exists", ["fileRead"], async () => {
        ran = true;
        return "ran";
      }),
    );
    expect(ran).toBe(false);
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) {
      expect(result.error).toBe(
        "exists needs the fileRead capability, which the memory host does not have. No tool call can supply it.",
      );
      expect(result.functionName).toBe("exists");
    }
  });

  it("hands the failure to the caller's shape when asked", async () => {
    const ctx = makeCtx([]);
    const result = await inFrameOf(ctx, new StateStack(), (run) =>
      enterCallable(
        run,
        "main",
        ["network"],
        async () => ({ data: "ran" }),
        (_run, failure) => ({ data: failure.error }),
      ),
    );
    expect(result.data).toMatch(/^main needs the network capability/);
  });

  it("needs nothing from a host for a function with no tag", () => {
    const ctx = makeCtx([]);
    expect(inFrameOf(ctx, new StateStack(), (run) => refusalAtEntry(run, "pure", []))).toBe(null);
  });
});

describe("AgencyFunction and its capabilities", () => {
  function tagged(capabilities: Capability[], body: () => unknown): AgencyFunction {
    return new AgencyFunction({
      name: "exists",
      module: "test.agency",
      fn: () => body(),
      params: [],
      toolDefinition: null,
      capabilities,
    });
  }

  it("is refused at entry on a host that lacks its capability, and the body never runs", async () => {
    let ran = false;
    const fn = tagged(["subprocess"], () => {
      ran = true;
      return "ran";
    });
    const ctx = makeCtx(["fileRead"]);
    const result = await inFrameOf(ctx, new StateStack(), (run) =>
      fn.invoke(run, { type: "positional", args: [] }),
    );
    expect(ran).toBe(false);
    expect(isFailure(result)).toBe(true);
  });

  it("runs on a host that has it", async () => {
    const fn = tagged(["subprocess"], () => "ran");
    const ctx = makeCtx(["subprocess"]);
    const result = await inFrameOf(ctx, new StateStack(), (run) =>
      fn.invoke(run, { type: "positional", args: [] }),
    );
    expect(result).toBe("ran");
  });

  it("keeps its list through every derivation", () => {
    const fn = tagged(["fileRead", "fileWrite"], () => "x");
    const derived = fn.describe("d").rename("other").preapprove();
    expect(derived.capabilities).toEqual(["fileRead", "fileWrite"]);
    const withParams = new AgencyFunction({
      name: "write",
      module: "test.agency",
      fn: () => "x",
      params: [{ name: "a", hasDefault: false, defaultValue: undefined, variadic: false }],
      toolDefinition: null,
      capabilities: ["fileWrite"],
    });
    expect(withParams.partial({ a: 1 }).capabilities).toEqual(["fileWrite"]);
  });
});
