import { describe, it as baseIt, expect } from "vitest";
import { enterCallable, refusalAtEntry } from "./capabilities.js";
import { AgencyFunction } from "./agencyFunction.js";
import { isFailure } from "./result.js";
import { RuntimeContext } from "./state/context.js";
import { State, StateStack } from "./state/stateStack.js";
import { memoryHost } from "../host/memoryHost.js";
import { inFrameOf, withTestFrame } from "./__tests__/testHelpers.js";
import type { Capability, Host } from "../host/host.js";

const it = withTestFrame(baseIt);

function makeCtxWith(host: Host): RuntimeContext<any> {
  return new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
    host,
  });
}

function makeCtx(capabilities: Capability[]): RuntimeContext<any> {
  return makeCtxWith(memoryHost({ capabilities }));
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
        "exists needs the fileRead capability, which the memory host does not have. Calling exists again will fail the same way.",
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

  it("reports the entry and the exit to the host, the exit even when the body throws", async () => {
    const events: string[] = [];
    const ctx = makeCtxWith(
      memoryHost({
        capabilities: ["fileRead"],
        onCallable: (event) =>
          events.push(event.kind === "enter" ? `enter ${event.name}` : `exit ${event.name}`),
      }),
    );
    await inFrameOf(ctx, new StateStack(), (run) =>
      enterCallable(run, "read", ["fileRead"], async () => "ran"),
    );
    await expect(
      inFrameOf(ctx, new StateStack(), (run) =>
        enterCallable(run, "boom", [], async () => {
          throw new Error("body failed");
        }),
      ),
    ).rejects.toThrow("body failed");
    expect(events).toEqual(["enter read", "exit read", "enter boom", "exit boom"]);
  });

  it("reports nothing for a call the host refused", async () => {
    const events: string[] = [];
    const ctx = makeCtxWith(
      memoryHost({ capabilities: [], onCallable: (event) => events.push(event.kind) }),
    );
    await inFrameOf(ctx, new StateStack(), (run) =>
      enterCallable(run, "exists", ["fileRead"], async () => "ran"),
    );
    expect(events).toEqual([]);
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

describe("discardPausedChainFor", () => {
  function frames(...names: string[]): State[] {
    return names.map((name) => {
      const frame = new State();
      frame.scopeName = name;
      return frame;
    });
  }

  it("drops the refused call's frame and everything below it on a resume", () => {
    const [main, runIt, inner] = frames("main", "runIt", "inner");
    const stack = new StateStack([main, runIt, inner]);
    stack.deserializeMode();
    expect(stack.getNewState()).toBe(main);
    stack.discardPausedChainFor("runIt");
    const next = stack.getNewState();
    expect(next).not.toBe(runIt);
    expect(next).not.toBe(inner);
    expect(next.scopeName).toBe(null);
  });

  it("leaves the frames alone when the next one belongs to another call", () => {
    const [main, other] = frames("main", "other");
    const stack = new StateStack([main, other]);
    stack.deserializeMode();
    stack.getNewState();
    stack.discardPausedChainFor("runIt");
    expect(stack.getNewState()).toBe(other);
  });

  it("does nothing outside a resume", () => {
    const stack = new StateStack();
    const first = stack.getNewState();
    stack.discardPausedChainFor("runIt");
    expect(stack.lastFrame()).toBe(first);
  });
});
