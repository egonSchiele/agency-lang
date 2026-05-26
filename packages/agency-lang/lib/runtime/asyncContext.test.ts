import { describe, it, expect } from "vitest";
import {
  agencyStore,
  getRuntimeContext,
  runInBootstrapFrame,
  runInTestContext,
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
