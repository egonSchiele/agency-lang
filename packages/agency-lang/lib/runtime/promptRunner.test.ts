import { describe, it, expect } from "vitest";
import { PromptRunner, PromptBailout } from "./promptRunner.js";
import { State, StateStack } from "./state/stateStack.js";

/** Stub statelog client. Includes the minimum surface PromptRunner touches:
 *  checkpointCreated for `step()`, snapshotStack / runInBranchContext for
 *  `parallel()`. The branch-context stub just calls the fn directly — the
 *  AsyncLocalStorage isolation isn't relevant to these unit tests. */
function stubStatelogClient(extras: Partial<any> = {}) {
  return {
    checkpointCreated: () => {},
    snapshotStack: () => undefined,
    runInBranchContext: (_s: any, fn: () => any) => fn(),
    ...extras,
  };
}

/** Build a PromptRunner with stub deps. Override fields as needed. The
 *  parallel() path requires a real StateStack/State so runBatch can do
 *  branch lifecycle; build them by default. */
function makeRunner(overrides: Partial<any> = {}) {
  const self: any = {};
  const ctx: any = {
    checkpoints: {
      create: () => 1,
      get: () => ({ moduleId: "", scopeName: "", stepPath: "" }),
    },
    statelogClient: stubStatelogClient(),
  };
  const stateStack = new StateStack();
  const parentFrame = new State();
  stateStack.stack.push(parentFrame);
  const opts = {
    self,
    ctx,
    stateStack,
    parentFrame,
    checkpointInfo: undefined,
    snapshotMessages: () => [],
    ...overrides,
  };
  return { runner: new PromptRunner(opts), self, ctx, parentFrame };
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
    expect(self.runnerState.completedSteps.includes("a")).toBe(true);
  });

  it("skips a body whose key is already completed (resume case)", async () => {
    const self: any = { runnerState: { completedSteps: ["a"] } };
    const { runner } = makeRunner({ self });
    let ran = 0;
    await runner.step("a", async () => { ran++; });
    expect(ran).toBe(0);
  });

  it("resume after bailout: re-runs body, succeeds, marks the key completed", async () => {
    // Round 1: body returns interrupts and bails. Round 2 (resume): the
    // user has responded to the interrupt, the body now returns void, and
    // the key gets marked completed. This is the core idempotent-resume
    // contract documented in docs/dev/promptRunner.md.
    const { runner, self } = makeRunner();
    let firstPass = true;
    const tryStep = () =>
      runner.step("a", async () => {
        if (firstPass) {
          firstPass = false;
          return [fakeInterrupt()] as any;
        }
      });
    await expect(tryStep()).rejects.toBeInstanceOf(PromptBailout);
    expect(self.runnerState.completedSteps.includes("a")).toBe(false);
    await tryStep();
    expect(self.runnerState.completedSteps.includes("a")).toBe(true);
  });

  it("sequential steps: second bails, first key stays marked completed", async () => {
    // The runPrompt code does `pr.step("initialLlmCall"); ...; pr.step("...");`.
    // If a later step bails, the earlier ones must remain marked so that
    // on resume they are skipped (avoiding duplicate LLM calls, etc.).
    const { runner, self } = makeRunner();
    await runner.step("a", async () => {});
    expect(self.runnerState.completedSteps.includes("a")).toBe(true);
    await expect(
      runner.step("b", async () => [fakeInterrupt()] as any),
    ).rejects.toBeInstanceOf(PromptBailout);
    expect(self.runnerState.completedSteps.includes("a")).toBe(true);
    expect(self.runnerState.completedSteps.includes("b")).toBe(false);
  });

  it("step body returning [] is treated as 'no interrupts' and marks completed", async () => {
    // hasInterrupts([]) is false, so an empty array must take the happy
    // path — otherwise an `onX` callback that ran fine but returned an
    // empty interrupt array would silently never re-run.
    const { runner, self } = makeRunner();
    await runner.step("a", async () => [] as any);
    expect(self.runnerState.completedSteps.includes("a")).toBe(true);
  });
});

describe("PromptRunner.step interrupt handling", () => {
  it("throws PromptBailout when the body returns interrupts", async () => {
    const { runner } = makeRunner();
    await expect(
      runner.step("a", async () => [fakeInterrupt()] as any),
    ).rejects.toBeInstanceOf(PromptBailout);
  });

  it("PromptBailout.interrupts contains exactly the items returned by the body", async () => {
    // Without this assertion, the bailout could lose, reorder, or wrap
    // the interrupts and we wouldn't notice — `instanceof` alone isn't
    // enough.
    const { runner } = makeRunner();
    const a = fakeInterrupt("a");
    const b = fakeInterrupt("b");
    let caught: PromptBailout | null = null;
    try {
      await runner.step("k", async () => [a, b] as any);
    } catch (e) {
      if (e instanceof PromptBailout) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.interrupts).toEqual([a, b]);
  });

  it("does NOT mark the key completed when bailing", async () => {
    const { runner, self } = makeRunner();
    await expect(
      runner.step("a", async () => [fakeInterrupt()] as any),
    ).rejects.toBeInstanceOf(PromptBailout);
    expect(self.runnerState.completedSteps.includes("a")).toBe(false);
  });

  it("snapshots messages and stamps a checkpoint with the per-key stepPath", async () => {
    let createdWith: any;
    const ctx: any = {
      checkpoints: {
        create: (_s: any, _c: any, info: any) => { createdWith = info; return 42; },
        get: () => ({ moduleId: "m", scopeName: "s", stepPath: "p/a" }),
      },
      statelogClient: stubStatelogClient(),
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
    await expect(
      runner.step("a", async () => [intr] as any),
    ).rejects.toBeInstanceOf(PromptBailout);
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
      statelogClient: stubStatelogClient(),
    };
    const runner = new PromptRunner({
      self: {},
      ctx,
      stateStack: {} as any,
      checkpointInfo: undefined,
      snapshotMessages: () => [],
    });
    await expect(
      runner.step("a", async () => [fakeInterrupt()] as any),
    ).rejects.toBeInstanceOf(PromptBailout);
    expect(createdWith.stepPath).toBe("a");
  });

  it("notifies the statelog client of the new checkpoint with reason=interrupt", async () => {
    const logged: any[] = [];
    const ctx: any = {
      checkpoints: {
        create: () => 5,
        get: () => ({ moduleId: "m", scopeName: "s", stepPath: "p/a" }),
      },
      statelogClient: stubStatelogClient({
        checkpointCreated: (args: any) => { logged.push(args); },
      }),
    };
    const runner = new PromptRunner({
      self: {},
      ctx,
      stateStack: {} as any,
      checkpointInfo: { moduleId: "m", scopeName: "s", stepPath: "p" },
      snapshotMessages: () => [],
    });
    await expect(
      runner.step("a", async () => [fakeInterrupt()] as any),
    ).rejects.toBeInstanceOf(PromptBailout);
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
  // Helper that supplies the per-item branch key. The real call site
  // passes `(toolCall) => "tool_" + toolCall.id` — for tests we just
  // use the item itself + index.
  const keyFor = (item: any, i: number) => `k_${item}_${i}`;

  it("runs every branch concurrently", async () => {
    const { runner } = makeRunner();
    const order: string[] = [];
    const result = await runner.parallel(
      "group",
      ["a", "b", "c"],
      keyFor,
      async (item, b) => {
        await b.step(`${item}.s1`, async () => {
          order.push(`start-${item}`);
        });
        await new Promise((r) => setTimeout(r, 5));
        await b.step(`${item}.s2`, async () => {
          order.push(`end-${item}`);
        });
      },
    );
    expect(result.kind).toBe("values");
    // All three starts happen before any end (concurrent).
    expect(order.indexOf("start-c")).toBeLessThan(order.indexOf("end-a"));
  });

  it("merges interrupts from multiple branches into kind='interrupts' with one shared checkpoint", async () => {
    let cpCount = 0;
    const ctx: any = {
      checkpoints: {
        create: () => {
          cpCount++;
          return 100 + cpCount;
        },
        get: () => ({ moduleId: "", scopeName: "", stepPath: "" }),
      },
      statelogClient: stubStatelogClient(),
    };
    const { runner } = makeRunner({ ctx });
    const result = await runner.parallel(
      "group",
      ["a", "b"],
      keyFor,
      async (item, b) => {
        await b.step(`${item}.s1`, async () => [fakeInterrupt(item)] as any);
      },
    );
    expect(result.kind).toBe("interrupts");
    if (result.kind !== "interrupts") return;
    expect(result.interrupts.length).toBe(2);
    expect(cpCount).toBe(1);
    expect(result.interrupts.every((i) => i.checkpointId === 101)).toBe(true);
  });

  it("skips a branch step whose key was already completed on a prior pass", async () => {
    const self: any = { runnerState: { completedSteps: ["a.s1"] } };
    const { runner } = makeRunner({ self });
    let ran = 0;
    const result = await runner.parallel(
      "group",
      ["a"],
      keyFor,
      async (item, b) => {
        await b.step(`${item}.s1`, async () => {
          ran++;
        });
      },
    );
    expect(result.kind).toBe("values");
    expect(ran).toBe(0);
  });

  it("once a branch step has collected interrupts, later steps on that branch are no-ops", async () => {
    const { runner } = makeRunner();
    let later = 0;
    const result = await runner.parallel(
      "group",
      ["a"],
      keyFor,
      async (item, b) => {
        await b.step(`${item}.s1`, async () => [fakeInterrupt(item)] as any);
        await b.step(`${item}.s2`, async () => {
          later++;
        });
      },
    );
    expect(result.kind).toBe("interrupts");
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
      statelogClient: stubStatelogClient(),
    };
    const { runner } = makeRunner({ ctx });
    const result = await runner.parallel(
      "group",
      ["a", "b"],
      keyFor,
      async (item, b) => {
        await b.step(`${item}.s1`, async () => {});
      },
    );
    expect(result.kind).toBe("values");
    expect(cpCount).toBe(0);
  });

  it("mixed branches: A interrupts, B completes — merged batch has only A, B's key is marked", async () => {
    // The real-world parallel-tool case: one tool needs approval, the
    // others finish. The merged result must surface only the bailing
    // branch's interrupts, and the completed branch's step must be marked
    // so resume doesn't re-run it.
    const { runner, self } = makeRunner();
    const result = await runner.parallel(
      "group",
      ["a", "b"],
      keyFor,
      async (item, b) => {
        if (item === "a") {
          await b.step(`${item}.s1`, async () => [fakeInterrupt(item)] as any);
        } else {
          await b.step(`${item}.s1`, async () => {});
        }
      },
    );
    expect(result.kind).toBe("interrupts");
    if (result.kind !== "interrupts") return;
    expect(result.interrupts.length).toBe(1);
    expect((result.interrupts[0] as any).kind).toBe("a");
    expect(self.runnerState.completedSteps.includes("a.s1")).toBe(false);
    expect(self.runnerState.completedSteps.includes("b.s1")).toBe(true);
  });

  it("parallel snapshots messages on merged interrupts", async () => {
    // `step()` already covers this; `parallel()` runs the same snapshot
    // logic but via a different code path. Verify it actually fires.
    const snapshots: any[] = [];
    const self: any = {};
    const stateStack = new StateStack();
    const parentFrame = new State();
    stateStack.stack.push(parentFrame);
    const runner = new PromptRunner({
      self,
      ctx: {
        checkpoints: {
          create: () => 99,
          get: () => ({ moduleId: "", scopeName: "", stepPath: "" }),
        },
        statelogClient: stubStatelogClient(),
      } as any,
      stateStack,
      parentFrame,
      checkpointInfo: undefined,
      snapshotMessages: () => {
        snapshots.push("snap");
        return [{ role: "user", content: "x" }] as any;
      },
    });
    const result = await runner.parallel(
      "group",
      ["a"],
      keyFor,
      async (item, b) => {
        await b.step(`${item}.s1`, async () => [fakeInterrupt(item)] as any);
      },
    );
    expect(result.kind).toBe("interrupts");
    expect(snapshots.length).toBe(1);
    expect(self.messagesJSON).toEqual([{ role: "user", content: "x" }]);
  });

  it("parallel with empty items list: no checkpoint, returns kind='values'", async () => {
    // Defensive — runPrompt may legitimately have a tool round with zero
    // tool calls, and parallel(...) should be a no-op rather than
    // surfacing interrupts or stamping an empty checkpoint.
    let cpCount = 0;
    const ctx: any = {
      checkpoints: {
        create: () => {
          cpCount++;
          return cpCount;
        },
        get: () => ({ moduleId: "", scopeName: "", stepPath: "" }),
      },
      statelogClient: stubStatelogClient(),
    };
    const { runner } = makeRunner({ ctx });
    const result = await runner.parallel("group", [], keyFor, async () => {});
    expect(result.kind).toBe("values");
    expect(cpCount).toBe(0);
  });

  it("parallel resume: B already complete, A re-runs and now succeeds", async () => {
    // Round 1 (not exercised here): A bailed, B completed → self.runnerState
    // has b.s1 marked. Round 2 (this test): the branchFn for A returns
    // void this time; the interrupt path does not fire; A's key is now
    // marked and B's step body is never re-entered.
    const self: any = {
      runnerState: { completedSteps: ["b.s1"] },
    };
    const { runner } = makeRunner({ self });
    let aRan = 0;
    let bRan = 0;
    const result = await runner.parallel(
      "group",
      ["a", "b"],
      keyFor,
      async (item, b) => {
        await b.step(`${item}.s1`, async () => {
          if (item === "a") aRan++;
          else bRan++;
        });
      },
    );
    expect(result.kind).toBe("values");
    expect(aRan).toBe(1);
    expect(bRan).toBe(0);
    expect(self.runnerState.completedSteps.includes("a.s1")).toBe(true);
  });
});
