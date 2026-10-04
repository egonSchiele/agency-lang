import { describe, expect, test } from "vitest";
import { withCallDepth } from "./callDepth.js";
import { CallDepthExceededError, AgencyAbort, readCause } from "./errors.js";
import { runInTestContext, WrongRunError, type Run } from "./asyncContext.js";
import { makeMockCtx } from "./__tests__/testHelpers.js";

/** Run `fn` inside an execution context whose maxCallDepth is `limit`. The
 *  call-depth guard resolves its ceiling from the active context, so tests
 *  exercise the real resolution path rather than an injected value. */
function withLimit<T>(limit: number, fn: (run: Run) => Promise<T>): Promise<T> {
  const ctx = makeMockCtx();
  ctx.maxCallDepth = limit;
  return runInTestContext(ctx, ctx.stateStack, ctx.threads, fn);
}

describe("call-depth guard", () => {
  test("allows nesting up to the limit", async () => {
    const recurse = async (run: Run, n: number): Promise<number> =>
      n >= 4 ? 42 : withCallDepth(run, `f${n}`, (inner) => recurse(inner, n + 1));
    await expect(withLimit(5, (run) => recurse(run, 0))).resolves.toBe(42);
  });

  test("throws CallDepthExceededError when nesting exceeds the limit", async () => {
    const recurse = async (run: Run, n: number): Promise<number> =>
      withCallDepth(run, `f${n}`, (inner) => recurse(inner, n + 1));
    await expect(withLimit(3, (run) => recurse(run, 0))).rejects.toBeInstanceOf(
      CallDepthExceededError,
    );
  });

  test("the error is an AgencyAbort carrying a callDepthExceeded cause with the limit", async () => {
    const recurse = async (run: Run, n: number): Promise<number> =>
      withCallDepth(run, `f${n}`, (inner) => recurse(inner, n + 1));
    let caught: unknown;
    try {
      await withLimit(2, (run) => recurse(run, 0));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgencyAbort);
    const cause = readCause(caught);
    expect(cause?.kind).toBe("callDepthExceeded");
    expect((caught as CallDepthExceededError).message).toContain("2");
  });

  test("the error message includes the recent call chain and the config knob", async () => {
    const recurse = async (run: Run, n: number): Promise<number> =>
      withCallDepth(run, `fn${n}`, (inner) => recurse(inner, n + 1));
    let msg = "";
    try {
      await withLimit(3, (run) => recurse(run, 0));
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
    const run = (outer: Run) =>
      withCallDepth(outer, "root", (root) =>
        Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            withCallDepth(root, `sib${i}`, async () => {
              await Promise.resolve();
              return "ok";
            }),
          ),
        ),
      );
    await expect(withLimit(3, run)).resolves.toHaveLength(10);
  });

  test("throws when there is no frame to keep the depth on", () => {
    // The depth lives on the frame. With no frame every call would count as
    // the first, and the limit would never trip. A run handed in from an
    // earlier frame is refused, because no frame is current.
    const ctx = makeMockCtx();
    const stale = runInTestContext(ctx, ctx.stateStack, ctx.threads, (run) => run);
    expect(() => withCallDepth(stale, "solo", async () => "ok")).toThrow(WrongRunError);
  });

  test("a frame that carries no call depth starts at the root", async () => {
    const ctx = makeMockCtx();
    ctx.maxCallDepth = 1;
    await expect(
      runInTestContext(ctx, ctx.stateStack, ctx.threads, (run) =>
        withCallDepth(run, "first", async () => "ok"),
      ),
    ).resolves.toBe("ok");
  });
});
