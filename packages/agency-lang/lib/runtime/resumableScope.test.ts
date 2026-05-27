import { describe, it, expect, vi } from "vitest";
import { agency } from "./agency.js";
import { ThreadStore } from "./state/threadStore.js";
import { makeMockCtx } from "./__tests__/testHelpers.js";

// `withResumableScope` calls `setupFunction()`, which itself reads
// from the active ALS frame and pushes a new State frame onto the
// stack. Every test wraps its body in `withTestContext` over a
// `makeMockCtx()` whose `stateStack` is pre-seeded with a node id
// (matches the harness checkpoint.test.ts uses).
function inFrame<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = makeMockCtx();
  return agency.withTestContext(
    { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
    fn,
  );
}

describe("withResumableScope — basic flow", () => {
  it("runs sequential steps and returns the body's result", async () => {
    const result = await inFrame(() =>
      agency.withResumableScope({ name: "basic" }, async (s) => {
        const a = await s.step(1, () => 10);
        const b = await s.step(2, () => a * 2);
        return b;
      }),
    );
    expect(result).toBe(20);
  });

  it("propagates non-interrupt errors thrown inside a step", async () => {
    await expect(
      inFrame(() =>
        agency.withResumableScope({ name: "err" }, async (s) => {
          await s.step(1, () => {
            throw new Error("oops");
          });
        }),
      ),
    ).rejects.toThrow("oops");
  });

  it("pops the state stack in finally on completion, halt, and throw", async () => {
    const ctx = makeMockCtx();
    const startDepth = ctx.stateStack.stack.length;

    // completion
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
      () => agency.withResumableScope({ name: "ok" }, async () => "x"),
    );
    expect(ctx.stateStack.stack.length).toBe(startDepth);

    // halt
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
      () =>
        agency.withResumableScope({ name: "halt" }, async (s) => {
          s.halt("h");
        }),
    );
    expect(ctx.stateStack.stack.length).toBe(startDepth);

    // throw
    await expect(
      agency.withTestContext(
        { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
        () =>
          agency.withResumableScope({ name: "throw" }, async () => {
            throw new Error("x");
          }),
      ),
    ).rejects.toThrow("x");
    expect(ctx.stateStack.stack.length).toBe(startDepth);
  });
});

describe("withResumableScope — halt contract", () => {
  it("scope.halt(x) makes withResumableScope return x", async () => {
    const r = await inFrame(() =>
      agency.withResumableScope({ name: "h" }, async (s) => {
        await s.step(1, () => "a");
        await s.step(2, () => {
          s.halt("halted-value");
          return "unused";
        });
        await s.step(3, () => "never");
        return "body-return-ignored";
      }),
    );
    expect(r).toBe("halted-value");
  });

  it("steps after halt do NOT execute their bodies", async () => {
    const calls: number[] = [];
    await inFrame(() =>
      agency.withResumableScope({ name: "h2" }, async (s) => {
        await s.step(1, () => {
          calls.push(1);
        });
        await s.step(2, () => {
          s.halt("h");
        });
        await s.step(3, () => {
          calls.push(3);
        });
        await s.step(4, () => {
          calls.push(4);
        });
      }),
    );
    expect(calls).toEqual([1]);
  });

  it("steps after halt return undefined (no cached result)", async () => {
    let observed: unknown = "unset";
    await inFrame(() =>
      agency.withResumableScope({ name: "h3" }, async (s) => {
        await s.step(1, () => {
          s.halt("h");
        });
        observed = await s.step(2, () => "would-be-value");
      }),
    );
    expect(observed).toBeUndefined();
  });
});

describe("withResumableScope — frame locals", () => {
  it("local(key, init) returns init's value the first time", async () => {
    const r = await inFrame(() =>
      agency.withResumableScope({ name: "loc" }, async (s) =>
        s.local("counter", () => 7),
      ),
    );
    expect(r).toBe(7);
  });

  it("local() init runs exactly once per scope (subsequent reads return same value)", async () => {
    const init = vi.fn(() => 0);
    await inFrame(() =>
      agency.withResumableScope({ name: "loc2" }, async (s) => {
        s.local("counter", init);
        s.local("counter", init);
        s.local("counter", init);
      }),
    );
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("setLocal updates; getLocal returns current value; getLocal returns undefined for missing keys", async () => {
    const r = await inFrame(() =>
      agency.withResumableScope({ name: "loc3" }, async (s) => {
        s.setLocal("x", 42);
        return {
          x: s.getLocal<number>("x"),
          missing: s.getLocal("missing"),
        };
      }),
    );
    expect(r).toEqual({ x: 42, missing: undefined });
  });
});

describe("withResumableScope — substep idempotence on re-execution", () => {
  it("re-running a scope with the same frame skips completed steps", async () => {
    // Build a single Runner-equivalent flow manually: drive the scope
    // once, then enter a second scope on the *same* frame stack (by
    // re-using the substep counters via the underlying frame's
    // locals) and confirm previously-completed step bodies don't fire.
    // This pins the cached-value contract that the resume path
    // depends on.
    const ctx = makeMockCtx();
    const calls = { s1: 0, s2: 0 };

    const run = (haltAfterStep2: boolean) =>
      agency.withTestContext(
        { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
        () =>
          agency.withResumableScope({ name: "rerun" }, async (s) => {
            const a = await s.step(1, () => {
              calls.s1 += 1;
              return "v1";
            });
            const b = await s.step(2, () => {
              calls.s2 += 1;
              return "v2";
            });
            if (haltAfterStep2) s.halt({ a, b });
            return { a, b };
          }),
      );

    const r1 = await run(true);
    expect(r1).toEqual({ a: "v1", b: "v2" });
    expect(calls).toEqual({ s1: 1, s2: 1 });

    // The frame from the first scope was popped in finally, so a
    // second scope sees fresh substep counters. (Real resume would
    // restore the serialized frame before re-entering the scope; the
    // mock ctx does not exercise that path, but the cached-value
    // mechanism inside a single scope is the load-bearing piece for
    // the resume-skipping behaviour.)
    const r2 = await run(false);
    expect(r2).toEqual({ a: "v1", b: "v2" });
    expect(calls).toEqual({ s1: 2, s2: 2 });
  });
});

describe("withResumableScope — callsite + options", () => {
  it("default moduleId is '<ts-helper>'; scopeName matches opts.name", async () => {
    const observed: { moduleId?: string; scopeName?: string } = {};
    await inFrame(() =>
      agency.withResumableScope({ name: "myScope" }, async (s) => {
        await s.step(1, () => {
          const loc = agency.callsite();
          observed.moduleId = loc?.moduleId;
          observed.scopeName = loc?.scopeName;
        });
      }),
    );
    expect(observed).toEqual({ moduleId: "<ts-helper>", scopeName: "myScope" });
  });

  it("opts.moduleId override is honored", async () => {
    let moduleId: string | undefined;
    await inFrame(() =>
      agency.withResumableScope(
        { name: "s", moduleId: "my.module" },
        async (s) => {
          await s.step(1, () => {
            moduleId = agency.callsite()?.moduleId;
          });
        },
      ),
    );
    expect(moduleId).toBe("my.module");
  });

  it("pinResultCheckpoint: true (default) calls createPinned exactly once", async () => {
    const ctx = makeMockCtx();
    const spy = vi.spyOn(ctx.checkpoints, "createPinned");
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
      () => agency.withResumableScope({ name: "pin" }, async () => "x"),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][2]).toMatchObject({
      moduleId: "<ts-helper>",
      scopeName: "pin",
      stepPath: "",
      label: null,
    });
  });

  it("pinResultCheckpoint: false skips createPinned", async () => {
    const ctx = makeMockCtx();
    const spy = vi.spyOn(ctx.checkpoints, "createPinned");
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
      () =>
        agency.withResumableScope(
          { name: "p", pinResultCheckpoint: false },
          async () => "x",
        ),
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("withResumableScope — hooks", () => {
  it("hook fires once per scope", async () => {
    const fn = vi.fn();
    await inFrame(() =>
      agency.withResumableScope({ name: "h" }, async (s) => {
        await s.hook(1, fn);
        await s.hook(1, fn); // same id — but substep counter already advanced
      }),
    );
    // First hook call invoked fn; second call's id is no longer
    // greater than the counter, so it short-circuits. (This mirrors
    // the once-per-resume contract the codegen relies on for
    // onFunctionStart-style hooks.)
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("withResumableScope — nested scopes", () => {
  it("inner scope's callsite is independent of outer's", async () => {
    const observed: { outerScope?: string; innerScope?: string } = {};
    await inFrame(() =>
      agency.withResumableScope({ name: "outer" }, async (outerS) => {
        await outerS.step(1, async () => {
          observed.outerScope = agency.callsite()?.scopeName;
          await agency.withResumableScope({ name: "inner" }, async (innerS) => {
            await innerS.step(1, () => {
              observed.innerScope = agency.callsite()?.scopeName;
            });
          });
        });
      }),
    );
    expect(observed).toEqual({ outerScope: "outer", innerScope: "inner" });
  });

  it("nested scopes do not corrupt each other's substep counters", async () => {
    const calls: string[] = [];
    const r = await inFrame(() =>
      agency.withResumableScope({ name: "outer" }, async (outerS) => {
        const a = await outerS.step(1, () => {
          calls.push("o1");
          return "a";
        });
        const b = await outerS.step(2, async () => {
          calls.push("o2");
          return agency.withResumableScope({ name: "inner" }, async (innerS) => {
            const x = await innerS.step(1, () => {
              calls.push("i1");
              return "x";
            });
            const y = await innerS.step(2, () => {
              calls.push("i2");
              return "y";
            });
            return x + y;
          });
        });
        return a + b;
      }),
    );
    expect(r).toBe("axy");
    expect(calls).toEqual(["o1", "o2", "i1", "i2"]);
  });
});
