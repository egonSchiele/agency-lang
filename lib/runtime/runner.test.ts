import { describe, it, expect } from "vitest";
import { Runner } from "./runner.js";
import { State } from "./state/stateStack.js";

function makeFrame(): State {
  return new State({ args: {}, locals: {}, step: 0 });
}

function makeMockCtx(): any {
  return {
    stateStack: {},
    debuggerState: null,
    traceWriter: null,
    handlers: [] as any[],
    pushHandler(fn: any) {
      this.handlers.push(fn);
    },
    popHandler() {
      this.handlers.pop();
    },
    threads: {
      create: () => "tid-1",
      createSubthread: () => "tid-sub-1",
      pushActive: () => {},
      popActive: () => {},
    },
  };
}

describe("Runner", () => {
  describe("step()", () => {
    it("executes callback and advances counter", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      let executed = false;

      await runner.step(0, async () => {
        executed = true;
      });

      expect(executed).toBe(true);
      expect(frame.step).toBe(1);
    });

    it("skips when counter is past the step", async () => {
      const frame = makeFrame();
      frame.step = 5;
      const runner = new Runner(makeMockCtx(), frame);
      let executed = false;

      await runner.step(0, async () => {
        executed = true;
      });

      expect(executed).toBe(false);
    });

    it("executes multiple steps in sequence", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      const order: number[] = [];

      await runner.step(0, async () => {
        order.push(0);
      });
      await runner.step(1, async () => {
        order.push(1);
      });
      await runner.step(2, async () => {
        order.push(2);
      });

      expect(order).toEqual([0, 1, 2]);
      expect(frame.step).toBe(3);
    });

    it("resumes from saved step counter", async () => {
      const frame = makeFrame();
      frame.step = 2;
      const runner = new Runner(makeMockCtx(), frame);
      const order: number[] = [];

      await runner.step(0, async () => {
        order.push(0);
      });
      await runner.step(1, async () => {
        order.push(1);
      });
      await runner.step(2, async () => {
        order.push(2);
      });

      expect(order).toEqual([2]);
      expect(frame.step).toBe(3);
    });
  });

  describe("halt propagation", () => {
    it("halts runner and skips subsequent steps", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      const order: number[] = [];

      await runner.step(0, async (runner) => {
        order.push(0);
        runner.halt("interrupt-data");
      });
      await runner.step(1, async () => {
        order.push(1);
      });

      expect(order).toEqual([0]);
      expect(runner.halted).toBe(true);
      expect(runner.haltResult).toBe("interrupt-data");
      expect(frame.step).toBe(0); // not advanced — step didn't complete
    });

    it("propagates halt from nested step", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);

      await runner.step(0, async (runner) => {
        await runner.step(0, async (runner) => {
          runner.halt("deep-halt");
        });
        await runner.step(1, async () => {
          throw new Error("should not run");
        });
      });

      expect(runner.halted).toBe(true);
      expect(runner.haltResult).toBe("deep-halt");
    });

    it("does not advance counter when callback halts", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);

      await runner.step(0, async (runner) => {
        runner.halt("stopped");
      });

      expect(frame.step).toBe(0); // NOT advanced
    });
  });

  describe("nested steps (substeps)", () => {
    it("tracks substep counters in frame.locals", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);

      await runner.step(0, async (runner) => {
        await runner.step(0, async () => {});
        await runner.step(1, async () => {});
      });

      expect(frame.step).toBe(1);
      expect(frame.locals.__substep_0).toBe(2); // 2 substeps completed
    });

    it("resumes nested substeps correctly", async () => {
      const frame = makeFrame();
      // Simulate: step 0 completed, inside step 1, substep 0 completed
      frame.step = 0;
      frame.locals.__substep_1 = 1; // substep 0 of step 1 done
      const runner = new Runner(makeMockCtx(), frame);
      const order: string[] = [];

      await runner.step(0, async (runner) => {
        // step 0 not skipped (counter is 0)
        await runner.step(0, async () => {
          order.push("0.0");
        });
        await runner.step(1, async () => {
          order.push("0.1");
        });
      });

      // step 0 runs because frame.step is 0
      expect(order).toEqual(["0.0", "0.1"]);
    });

    it("deeply nested steps produce correct keys", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);

      await runner.step(2, async (runner) => {
        await runner.step(1, async (runner) => {
          await runner.step(3, async () => {});
        });
      });

      expect(frame.locals.__substep_2).toBe(2); // substep 1 completed
      expect((frame.locals as any)["__substep_2.1"]).toBe(4); // substep 3 completed
    });
  });

  describe("ifElse()", () => {
    it("executes matching branch", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      let result = "";

      await runner.ifElse(0, [
        { condition: () => false, body: async () => { result = "a"; } },
        { condition: () => true, body: async () => { result = "b"; } },
      ]);

      expect(result).toBe("b");
      expect(frame.step).toBe(1);
    });

    it("executes else branch when no conditions match", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      let result = "";

      await runner.ifElse(
        0,
        [{ condition: () => false, body: async () => { result = "if"; } }],
        async () => { result = "else"; },
      );

      expect(result).toBe("else");
    });

    it("does not re-evaluate conditions on resume", async () => {
      const frame = makeFrame();
      frame.locals.__condbranch_0 = 1; // branch 1 was selected
      frame.locals.__substep_0 = 0; // resume from start of branch body
      const runner = new Runner(makeMockCtx(), frame);
      let evalCount = 0;
      let result = "";

      await runner.ifElse(0, [
        {
          condition: () => { evalCount++; return true; },
          body: async () => { result = "a"; },
        },
        {
          condition: () => { evalCount++; return true; },
          body: async () => { result = "b"; },
        },
      ]);

      expect(evalCount).toBe(0); // conditions NOT re-evaluated
      expect(result).toBe("b"); // branch 1 executed
    });

    it("stores condbranch in nested context", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);

      await runner.step(3, async (runner) => {
        await runner.ifElse(0, [
          { condition: () => true, body: async () => {} },
        ]);
      });

      // condbranch key should include the parent path
      expect((frame.locals as any)["__condbranch_3.0"]).toBe(0);
    });
  });

  describe("loop()", () => {
    it("iterates over items", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      const collected: string[] = [];

      await runner.loop(0, ["a", "b", "c"], async (item) => {
        collected.push(item);
      });

      expect(collected).toEqual(["a", "b", "c"]);
      expect(frame.step).toBe(1);
    });

    it("resumes at saved iteration", async () => {
      const frame = makeFrame();
      frame.locals.__iteration_0 = 2; // already completed iterations 0, 1
      const runner = new Runner(makeMockCtx(), frame);
      const collected: string[] = [];

      await runner.loop(0, ["a", "b", "c"], async (item) => {
        collected.push(item);
      });

      expect(collected).toEqual(["c"]);
    });

    it("halts mid-iteration and preserves state", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);

      await runner.loop(0, ["a", "b", "c"], async (item, i, runner) => {
        if (item === "b") {
          runner.halt("stopped");
          return;
        }
      });

      expect(runner.halted).toBe(true);
      expect(frame.locals.__iteration_0).toBe(1); // completed iteration 0
    });

    it("resets substep tracking between iterations", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);

      await runner.loop(0, ["a", "b"], async (item, i, runner) => {
        await runner.step(0, async () => {});
      });

      // After completion, the iteration counter should reflect 2 iterations
      expect(frame.locals.__iteration_0).toBe(2);
    });
  });

  describe("whileLoop()", () => {
    it("loops while condition is true", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      let count = 0;

      await runner.whileLoop(0, () => count < 3, async () => {
        count++;
      });

      expect(count).toBe(3);
      expect(frame.step).toBe(1);
    });

    it("resumes at saved iteration", async () => {
      const frame = makeFrame();
      frame.locals.__iteration_0 = 2;
      const runner = new Runner(makeMockCtx(), frame);
      let count = 0;

      // condition must account for iterations already done
      await runner.whileLoop(0, () => count + 2 < 3, async () => {
        count++;
      });

      expect(count).toBe(1); // only 1 more iteration (iteration 2)
    });
  });

  describe("thread()", () => {
    it("calls setup and cleanup", async () => {
      const frame = makeFrame();
      const ctx = makeMockCtx();
      const calls: string[] = [];

      ctx.threads.create = () => {
        calls.push("create");
        return "tid";
      };
      ctx.threads.pushActive = () => { calls.push("push"); };
      ctx.threads.popActive = () => { calls.push("pop"); };

      const runner = new Runner(ctx, frame);

      await runner.thread(0, ctx.threads, "create", async () => {
        calls.push("body");
      });

      expect(calls).toEqual(["create", "push", "body", "pop"]);
    });

    it("pops thread even on halt", async () => {
      const frame = makeFrame();
      const ctx = makeMockCtx();
      let popped = false;
      ctx.threads.popActive = () => { popped = true; };

      const runner = new Runner(ctx, frame);

      await runner.thread(0, ctx.threads, "create", async (runner) => {
        runner.halt("interrupt");
      });

      expect(popped).toBe(true);
      expect(runner.halted).toBe(true);
    });
  });

  describe("handle()", () => {
    it("pushes and pops handler", async () => {
      const frame = makeFrame();
      const ctx = makeMockCtx();
      const runner = new Runner(ctx, frame);
      const handler = async () => ({ type: "approved" as const });

      expect(ctx.handlers.length).toBe(0);
      await runner.handle(0, handler, async () => {
        expect(ctx.handlers.length).toBe(1);
      });
      expect(ctx.handlers.length).toBe(0);
    });

    it("pops handler even on halt", async () => {
      const frame = makeFrame();
      const ctx = makeMockCtx();
      const runner = new Runner(ctx, frame);
      const handler = async () => ({ type: "approved" as const });

      await runner.handle(0, handler, async (runner) => {
        runner.halt("interrupt");
      });

      expect(ctx.handlers.length).toBe(0);
      expect(runner.halted).toBe(true);
    });
  });

  describe("branchStep()", () => {
    it("executes when counter not past", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      let executed = false;

      await runner.branchStep(0, "0_1", async () => {
        executed = true;
      });

      expect(executed).toBe(true);
    });

    it("executes when counter past but branch data exists", async () => {
      const frame = makeFrame();
      frame.step = 5;
      frame.branches = { "0_1": { stack: {} as any } };
      const runner = new Runner(makeMockCtx(), frame);
      let executed = false;

      await runner.branchStep(0, "0_1", async () => {
        executed = true;
      });

      expect(executed).toBe(true);
    });

    it("skips when counter past and no branch data", async () => {
      const frame = makeFrame();
      frame.step = 5;
      const runner = new Runner(makeMockCtx(), frame);
      let executed = false;

      await runner.branchStep(0, "0_1", async () => {
        executed = true;
      });

      expect(executed).toBe(false);
    });
  });

  describe("nested composition", () => {
    it("step inside ifElse inside loop inside handle", async () => {
      const frame = makeFrame();
      const ctx = makeMockCtx();
      const runner = new Runner(ctx, frame);
      const handler = async () => ({ type: "approved" as const });
      const trace: string[] = [];

      await runner.handle(0, handler, async (runner) => {
        await runner.loop(0, ["a", "b"], async (item, i, runner) => {
          await runner.ifElse(0, [
            {
              condition: () => item === "a",
              body: async (runner) => {
                await runner.step(0, async () => {
                  trace.push(`${item}-if`);
                });
              },
            },
          ], async (runner) => {
            await runner.step(0, async () => {
              trace.push(`${item}-else`);
            });
          });
        });
      });

      expect(trace).toEqual(["a-if", "b-else"]);
      expect(ctx.handlers.length).toBe(0);
    });
  });

  describe("variable naming", () => {
    it("produces expected variable names for nested structures", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);

      // Step 0: simple
      await runner.step(0, async () => {});

      // Step 1: ifElse
      await runner.ifElse(1, [
        {
          condition: () => true,
          body: async (runner) => {
            await runner.step(0, async () => {});
            await runner.step(1, async () => {});
          },
        },
      ]);

      // Step 2: loop
      await runner.loop(2, ["a", "b"], async (item, i, runner) => {
        await runner.step(0, async () => {});
      });

      expect(frame.step).toBe(3);
      expect(frame.locals.__condbranch_1).toBe(0); // ifElse at step 1, branch 0
      expect(frame.locals.__substep_1).toBe(2); // 2 substeps in ifElse
      expect(frame.locals.__iteration_2).toBe(2); // 2 loop iterations
    });
  });
});
