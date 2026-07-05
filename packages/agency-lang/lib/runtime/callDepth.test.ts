import { describe, expect, test } from "vitest";
import { withCallDepth } from "./callDepth.js";
import { CallDepthExceededError, AgencyAbort, readCause } from "./errors.js";
import { runInTestContext } from "./asyncContext.js";
import { makeMockCtx } from "./__tests__/testHelpers.js";

/** Run `fn` inside an execution context whose maxCallDepth is `limit`. The
 *  call-depth guard resolves its ceiling from the active context, so tests
 *  exercise the real resolution path rather than an injected value. */
function withLimit<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  const ctx = makeMockCtx();
  ctx.maxCallDepth = limit;
  return runInTestContext(ctx, ctx.stateStack, ctx.threads, fn);
}

describe("call-depth guard", () => {
  test("allows nesting up to the limit", async () => {
    const recurse = async (n: number): Promise<number> =>
      n >= 4 ? 42 : withCallDepth(`f${n}`, () => recurse(n + 1));
    await expect(withLimit(5, () => recurse(0))).resolves.toBe(42);
  });

  test("throws CallDepthExceededError when nesting exceeds the limit", async () => {
    const recurse = async (n: number): Promise<number> =>
      withCallDepth(`f${n}`, () => recurse(n + 1));
    await expect(withLimit(3, () => recurse(0))).rejects.toBeInstanceOf(
      CallDepthExceededError,
    );
  });

  test("the error is an AgencyAbort carrying a callDepthExceeded cause with the limit", async () => {
    const recurse = async (n: number): Promise<number> =>
      withCallDepth(`f${n}`, () => recurse(n + 1));
    let caught: unknown;
    try {
      await withLimit(2, () => recurse(0));
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
      withCallDepth(`fn${n}`, () => recurse(n + 1));
    let msg = "";
    try {
      await withLimit(3, () => recurse(0));
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
      withCallDepth("root", () =>
        Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            withCallDepth(`sib${i}`, async () => {
              await Promise.resolve();
              return "ok";
            }),
          ),
        ),
      );
    await expect(withLimit(3, run)).resolves.toHaveLength(10);
  });

  test("falls back to the default limit when no context is installed", async () => {
    // No runInTestContext wrapper → no agencyStore ctx. A shallow call must
    // still work (guarded by DEFAULT_MAX_CALL_DEPTH), not throw.
    await expect(withCallDepth("solo", async () => "ok")).resolves.toBe("ok");
  });
});
