import { describe, it, expect } from "vitest";
import { PromptRunner, PromptBailout } from "./promptRunner.js";

/** Build a PromptRunner with stub deps. Override fields as needed. */
function makeRunner(overrides: Partial<any> = {}) {
  const self: any = {};
  const ctx: any = {
    checkpoints: {
      create: () => 1,
      get: () => ({ moduleId: "", scopeName: "", stepPath: "" }),
    },
    statelogClient: { checkpointCreated: () => {} },
  };
  const opts = {
    self,
    ctx,
    stateStack: {} as any,
    checkpointInfo: undefined,
    snapshotMessages: () => [],
    ...overrides,
  };
  return { runner: new PromptRunner(opts), self, ctx };
}

/** Build an Interrupt-shaped object (matches `isInterrupt`'s `type === "interrupt"`). */
function fakeInterrupt(kind = "k"): any {
  return {
    type: "interrupt",
    kind,
    interruptId: "i-1",
    interruptData: {},
    checkpoint: undefined,
  };
}

describe("PromptRunner.step", () => {
  it("runs the body on first call and marks it completed", async () => {
    const { runner, self } = makeRunner();
    let ran = 0;
    await runner.step("a", async () => { ran++; });
    expect(ran).toBe(1);
    expect(self.runnerState.completedSteps.a).toBe(true);
  });

  it("skips a body whose key is already completed (resume case)", async () => {
    const self: any = { runnerState: { completedSteps: { a: true } } };
    const { runner } = makeRunner({ self });
    let ran = 0;
    await runner.step("a", async () => { ran++; });
    expect(ran).toBe(0);
  });
});

describe("PromptRunner.step interrupt handling", () => {
  it("throws PromptBailout when the body returns interrupts", async () => {
    const { runner } = makeRunner();
    await expect(
      runner.step("a", async () => [fakeInterrupt()] as any),
    ).rejects.toBeInstanceOf(PromptBailout);
  });

  it("does NOT mark the key completed when bailing", async () => {
    const { runner, self } = makeRunner();
    await runner.step("a", async () => [fakeInterrupt()] as any).catch(() => {});
    expect(self.runnerState.completedSteps.a).toBeUndefined();
  });

  it("snapshots messages and stamps a checkpoint with the per-key stepPath", async () => {
    let createdWith: any;
    const ctx: any = {
      checkpoints: {
        create: (_s: any, _c: any, info: any) => { createdWith = info; return 42; },
        get: () => ({ moduleId: "m", scopeName: "s", stepPath: "p/a" }),
      },
      statelogClient: { checkpointCreated: () => {} },
    };
    const self: any = {};
    const snapshots: any[] = [];
    const runner = new PromptRunner({
      self,
      ctx,
      stateStack: {} as any,
      checkpointInfo: { moduleId: "m", scopeName: "s", stepPath: "p" },
      snapshotMessages: () => {
        snapshots.push("snapshot");
        return [{ role: "user", content: "hi" }] as any;
      },
    });
    const intr = fakeInterrupt();
    await runner.step("a", async () => [intr] as any).catch(() => {});
    // stepPath is `${basePath}/${key}` so the per-call key (`a`) is
    // appended to the runPrompt-level checkpointInfo.stepPath (`p`).
    expect(createdWith.moduleId).toBe("m");
    expect(createdWith.scopeName).toBe("s");
    expect(createdWith.stepPath).toBe("p/a");
    expect(self.messagesJSON).toEqual([{ role: "user", content: "hi" }]);
    expect(snapshots.length).toBe(1);
    expect(intr.checkpointId).toBe(42);
  });

  it("uses the bare key as stepPath when checkpointInfo is undefined", async () => {
    let createdWith: any;
    const ctx: any = {
      checkpoints: {
        create: (_s: any, _c: any, info: any) => { createdWith = info; return 7; },
        get: () => ({ moduleId: "", scopeName: "", stepPath: "a" }),
      },
      statelogClient: { checkpointCreated: () => {} },
    };
    const runner = new PromptRunner({
      self: {},
      ctx,
      stateStack: {} as any,
      checkpointInfo: undefined,
      snapshotMessages: () => [],
    });
    await runner.step("a", async () => [fakeInterrupt()] as any).catch(() => {});
    expect(createdWith.stepPath).toBe("a");
  });

  it("notifies the statelog client of the new checkpoint with reason=interrupt", async () => {
    const logged: any[] = [];
    const ctx: any = {
      checkpoints: {
        create: () => 5,
        get: () => ({ moduleId: "m", scopeName: "s", stepPath: "p/a" }),
      },
      statelogClient: {
        checkpointCreated: (args: any) => { logged.push(args); },
      },
    };
    const runner = new PromptRunner({
      self: {},
      ctx,
      stateStack: {} as any,
      checkpointInfo: { moduleId: "m", scopeName: "s", stepPath: "p" },
      snapshotMessages: () => [],
    });
    await runner.step("a", async () => [fakeInterrupt()] as any).catch(() => {});
    expect(logged.length).toBe(1);
    expect(logged[0].checkpointId).toBe(5);
    expect(logged[0].reason).toBe("interrupt");
    expect(logged[0].sourceLocation).toEqual({
      moduleId: "m",
      scopeName: "s",
      stepPath: "p/a",
    });
  });
});

describe("PromptRunner.parallel", () => {
  it("runs every branch concurrently", async () => {
    const { runner } = makeRunner();
    const order: string[] = [];
    await runner.parallel("group", ["a", "b", "c"], async (item, b) => {
      await b.step(`${item}.s1`, async () => {
        order.push(`start-${item}`);
      });
      await new Promise((r) => setTimeout(r, 5));
      await b.step(`${item}.s2`, async () => {
        order.push(`end-${item}`);
      });
    });
    // All three starts happen before any end (concurrent).
    expect(order.indexOf("start-c")).toBeLessThan(order.indexOf("end-a"));
  });

  it("merges interrupts from multiple branches into one bailout with one shared checkpoint", async () => {
    let cpCount = 0;
    const ctx: any = {
      checkpoints: {
        create: () => {
          cpCount++;
          return 100 + cpCount;
        },
        get: () => ({ moduleId: "", scopeName: "", stepPath: "" }),
      },
      statelogClient: { checkpointCreated: () => {} },
    };
    const { runner } = makeRunner({ ctx });
    let caught: PromptBailout | null = null;
    try {
      await runner.parallel("group", ["a", "b"], async (item, b) => {
        await b.step(`${item}.s1`, async () => [fakeInterrupt(item)] as any);
      });
    } catch (e) {
      if (e instanceof PromptBailout) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.interrupts.length).toBe(2);
    expect(cpCount).toBe(1);
    expect(caught!.interrupts.every((i) => i.checkpointId === 101)).toBe(
      true,
    );
  });

  it("skips a branch step whose key was already completed on a prior pass", async () => {
    const self: any = { runnerState: { completedSteps: { "a.s1": true } } };
    const { runner } = makeRunner({ self });
    let ran = 0;
    await runner.parallel("group", ["a"], async (item, b) => {
      await b.step(`${item}.s1`, async () => {
        ran++;
      });
    });
    expect(ran).toBe(0);
  });

  it("once a branch step has collected interrupts, later steps on that branch are no-ops", async () => {
    const { runner } = makeRunner();
    let later = 0;
    try {
      await runner.parallel("group", ["a"], async (item, b) => {
        await b.step(`${item}.s1`, async () => [fakeInterrupt(item)] as any);
        await b.step(`${item}.s2`, async () => {
          later++;
        });
      });
    } catch {
      // expected PromptBailout
    }
    expect(later).toBe(0);
  });

  it("does NOT create a checkpoint when no branch collects interrupts", async () => {
    let cpCount = 0;
    const ctx: any = {
      checkpoints: {
        create: () => {
          cpCount++;
          return 100 + cpCount;
        },
        get: () => ({ moduleId: "", scopeName: "", stepPath: "" }),
      },
      statelogClient: { checkpointCreated: () => {} },
    };
    const { runner } = makeRunner({ ctx });
    await runner.parallel("group", ["a", "b"], async (item, b) => {
      await b.step(`${item}.s1`, async () => {});
    });
    expect(cpCount).toBe(0);
  });
});
