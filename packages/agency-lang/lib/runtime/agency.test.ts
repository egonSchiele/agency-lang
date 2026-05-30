import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agency } from "./agency.js";
import { agencyStore } from "./asyncContext.js";
import { RuntimeContext } from "./state/context.js";
import { StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { RestoreSignal } from "./errors.js";
import { CostGuard, TimeGuard } from "./guard.js";
import { _resetStoreRegistry } from "./memory/index.js";
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

describe("agency.threads (registry subnamespace)", () => {
  it("list throws outside a frame (silent [] would mask misuse)", () => {
    expect(() => agency.threads.list()).toThrow(/outside an Agency frame/);
  });

  it("get throws outside a frame", () => {
    expect(() => agency.threads.get("t0")).toThrow(/outside an Agency frame/);
  });

  it("current returns undefined outside a frame", () => {
    expect(agency.threads.current()).toBeUndefined();
  });

  it("get returns [] for an unknown id", () => {
    const env = setup();
    agency.withTestContext(env, () => {
      expect(agency.threads.get("tDoesNotExist")).toEqual([]);
    });
  });

  it("list returns every thread with slug ids and correct isActive flag", () => {
    const env = setup();
    // Seed an active root thread, then create a second thread.
    env.threads.getOrCreateActive();           // raw id "0", pushed active
    env.threads.create();                       // raw id "1", not active
    agency.withTestContext(env, () => {
      const list = agency.threads.list();
      expect(list.map((t) => t.id)).toEqual(["t0", "t1"]);
      expect(list[0].isActive).toBe(true);
      expect(list[1].isActive).toBe(false);
      expect(list[0].threadType).toBe("thread");
      expect(list[0].parentId).toBeNull();
    });
  });

  it("subthreads surface threadType and parentId", () => {
    const env = setup();
    const parentId = env.threads.create();
    env.threads.pushActive(parentId);
    const childId = env.threads.createSubthread();
    agency.withTestContext(env, () => {
      const list = agency.threads.list();
      const child = list.find((t) => t.id === `t${childId}`);
      expect(child).toBeDefined();
      expect(child!.threadType).toBe("subthread");
      expect(child!.parentId).toBe(`t${parentId}`);
    });
  });

  it("get returns a sliced view of messages", async () => {
    const env = setup();
    env.threads.getOrCreateActive();
    await agency.withTestContext(env, async () => {
      agency.thread.user("hello");
      agency.thread.assistant("hi there");
      const all = agency.threads.get("t0", 0, 10);
      expect(all.length).toBe(2);
      expect(all[0]).toEqual({ role: "user", content: "hello" });
      expect(all[1]).toEqual({ role: "assistant", content: "hi there" });
      const first = agency.threads.get("t0", 0, 1);
      expect(first.length).toBe(1);
      expect(first[0].role).toBe("user");
    });
  });

  it("current returns the active id in slug form", () => {
    const env = setup();
    env.threads.getOrCreateActive();
    agency.withTestContext(env, () => {
      expect(agency.threads.current()).toBe("t0");
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
  it("pushes a CostGuard onto the ALS stack for the duration of fn", async () => {
    const env = setup();
    await agency.withTestContext(env, async () => {
      const before = env.stack.guards.length;
      let lenDuring = -1;
      let kindDuring: unknown;
      await agency.withCostGuard(0.5, async () => {
        lenDuring = env.stack.guards.length;
        kindDuring = env.stack.guards[lenDuring - 1];
      });
      expect(lenDuring).toBe(before + 1);
      expect(kindDuring).toBeInstanceOf(CostGuard);
      expect(env.stack.guards.length).toBe(before);
    });
  });

  it("targets the ALS stack, not ctx.stateStack (per-branch isolation)", async () => {
    // Simulates a fork branch: pass a fresh stack as the ALS stack,
    // distinct from ctx.stateStack. The guard must land on the ALS
    // stack so it stays branch-local.
    const env = setup();
    const branchStack = new StateStack();
    await agency.withTestContext(
      { ctx: env.ctx, stack: branchStack, threads: env.threads },
      async () => {
        await agency.withCostGuard(0.5, async () => {
          expect(branchStack.guards.length).toBe(1);
          expect(env.ctx.stateStack.guards.length).toBe(0);
        });
      },
    );
    expect(branchStack.guards.length).toBe(0);
    expect(env.ctx.stateStack.guards.length).toBe(0);
  });

  it("pops guard on throw", async () => {
    const env = setup();
    await agency.withTestContext(env, async () => {
      const before = env.stack.guards.length;
      await expect(
        agency.withCostGuard(0.5, async () => {
          throw new Error("x");
        }),
      ).rejects.toThrow("x");
      expect(env.stack.guards.length).toBe(before);
    });
  });
});

describe("agency.withTimeGuard", () => {
  it("pushes a TimeGuard onto the ALS stack and pops on return", async () => {
    const env = setup();
    await agency.withTestContext(env, async () => {
      const before = env.stack.guards.length;
      let lenDuring = -1;
      let kindDuring: unknown;
      await agency.withTimeGuard(60_000, async () => {
        lenDuring = env.stack.guards.length;
        kindDuring = env.stack.guards[lenDuring - 1];
      });
      expect(lenDuring).toBe(before + 1);
      expect(kindDuring).toBeInstanceOf(TimeGuard);
      expect(env.stack.guards.length).toBe(before);
    });
  });

  it("pops guard on throw", async () => {
    const env = setup();
    await agency.withTestContext(env, async () => {
      const before = env.stack.guards.length;
      await expect(
        agency.withTimeGuard(60_000, async () => {
          throw new Error("x");
        }),
      ).rejects.toThrow("x");
      expect(env.stack.guards.length).toBe(before);
    });
  });
});

describe("agency.addCost", () => {
  it("adds to the ALS stack's localCost", () => {
    const env = setup();
    agency.withTestContext(env, () => {
      const before = env.stack.localCost;
      agency.addCost(0.25);
      expect(env.stack.localCost).toBe(before + 0.25);
    });
  });

  it("charges every installed guard and trips when over budget", async () => {
    const env = setup();
    await agency.withTestContext(env, async () => {
      await expect(
        agency.withCostGuard(0.1, async () => {
          agency.addCost(0.05); // under
          agency.addCost(0.10); // total 0.15 > 0.1 — trips
        }),
      ).rejects.toThrow();
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

describe("agency.memory.*", () => {
  let tmpRoot: string;

  function makeMemCtx(memory?: { dir: string }) {
    const ctx = new RuntimeContext({
      statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false, observability: false },
      smoltalkDefaults: {},
      dirname: process.cwd(),
      memory,
    });
    return ctx;
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agencymem-"));
    _resetStoreRegistry();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    _resetStoreRegistry();
  });

  it("agency.memory.enabled returns false when no frame is active", async () => {
    const ctx = makeMemCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    agency.withTestContext(
      { ctx: execCtx, stack: execCtx.stateStack, threads: new ThreadStore() },
      () => {
        expect(agency.memory.enabled()).toBe(false);
      },
    );
  });

  it("agency.memory.enable pushes a frame and enabled() returns true", async () => {
    const ctx = makeMemCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await agency.withTestContext(
      { ctx: execCtx, stack: execCtx.stateStack, threads: new ThreadStore() },
      async () => {
        await agency.memory.enable({ dir: tmpRoot });
        expect(agency.memory.enabled()).toBe(true);
      },
    );
  });

  it("agency.memory.disable pops the active frame; enabled() returns false again", async () => {
    const ctx = makeMemCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await agency.withTestContext(
      { ctx: execCtx, stack: execCtx.stateStack, threads: new ThreadStore() },
      async () => {
        await agency.memory.enable({ dir: tmpRoot });
        expect(agency.memory.enabled()).toBe(true);
        agency.memory.disable();
        expect(agency.memory.enabled()).toBe(false);
      },
    );
  });

  it("agency.memory.setId updates the memoryId on the active stack", async () => {
    const ctx = makeMemCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await agency.withTestContext(
      { ctx: execCtx, stack: execCtx.stateStack, threads: new ThreadStore() },
      async () => {
        await agency.memory.enable({ dir: tmpRoot });
        await agency.memory.setId("alice");
        expect(execCtx.stateStack.other.memoryId).toBe("alice");
      },
    );
  });

  it("agency.memory.remember / recall round-trips through the active store", async () => {
    const ctx = makeMemCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await agency.withTestContext(
      { ctx: execCtx, stack: execCtx.stateStack, threads: new ThreadStore() },
      async () => {
        await agency.memory.enable({ dir: tmpRoot });
        await agency.memory.setId("alice");
        // remember + forget rely on LLM calls so we skip them here;
        // call recall to exercise the wiring and assert it returns a
        // string (empty when there is nothing to recall).
        const r = await agency.memory.recall("anything");
        expect(typeof r).toBe("string");
      },
    );
  });

  it("agency.memory.forget no-ops when memory is off", async () => {
    const ctx = makeMemCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await agency.withTestContext(
      { ctx: execCtx, stack: execCtx.stateStack, threads: new ThreadStore() },
      async () => {
        // No enableMemory call → forget should resolve to undefined.
        await expect(agency.memory.forget("anything")).resolves.toBeUndefined();
      },
    );
  });
});
