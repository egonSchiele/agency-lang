import { describe, it as baseIt, expect } from "vitest";
import { assertUsable, RunInUseError, detachedRun, withChildRun } from "./asyncContext.js";
import { __call, __callMethod } from "./call.js";
import { AgencyFunction } from "./agencyFunction.js";
import { callHook } from "./hooks.js";
import { interruptWithHandlers } from "./interrupts.js";
import { Runner } from "./runner.js";
import { State, StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { makeMockCtx, testRun, withTestFrame } from "./__tests__/testHelpers.js";

const it = withTestFrame(baseIt);

// The wrong-run check: a run that is waiting for something it started
// cannot be used to start something else. Only the innermost run can.
describe("the wrong-run check", () => {
  it("a run is unusable while its child runs, and usable again after", async () => {
    const parent = testRun();
    await withChildRun(parent, {}, "its step", async (child) => {
      await Promise.resolve();
      expect(() => assertUsable(parent, "make a call")).toThrow(RunInUseError);
      expect(assertUsable(child, "make a call")).toBe(child);
    });
    expect(assertUsable(parent, "make a call")).toBe(parent);
  });

  it("names what the run is waiting for", async () => {
    const parent = testRun();
    await withChildRun(parent, {}, "its fork", async () => {
      expect(() => assertUsable(parent, "call save()")).toThrow(
        "Wrong run: cannot call save() with a run that is waiting for its fork.",
      );
    });
  });

  it("stops a call made with the outer run from inside a child", async () => {
    const parent = testRun();
    const calls: string[] = [];
    const helper = () => calls.push("ran");
    await withChildRun(parent, {}, "its step", async (child) => {
      await expect(__call(parent, helper, { type: "positional", args: [] })).rejects.toThrow(
        RunInUseError,
      );
      await __call(child, helper, { type: "positional", args: [] });
    });
    expect(calls).toEqual(["ran"]);
  });

  it("frees the run when the child throws, now or later", async () => {
    const parent = testRun();
    expect(() =>
      withChildRun(parent, {}, "its step", () => {
        throw new Error("failed at once");
      }),
    ).toThrow("failed at once");
    expect(parent.state.waiting).toBe(0);
    await expect(
      withChildRun(parent, {}, "its step", async () => {
        await Promise.resolve();
        throw new Error("failed later");
      }),
    ).rejects.toThrow("failed later");
    expect(parent.state.waiting).toBe(0);
  });

  it("counts two waits at once", async () => {
    const parent = testRun();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = withChildRun(parent, {}, "the first", () => held);
    const second = withChildRun(parent, {}, "the second", () => held);
    expect(parent.state.waiting).toBe(2);
    release();
    await Promise.all([first, second]);
    expect(parent.state.waiting).toBe(0);
  });

  it("a detached copy has its own state", async () => {
    const parent = testRun();
    await withChildRun(parent, {}, "its step", async () => {
      const copy = detachedRun(parent, {});
      expect(copy.state).not.toBe(parent.state);
      expect(assertUsable(copy, "make a call")).toBe(copy);
    });
  });

  // Each operation that starts work for Agency code or a helper has its own
  // check. Every test here hands the operation the outer run from inside a
  // child, and expects it to be refused before it does anything.
  describe("each operation that starts work refuses a waiting run", () => {
    it("a method call", async () => {
      const parent = testRun();
      const calls: string[] = [];
      const target = { save: () => calls.push("ran") };
      await withChildRun(parent, {}, "its step", async () => {
        await expect(
          __callMethod(parent, target, "save", { type: "positional", args: [] }),
        ).rejects.toThrow(RunInUseError);
      });
      expect(calls).toEqual([]);
    });

    it("AgencyFunction.invoke", async () => {
      const parent = testRun();
      const calls: string[] = [];
      const save = new AgencyFunction({
        name: "save",
        module: "test.agency",
        fn: async () => calls.push("ran"),
        params: [],
        toolDefinition: null,
      });
      await withChildRun(parent, {}, "its step", async () => {
        await expect(save.invoke(parent, { type: "positional", args: [] })).rejects.toThrow(
          "Wrong run: cannot call save() with a run that is waiting for its step.",
        );
      });
      expect(calls).toEqual([]);
    });

    it("a Runner step", async () => {
      const parent = testRun();
      const calls: string[] = [];
      const runner = new Runner(makeMockCtx(), new State({ args: {}, locals: {}, step: 0 }), {
        moduleId: "test.agency",
        scopeName: "main",
        stack: new StateStack(),
        threads: new ThreadStore(),
      });
      await withChildRun(parent, {}, "its fork", async () => {
        await expect(
          runner.step(0, parent, async () => {
            calls.push("ran");
          }),
        ).rejects.toThrow(RunInUseError);
      });
      expect(calls).toEqual([]);
    });

    it("an interrupt", async () => {
      const parent = testRun();
      await withChildRun(parent, {}, "its step", async () => {
        await expect(
          interruptWithHandlers(parent, "test::save", "Save the file?", {}, "test.agency"),
        ).rejects.toThrow("Wrong run: cannot raise an interrupt");
      });
    });

    it("a callback", async () => {
      const parent = testRun();
      const calls: string[] = [];
      parent.ctx.callbacks = {
        onNodeStart: () => {
          calls.push("ran");
        },
      };
      await withChildRun(parent, {}, "its step", async () => {
        await expect(
          callHook(parent, { name: "onNodeStart", data: { nodeName: "main" } } as any),
        ).rejects.toThrow("Wrong run: cannot fire a callback");
      });
      expect(calls).toEqual([]);
    });
  });
});
