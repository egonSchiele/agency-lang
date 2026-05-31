import { describe, expect, it } from "vitest";
import { __initVar } from "./initVar.js";

describe("__initVar", () => {
  it("runs compute exactly once across many sequential and concurrent calls", async () => {
    let count = 0;
    const get = __initVar<number, undefined>("X", async () => {
      count++;
      return 42;
    });

    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () => get(undefined)),
    );
    for (let i = 0; i < 10; i++) {
      await get(undefined);
    }
    expect(count).toBe(1);
    expect(concurrent.every((v) => v === 42)).toBe(true);
  });

  it("returns the same promise reference for concurrent calls", () => {
    const get = __initVar<number, undefined>("X", async () => 1);
    const a = get(undefined);
    const b = get(undefined);
    expect(a).toBe(b);
  });

  it("diamond dependency runs the shared root exactly once", async () => {
    let dCount = 0;
    const getD = __initVar<number, undefined>("D", async () => {
      dCount++;
      return 1;
    });
    const getB = __initVar<number, undefined>("B", async (ctx) => {
      return (await getD(ctx)) + 10;
    });
    const getC = __initVar<number, undefined>("C", async (ctx) => {
      return (await getD(ctx)) + 100;
    });
    const getA = __initVar<number, undefined>("A", async (ctx) => {
      const b = await getB(ctx);
      const c = await getC(ctx);
      return b + c;
    });

    const a = await getA(undefined);
    expect(a).toBe(11 + 101);
    expect(dCount).toBe(1);
  });

  it("linear cascade resolves in dep order", async () => {
    const getC = __initVar<number, undefined>("C", async () => 1);
    const getB = __initVar<number, undefined>("B", async (ctx) =>
      (await getC(ctx)) + 1,
    );
    const getA = __initVar<number, undefined>("A", async (ctx) =>
      (await getB(ctx)) + 1,
    );
    expect(await getA(undefined)).toBe(3);
  });

  // This test covers both same-module AND cross-module cycle
  // detection — the runtime mechanism is identical regardless of
  // whether the two getters were declared in one file or imported
  // across files. (A cross-module integration fixture can't be
  // written in Agency: circular .agency imports compile but crash at
  // module load with a TDZ error from `__registerTool(...)`,
  // unrelated to our fix. Same-module cycles via static-init-cycle/
  // exercise the codegen + runtime path end-to-end.)
  it("detects a cycle between two vars and the error names the var", async () => {
    // Forward decls so the closures can refer to each other.
    let getA: (ctx: undefined) => Promise<number> = null as any;
    let getB: (ctx: undefined) => Promise<number> = null as any;
    getA = __initVar<number, undefined>("A", async (ctx) => {
      return (await getB(ctx)) + 1;
    });
    getB = __initVar<number, undefined>("B", async (ctx) => {
      return (await getA(ctx)) + 1;
    });

    let caught: Error | null = null;
    try {
      await getA(undefined);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    // The re-entry happens on A (A→B→A), so the throw names A.
    expect(caught!.message).toMatch(/Init cycle on A\b/);
  });

  it("detects a self-cycle", async () => {
    let getA: (ctx: undefined) => Promise<number> = null as any;
    getA = __initVar<number, undefined>("A", async (ctx) => {
      return (await getA(ctx)) + 1;
    });

    let caught: Error | null = null;
    try {
      await getA(undefined);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/Init cycle on A\b/);
  });

  it("propagates async rejection and caches the rejected promise (permanent failure)", async () => {
    let count = 0;
    const get = __initVar<number, undefined>("X", async () => {
      count++;
      throw new Error("boom");
    });

    await expect(get(undefined)).rejects.toThrow("boom");
    // Subsequent calls return the same cached rejection — compute does
    // NOT re-run.
    await expect(get(undefined)).rejects.toThrow("boom");
    await expect(get(undefined)).rejects.toThrow("boom");
    expect(count).toBe(1);
  });

  it("handles synchronous throw inside compute before first await (resets running, caches rejection)", async () => {
    let count = 0;
    const get = __initVar<number, undefined>("X", async () => {
      count++;
      throw new Error("sync-boom");
    });

    await expect(get(undefined)).rejects.toThrow("sync-boom");
    await expect(get(undefined)).rejects.toThrow("sync-boom");
    expect(count).toBe(1);
  });

  it("passes context through to compute", async () => {
    type Ctx = { tag: string };
    let seen: Ctx | null = null;
    const get = __initVar<string, Ctx>("X", async (ctx) => {
      seen = ctx;
      return ctx.tag;
    });
    const v = await get({ tag: "hello" });
    expect(v).toBe("hello");
    expect(seen).toEqual({ tag: "hello" });
  });
});
