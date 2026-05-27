import { describe, it, expect } from "vitest";
import { agency } from "./agency.js";
import { agencyStore } from "./asyncContext.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { RestoreSignal } from "./errors.js";
import { CostGuard } from "./guard.js";
import { makeMockCtx } from "./__tests__/testHelpers.js";

function setup() {
  const ctx = new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
  const stack = new StateStack();
  const threads = new ThreadStore();
  return { ctx, stack, threads };
}

describe("agency.ctx / agency.ctxMaybe", () => {
  it("ctx returns the active RuntimeContext inside a frame", () => {
    const env = setup();
    agency.withTestContext(env, () => {
      expect(agency.ctx()).toBe(env.ctx);
    });
  });

  it("ctx throws when called outside any frame", () => {
    expect(() => agency.ctx()).toThrow(/outside an Agency execution frame/);
  });

  it("ctxMaybe returns undefined outside any frame", () => {
    expect(agency.ctxMaybe()).toBeUndefined();
  });

  it("ctxMaybe returns the ctx inside a frame", () => {
    const env = setup();
    agency.withTestContext(env, () => {
      expect(agency.ctxMaybe()).toBe(env.ctx);
    });
  });
});

describe("agency.callsite", () => {
  it("returns undefined when no callsite installed", () => {
    const env = setup();
    agency.withTestContext(env, () => {
      expect(agency.callsite()).toBeUndefined();
    });
  });

  it("withCallsite installs a callsite that callsite() reads", () => {
    const env = setup();
    agency.withTestContext(env, () => {
      const loc = { moduleId: "m", scopeName: "s", stepPath: "1.2" };
      agency.withCallsite(loc, () => {
        expect(agency.callsite()).toEqual(loc);
      });
      expect(agency.callsite()).toBeUndefined();
    });
  });

  it("callsite returns undefined outside any frame", () => {
    expect(agency.callsite()).toBeUndefined();
  });
});

describe("agency.global", () => {
  it("reads from ctx.globals with explicit moduleId", () => {
    const env = setup();
    env.ctx.globals.set("modA", "key1", "val1");
    agency.withTestContext(env, () => {
      expect(agency.global("key1", "modA")).toBe("val1");
    });
  });

  it("uses empty moduleId by default", () => {
    const env = setup();
    env.ctx.globals.set("", "bareKey", "bareVal");
    agency.withTestContext(env, () => {
      expect(agency.global("bareKey")).toBe("bareVal");
    });
  });
});

describe("agency.thread (subnamespace)", () => {
  it("current returns the active MessageThread, creating one if needed", () => {
    const env = setup();
    agency.withTestContext(env, () => {
      const t = agency.thread.current();
      expect(t).toBe(env.threads.getOrCreateActive());
    });
  });

  for (const [method, role] of [
    ["user", "user"],
    ["system", "system"],
    ["assistant", "assistant"],
  ] as const) {
    it(`${method} pushes a ${role}-role message`, () => {
      const env = setup();
      agency.withTestContext(env, () => {
        (agency.thread as any)[method]("hi");
        const msgs = env.threads.getOrCreateActive().messages;
        expect(msgs.length).toBe(1);
        expect(msgs[0].role).toBe(role);
        expect(msgs[0].content).toBe("hi");
      });
    });
  }

  it("store returns the active ThreadStore; throws outside a frame", () => {
    expect(() => agency.thread.store()).toThrow();
    const env = setup();
    agency.withTestContext(env, () => {
      expect(agency.thread.store()).toBe(env.threads);
    });
  });

  it("storeMaybe returns undefined outside a frame", () => {
    expect(agency.thread.storeMaybe()).toBeUndefined();
    const env = setup();
    agency.withTestContext(env, () => {
      expect(agency.thread.storeMaybe()).toBe(env.threads);
    });
  });

  it("with pushes/pops the active stack on normal return", async () => {
    const env = setup();
    // Seed a base active id so we can observe restoration.
    env.threads.getOrCreateActive();
    await agency.withTestContext(env, async () => {
      const base = env.threads.activeId();
      await agency.thread.with("aux", async () => {
        expect(env.threads.activeId()).toBe("aux");
      });
      expect(env.threads.activeId()).toBe(base);
    });
  });

  it("with pops the active stack on throw", async () => {
    const env = setup();
    env.threads.getOrCreateActive();
    await agency.withTestContext(env, async () => {
      const base = env.threads.activeId();
      await expect(
        agency.thread.with("aux", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(env.threads.activeId()).toBe(base);
    });
  });
});

describe("agency.checkpoint / getCheckpoint / restore", () => {
  // Checkpoint creation requires a node id on the state stack;
  // `makeMockCtx()` pre-seeds one ("process"), matching what
  // `checkpoint.test.ts` does.

  it("checkpoint + getCheckpoint round-trip", async () => {
    const ctx = makeMockCtx();
    const id = await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
      () => agency.checkpoint(),
    );
    const cp = agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
      () => agency.getCheckpoint(id),
    );
    expect(cp.id).toBe(id);
  });

  it("restore throws RestoreSignal", async () => {
    const ctx = makeMockCtx();
    const id = await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
      () => agency.checkpoint(),
    );
    expect(() =>
      agency.withTestContext(
        { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
        () => agency.restore(id),
      ),
    ).toThrow(RestoreSignal);
  });
});

describe("agency.withHandler", () => {
  it("pushes/pops handler on normal return", async () => {
    const env = setup();
    await agency.withTestContext(env, async () => {
      const before = env.ctx.handlers.length;
      let lenDuring = -1;
      await agency.withHandler(
        async () => ({ type: "approve" as const, value: undefined }),
        async () => {
          lenDuring = env.ctx.handlers.length;
        },
      );
      expect(lenDuring).toBe(before + 1);
      expect(env.ctx.handlers.length).toBe(before);
    });
  });

  it("pops handler on throw", async () => {
    const env = setup();
    await agency.withTestContext(env, async () => {
      const before = env.ctx.handlers.length;
      await expect(
        agency.withHandler(
          async () => ({ type: "approve" as const, value: undefined }),
          async () => {
            throw new Error("x");
          },
        ),
      ).rejects.toThrow("x");
      expect(env.ctx.handlers.length).toBe(before);
    });
  });
});

describe("agency.withCostGuard", () => {
  it("pushes a CostGuard for the duration of fn and pops on return", async () => {
    const env = setup();
    await agency.withTestContext(env, async () => {
      const before = env.ctx.stateStack.guards.length;
      let lenDuring = -1;
      let kindDuring: unknown;
      await agency.withCostGuard(0.5, async () => {
        lenDuring = env.ctx.stateStack.guards.length;
        kindDuring = env.ctx.stateStack.guards[lenDuring - 1];
      });
      expect(lenDuring).toBe(before + 1);
      expect(kindDuring).toBeInstanceOf(CostGuard);
      expect(env.ctx.stateStack.guards.length).toBe(before);
    });
  });

  it("pops guard on throw", async () => {
    const env = setup();
    await agency.withTestContext(env, async () => {
      const before = env.ctx.stateStack.guards.length;
      await expect(
        agency.withCostGuard(0.5, async () => {
          throw new Error("x");
        }),
      ).rejects.toThrow("x");
      expect(env.ctx.stateStack.guards.length).toBe(before);
    });
  });
});

describe("agency.withTestContext", () => {
  it("installs a usable frame and tears it down", () => {
    const env = setup();
    agency.withTestContext(env, () => {
      expect(agency.ctxMaybe()).toBe(env.ctx);
      expect(agency.thread.storeMaybe()).toBe(env.threads);
    });
    expect(agency.ctxMaybe()).toBeUndefined();
    expect(agencyStore.getStore()).toBeUndefined();
  });
});
