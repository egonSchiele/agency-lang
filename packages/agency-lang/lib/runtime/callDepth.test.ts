import { describe, expect, test } from "vitest";
import { withCallDepth, currentCallDepth } from "./callDepth.js";
import { CallDepthExceededError } from "./errors.js";
import { AgencyAbort, readCause } from "./errors.js";

describe("call-depth guard", () => {
  test("allows nesting up to the limit", async () => {
    const recurse = async (n: number): Promise<number> =>
      n >= 4 ? 42 : withCallDepth(`f${n}`, 5, () => recurse(n + 1));
    await expect(recurse(0)).resolves.toBe(42);
  });

  test("throws CallDepthExceededError when nesting exceeds the limit", async () => {
    const recurse = async (n: number): Promise<number> =>
      withCallDepth(`f${n}`, 3, () => recurse(n + 1));
    await expect(recurse(0)).rejects.toBeInstanceOf(CallDepthExceededError);
  });

  test("the error is an AgencyAbort carrying a callDepthExceeded cause with the limit", async () => {
    const recurse = async (n: number): Promise<number> =>
      withCallDepth(`f${n}`, 2, () => recurse(n + 1));
    let caught: unknown;
    try {
      await recurse(0);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgencyAbort);
    const cause = readCause(caught);
    expect(cause?.kind).toBe("callDepthExceeded");
    expect((caught as CallDepthExceededError).message).toContain("2");
  });

  test("the error message includes the recent call chain and the config knob", async () => {
    const recurse = async (n: number): Promise<number> =>
      withCallDepth(`fn${n}`, 3, () => recurse(n + 1));
    let msg = "";
    try {
      await recurse(0);
    } catch (e) {
      msg = (e as Error).message;
    }
    // Names of the deepest frames appear so the user can see what recursed.
    expect(msg).toContain("fn3");
    // Points the user at the override knob.
    expect(msg).toContain("maxCallDepth");
  });

  test("concurrent sibling calls do not accumulate depth (per-lineage, not global)", async () => {
    // root is depth 1; each of 10 concurrent siblings is depth 2. With a naive
    // global counter, 10 in-flight siblings would read depth ~11 and trip a
    // limit of 3. With per-lineage ALS tracking, each sibling independently
    // sees depth 2, so a limit of 3 is never exceeded.
    const run = () =>
      withCallDepth("root", 3, () =>
        Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            withCallDepth(`sib${i}`, 3, async () => {
              await Promise.resolve();
              return "ok";
            }),
          ),
        ),
      );
    await expect(run()).resolves.toHaveLength(10);
  });

  test("currentCallDepth reflects the active nesting", async () => {
    expect(currentCallDepth()).toBe(0);
    const depths: number[] = [];
    await withCallDepth("a", 10, () =>
      withCallDepth("b", 10, async () => {
        depths.push(currentCallDepth());
        return null;
      }),
    );
    expect(depths).toEqual([2]);
  });
});
