import { describe, it, expect } from "vitest";
import {
  agencyStore,
  getRuntimeContext,
  runInBootstrapFrame,
  runInTestContext,
  withCallsite,
  withPushedHandler,
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
  return { ctx, stack, threads };
}

describe("agencyStore", () => {
  it("throws when called outside a frame", () => {
    expect(() => getRuntimeContext()).toThrow(/outside an Agency execution frame/);
  });

  it("returns the store inside agencyStore.run", () => {
    const seed = makeStore();
    agencyStore.run(seed, () => {
      const s = getRuntimeContext();
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

  it("propagates across await", async () => {
    const seed = makeStore();
    await agencyStore.run(seed, async () => {
      await Promise.resolve();
      const s = getRuntimeContext();
      expect(s.ctx).toBe(seed.ctx);
      await new Promise((r) => setTimeout(r, 1));
      expect(getRuntimeContext().ctx).toBe(seed.ctx);
    });
  });

  it("propagates across setImmediate", async () => {
    const seed = makeStore();
    await agencyStore.run(seed, async () => {
      await new Promise<void>((resolve) =>
        setImmediate(() => {
          expect(getRuntimeContext().ctx).toBe(seed.ctx);
          resolve();
        }),
      );
    });
  });

  it("propagates across Promise.all branches", async () => {
    const seed = makeStore();
    await agencyStore.run(seed, async () => {
      const results = await Promise.all([
        Promise.resolve().then(() => getRuntimeContext().ctx),
        Promise.resolve().then(() => getRuntimeContext().ctx),
      ]);
      expect(results[0]).toBe(seed.ctx);
      expect(results[1]).toBe(seed.ctx);
    });
  });

  it("nested frames shadow per-branch state", async () => {
    const outer = makeStore();
    const innerStack = new StateStack();
    const innerThreads = new ThreadStore();
    await agencyStore.run(outer, async () => {
      expect(getRuntimeContext().stack).toBe(outer.stack);
      await agencyStore.run(
        { ctx: outer.ctx, stack: innerStack, threads: innerThreads },
        async () => {
          expect(getRuntimeContext().stack).toBe(innerStack);
          expect(getRuntimeContext().threads).toBe(innerThreads);
          expect(getRuntimeContext().ctx).toBe(outer.ctx);
        },
      );
      expect(getRuntimeContext().stack).toBe(outer.stack);
    });
  });

  it("frames in concurrent branches are isolated", async () => {
    const a = makeStore();
    const b = makeStore();
    const sawA: any[] = [];
    const sawB: any[] = [];
    await Promise.all([
      agencyStore.run(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        sawA.push(getRuntimeContext().ctx);
      }),
      agencyStore.run(b, async () => {
        await new Promise((r) => setTimeout(r, 2));
        sawB.push(getRuntimeContext().ctx);
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
      expect(() => threads.getOrCreateActive()).toThrow(
        /Message threads are not available/,
      );
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
    runInTestContext(seed.ctx, seed.stack, seed.threads, () => {
      expect(agencyStore.getStore()?.callsite).toBeUndefined();
      withCallsite(
        { moduleId: "m", scopeName: "s", stepPath: "1.2" },
        () => {
          expect(getRuntimeContext().callsite).toEqual({
            moduleId: "m",
            scopeName: "s",
            stepPath: "1.2",
          });
        },
      );
      expect(agencyStore.getStore()?.callsite).toBeUndefined();
    });
  });

  it("nests; inner overrides, outer restored on return", () => {
    const seed = makeStore();
    runInTestContext(seed.ctx, seed.stack, seed.threads, () => {
      withCallsite(
        { moduleId: "m", scopeName: "outer", stepPath: "" },
        () => {
          withCallsite(
            { moduleId: "m", scopeName: "inner", stepPath: "1" },
            () => {
              expect(getRuntimeContext().callsite?.scopeName).toBe("inner");
            },
          );
          expect(getRuntimeContext().callsite?.scopeName).toBe("outer");
        },
      );
    });
  });

  it("throws outside an agency frame", () => {
    expect(() =>
      withCallsite({ moduleId: "", scopeName: "", stepPath: "" }, () => 1),
    ).toThrow(/outside an Agency execution frame/);
  });

  it("preserves ctx/stack/threads from the parent frame", () => {
    const seed = makeStore();
    runInTestContext(seed.ctx, seed.stack, seed.threads, () => {
      withCallsite(
        { moduleId: "m", scopeName: "s", stepPath: "1" },
        () => {
          const s = getRuntimeContext();
          expect(s.ctx).toBe(seed.ctx);
          expect(s.stack).toBe(seed.stack);
          expect(s.threads).toBe(seed.threads);
        },
      );
    });
  });
});

describe("withPushedHandler", () => {
  const noopHandler = async () => ({ type: "propagate" as const });

  it("pops on normal return", async () => {
    const seed = makeStore();
    await runInTestContext(seed.ctx, seed.stack, seed.threads, async () => {
      const before = seed.ctx.handlers.length;
      const result = await withPushedHandler(
        seed.ctx,
        noopHandler,
        async () => "result",
      );
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
