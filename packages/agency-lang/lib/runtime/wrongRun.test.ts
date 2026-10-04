import { describe, it as baseIt, expect } from "vitest";
import { assertUsable, RunInUseError, detachedRun, withChildRun } from "./asyncContext.js";
import { __call } from "./call.js";
import { testRun, withTestFrame } from "./__tests__/testHelpers.js";

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
});
