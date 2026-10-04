import { describe, it, expect } from "vitest";
import {
  agencyStore,
  callPlain,
  logOf,
  getRuntimeContext,
  withRun,
  runInBootstrapFrame,
  runInTestContext,
  withCallsite,
  withPushedHandler,
  lineageOf,
  WrongRunError,
} from "./asyncContext.js";
import { BootstrapThreadStore } from "./state/bootstrapThreadStore.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";

function makeStore() {
  const ctx = new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
  const stack = new StateStack();
  const threads = new ThreadStore();
  return {
    ctx,
    stack,
    threads,
    globals: ctx.globals,
    log: logOf(ctx, ctx.globals),
    ...lineageOf(undefined),
  };
}

describe("agencyStore", () => {
  it("throws when called outside a frame", () => {
    expect(() => getRuntimeContext()).toThrow(/outside an Agency run/);
  });

  it("returns the run inside withRun", () => {
    const seed = makeStore();
    withRun(seed, (run) => {
      const s = getRuntimeContext();
      expect(s).toBe(run);
      expect(s.ctx).toBe(seed.ctx);
      expect(s.stack).toBe(seed.stack);
      expect(s.threads).toBe(seed.threads);
    });
  });

  it("runInTestContext seeds the store identically", () => {
    const seed = makeStore();
    runInTestContext(seed.ctx, seed.stack, seed.threads, () => {
      const s = getRuntimeContext();
      expect(s.ctx).toBe(seed.ctx);
    });
  });

  it("is readable until the first await, and throws after it", async () => {
    const seed = makeStore();
    await withRun(seed, async () => {
      expect(getRuntimeContext().ctx).toBe(seed.ctx);
      await Promise.resolve();
      expect(() => getRuntimeContext()).toThrow(/read after an await/);
      await new Promise((r) => setTimeout(r, 1));
      expect(() => getRuntimeContext()).toThrow(/read after an await/);
      // The frame itself still follows the async flow.
      expect(agencyStore.getStore()).toBe(seed);
    });
  });

  it("the frame propagates across setImmediate, and the run is not readable there", async () => {
    const seed = makeStore();
    await withRun(seed, async () => {
      const seen = await new Promise<{ frame: unknown; error: unknown }>((resolve) =>
        setImmediate(() => {
          let error: unknown;
          try {
            getRuntimeContext();
          } catch (e) {
            error = e;
          }
          resolve({ frame: agencyStore.getStore(), error });
        }),
      );
      expect(seen.frame).toBe(seed);
      expect(String(seen.error)).toMatch(/read after an await/);
    });
  });

  it("the frame propagates across Promise.all branches", async () => {
    const seed = makeStore();
    await withRun(seed, async () => {
      const results = await Promise.all([
        Promise.resolve().then(() => agencyStore.getStore()?.ctx),
        Promise.resolve().then(() => agencyStore.getStore()?.ctx),
      ]);
      expect(results[0]).toBe(seed.ctx);
      expect(results[1]).toBe(seed.ctx);
    });
  });

  it("callPlain makes the run readable for the synchronous part of one call", async () => {
    const seed = makeStore();
    await withRun(seed, async (run) => {
      await Promise.resolve();
      expect(callPlain(run, getRuntimeContext, [])).toBe(run);
      // The call is over, so the run is no longer readable.
      expect(() => getRuntimeContext()).toThrow(/read after an await/);
    });
  });

  it("callPlain puts the previous run back when the function throws", async () => {
    // One module variable serves the whole process. If a throw skipped the
    // restore, the next helper would read another request's run.
    const outer = makeStore();
    const inner = makeStore();
    await withRun(outer, async (outerRun) => {
      await Promise.resolve();
      callPlain(outerRun, () => {
        expect(() =>
          withRun(inner, (innerRun) =>
            callPlain(innerRun, () => {
              throw new Error("helper failed");
            }, []),
          ),
        ).toThrow("helper failed");
        // Back in the outer call: the outer run is readable again.
        expect(getRuntimeContext()).toBe(outerRun);
      }, []);
      // And after the outer call nothing is left behind.
      expect(() => getRuntimeContext()).toThrow(/read after an await/);
    });
  });

  it("nested frames shadow per-branch state", async () => {
    const outer = makeStore();
    const innerStack = new StateStack();
    const innerThreads = new ThreadStore();
    await withRun(outer, async (outerRun) => {
      expect(getRuntimeContext().stack).toBe(outer.stack);
      await withRun({ ...outer, stack: innerStack, threads: innerThreads }, async () => {
        expect(getRuntimeContext().stack).toBe(innerStack);
        expect(getRuntimeContext().threads).toBe(innerThreads);
        expect(getRuntimeContext().ctx).toBe(outer.ctx);
      });
      expect(callPlain(outerRun, getRuntimeContext, []).stack).toBe(outer.stack);
    });
  });

  it("frames in concurrent branches are isolated", async () => {
    const a = makeStore();
    const b = makeStore();
    const sawA: any[] = [];
    const sawB: any[] = [];
    await Promise.all([
      withRun(a, async (run) => {
        await new Promise((r) => setTimeout(r, 5));
        sawA.push(callPlain(run, getRuntimeContext, []).ctx);
        // The other branch's run is not this branch's frame.
        expect(() => callPlain(b, getRuntimeContext, [])).toThrow(WrongRunError);
      }),
      withRun(b, async (run) => {
        await new Promise((r) => setTimeout(r, 2));
        sawB.push(callPlain(run, getRuntimeContext, []).ctx);
      }),
    ]);
    expect(sawA[0]).toBe(a.ctx);
    expect(sawB[0]).toBe(b.ctx);
  });
});

describe("runInBootstrapFrame", () => {
  it("seeds ctx + a BootstrapThreadStore on the frame", async () => {
    const seed = makeStore();
    await runInBootstrapFrame(seed.ctx, async () => {
      const s = getRuntimeContext();
      expect(s.ctx).toBe(seed.ctx);
      expect(s.stack).toBe(seed.ctx.stateStack);
      expect(s.threads).toBeInstanceOf(BootstrapThreadStore);
    });
  });

  it("threads slot throws on user-facing ops", async () => {
    const seed = makeStore();
    await runInBootstrapFrame(seed.ctx, async () => {
      const { threads } = getRuntimeContext();
      expect(() => threads.getOrCreateActive()).toThrow(/Message threads are not available/);
    });
  });

  it("returns the wrapped fn's resolved value", async () => {
    const seed = makeStore();
    const out = await runInBootstrapFrame(seed.ctx, async () => 42);
    expect(out).toBe(42);
  });
});

describe("withCallsite", () => {
  it("installs callsite on the active frame", () => {
    const seed = makeStore();
    runInTestContext(seed.ctx, seed.stack, seed.threads, (run) => {
      expect(agencyStore.getStore()?.callsite).toBeUndefined();
      withCallsite(run, { moduleId: "m", scopeName: "s", stepPath: "1.2" }, () => {
        expect(getRuntimeContext().callsite).toEqual({
          moduleId: "m",
          scopeName: "s",
          stepPath: "1.2",
        });
      });
      expect(agencyStore.getStore()?.callsite).toBeUndefined();
    });
  });

  it("nests; inner overrides, outer restored on return", () => {
    const seed = makeStore();
    runInTestContext(seed.ctx, seed.stack, seed.threads, (run) => {
      withCallsite(run, { moduleId: "m", scopeName: "outer", stepPath: "" }, (outer) => {
        withCallsite(outer, { moduleId: "m", scopeName: "inner", stepPath: "1" }, () => {
          expect(getRuntimeContext().callsite?.scopeName).toBe("inner");
        });
        expect(getRuntimeContext().callsite?.scopeName).toBe("outer");
      });
    });
  });

  it("throws outside an agency frame", () => {
    // A run from a frame that has already ended is refused: no run is current.
    const seed = makeStore();
    const stale = runInTestContext(seed.ctx, seed.stack, seed.threads, (run) => run);
    expect(() =>
      withCallsite(stale, { moduleId: "", scopeName: "", stepPath: "" }, () => 1),
    ).toThrow(WrongRunError);
  });

  it("preserves ctx/stack/threads from the parent frame", () => {
    const seed = makeStore();
    runInTestContext(seed.ctx, seed.stack, seed.threads, (run) => {
      withCallsite(run, { moduleId: "m", scopeName: "s", stepPath: "1" }, () => {
        const s = getRuntimeContext();
        expect(s.ctx).toBe(seed.ctx);
        expect(s.stack).toBe(seed.stack);
        expect(s.threads).toBe(seed.threads);
      });
    });
  });
});

describe("withPushedHandler", () => {
  const noopHandler = async () => ({ type: "propagate" as const });

  it("pops on normal return", async () => {
    const seed = makeStore();
    await runInTestContext(seed.ctx, seed.stack, seed.threads, async () => {
      const before = seed.ctx.handlers.length;
      const result = await withPushedHandler(seed.ctx, noopHandler, async () => "result");
      expect(result).toBe("result");
      expect(seed.ctx.handlers.length).toBe(before);
    });
  });

  it("pops on throw", async () => {
    const seed = makeStore();
    await runInTestContext(seed.ctx, seed.stack, seed.threads, async () => {
      const before = seed.ctx.handlers.length;
      await expect(
        withPushedHandler(seed.ctx, noopHandler, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(seed.ctx.handlers.length).toBe(before);
    });
  });

  it("installs the handler for the duration of fn", async () => {
    const seed = makeStore();
    await runInTestContext(seed.ctx, seed.stack, seed.threads, async () => {
      const before = seed.ctx.handlers.length;
      let lenDuring = -1;
      await withPushedHandler(seed.ctx, noopHandler, async () => {
        lenDuring = seed.ctx.handlers.length;
      });
      expect(lenDuring).toBe(before + 1);
      expect(seed.ctx.handlers.length).toBe(before);
    });
  });
});
