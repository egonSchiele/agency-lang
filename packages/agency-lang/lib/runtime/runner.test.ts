import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Runner, stripSlug, safeStatelogValue } from "./runner.js";
import { GlobalStore } from "./state/globalStore.js";
import { State, StateStack } from "./state/stateStack.js";
import { ThreadStore } from "./state/threadStore.js";
import { getRuntimeContext, runInTestContext } from "./asyncContext.js";
import { makeMockCtx } from "./__tests__/testHelpers.js";
import { TimeGuard } from "./guard.js";
import { readCause } from "./errors.js";

function makeFrame(): State {
  return new State({ args: {}, locals: {}, step: 0 });
}

describe("Runner.shouldSkip — guard-trip delivery de-dup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A tripped time guard whose abort signal is still aborted at the next
  // step boundary. Mirrors the state when the guard's OWN _popGuard step
  // runs after the block already unwound.
  function trippedGuardStack(): StateStack {
    const stack = new StateStack();
    const g = new TimeGuard(20);
    stack.pushGuard(g); // install: composes abortSignal + arms timer
    vi.advanceTimersByTime(20); // fire: signal aborted, cause on reason, g.tripped
    return stack;
  }

  it("raises a std::guard interrupt for an UNdelivered trip and halts before the step body", async () => {
    // PR 3: an undelivered trip detected at a step boundary no longer
    // throws GuardExceededError. The runner's raise point asks the
    // question instead: with no handler and no recorded answer, it
    // checkpoints, halts with the Interrupt[] batch, and the step body
    // never runs.
    const stack = trippedGuardStack();
    const runner = new Runner(makeMockCtx(), makeFrame(), { stack });
    let ran = false;
    await runner.step(0, async () => {
      ran = true;
    });
    expect(ran).toBe(false);
    expect(runner.halted).toBe(true);
    const batch = runner.haltResult;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch).toHaveLength(1);
    expect(batch[0].effect).toBe("std::guard");
    expect(batch[0].data.dimension).toBe("time");
    expect(batch[0].checkpointId).toBeDefined();
  });

  it("does NOT re-throw a trip already DELIVERED via the leaf path — lets cleanup run", async () => {
    const stack = trippedGuardStack();
    // Simulate __tryCall having already converted the leaf-op rejection
    // to a Failure and flagged the shared cause object as delivered.
    const cause = readCause(stack.abortSignal);
    expect(cause?.kind).toBe("guardTrip");
    (cause as { delivered?: boolean }).delivered = true;

    const runner = new Runner(makeMockCtx(), makeFrame(), { stack });
    let ran = false;
    // This stands in for the guard's own `_popGuard` step: it must run
    // rather than throw an unhandled GuardExceededError for an
    // already-handled trip (the second crash this PR fixes).
    await expect(
      runner.step(0, async () => {
        ran = true;
      }),
    ).resolves.toBeUndefined();
    expect(ran).toBe(true);
  });
});

describe("safeStatelogValue", () => {
  it("deep-clones small JSON values", () => {
    expect(safeStatelogValue(42)).toBe(42);
    expect(safeStatelogValue([0, 1, 1, 2, 3])).toEqual([0, 1, 1, 2, 3]);
    const obj = { a: [1, 2] };
    const out = safeStatelogValue(obj);
    expect(out).toEqual(obj);
    expect(out).not.toBe(obj); // cloned, not the same reference
  });

  it("returns undefined for undefined and values JSON can't represent", () => {
    expect(safeStatelogValue(undefined)).toBeUndefined();
    expect(safeStatelogValue(() => 1)).toBeUndefined();
  });

  it("truncates an oversized value to a marked string", () => {
    const out = safeStatelogValue("x".repeat(5000));
    expect(typeof out).toBe("string");
    expect((out as string).length).toBeLessThan(5000);
    expect(out as string).toMatch(/…\[truncated\]$/);
  });

  it("returns a placeholder for an unserializable (circular) value", () => {
    const a: any = {};
    a.self = a;
    expect(safeStatelogValue(a)).toBe("[unserializable]");
  });

  it("preserves a durable redact tag on the clone (redaction runs on this copy)", () => {
    // A plain JSON round-trip would strip the on-object tag and the statelog
    // redaction replacer would leak the branch value into forkBranchEnd.
    const gs = new GlobalStore();
    const secret = { apiKey: "sk-secret" };
    gs.setTag(secret, "redact", true);
    const out = safeStatelogValue({ wrapped: secret }) as {
      wrapped: object;
    };
    expect(out.wrapped).toEqual({ apiKey: "sk-secret" });
    expect(gs.isRedacted(out.wrapped)).toBe(true); // tag survived the clone
  });

  it("preserves native types (Date) through the clone", () => {
    const out = safeStatelogValue({
      when: new Date("2026-01-01T00:00:00.000Z"),
    }) as { when: Date };
    expect(out.when).toBeInstanceOf(Date);
  });

  it("redacts an oversized value BEFORE truncating (no string leak)", () => {
    // The truncation branch returns a plain string; post()'s redaction
    // replacer can't see inside a string, so redaction must happen during
    // this stringify. The redacted object is a small part of an oversized
    // payload — big enough to truncate, with the secret inside the cap.
    const gs = new GlobalStore();
    const secret = { apiKey: "sk-oversized-secret" };
    gs.setTag(secret, "redact", true);
    const ctx: any = { globals: gs };
    const out = runInTestContext(
      ctx,
      new StateStack(),
      new ThreadStore(),
      () => safeStatelogValue({ secret, filler: "x".repeat(5000) }),
    );
    expect(typeof out).toBe("string");
    expect(out).toMatch(/…\[truncated\]$/);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("sk-oversized-secret");
  });

  it("redacts the small-path clone in place when a frame is present", () => {
    const gs = new GlobalStore();
    const secret = { apiKey: "sk-small-secret" };
    gs.setTag(secret, "redact", true);
    const ctx: any = { globals: gs };
    const out = runInTestContext(
      ctx,
      new StateStack(),
      new ThreadStore(),
      () => safeStatelogValue({ secret, other: 1 }),
    ) as Record<string, unknown>;
    expect(out.secret).toBe("[REDACTED]");
    expect(out.other).toBe(1);
  });
});

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
        {
          condition: () => false,
          body: async () => {
            result = "a";
          },
        },
        {
          condition: () => true,
          body: async () => {
            result = "b";
          },
        },
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
        [
          {
            condition: () => false,
            body: async () => {
              result = "if";
            },
          },
        ],
        async () => {
          result = "else";
        },
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
          condition: () => {
            evalCount++;
            return true;
          },
          body: async () => {
            result = "a";
          },
        },
        {
          condition: () => {
            evalCount++;
            return true;
          },
          body: async () => {
            result = "b";
          },
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

    it("iterates the keys of a plain object (Record)", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      const collected: string[] = [];

      await runner.loop(
        0,
        { alice: "approve", bob: "reject" },
        async (key) => {
          collected.push(key);
        },
      );

      expect(collected.sort()).toEqual(["alice", "bob"]);
    });

    it("passes the value as the second callback arg when iterating a Record", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      const pairs: [string, unknown][] = [];

      await runner.loop(
        0,
        { a: 1, b: 2, c: 3 },
        async (key, value) => {
          pairs.push([key, value]);
        },
      );

      expect(pairs).toEqual([
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ]);
    });

    it("passes the numeric index as the second callback arg when iterating an array", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      const pairs: [unknown, unknown][] = [];

      await runner.loop(0, ["x", "y", "z"], async (item, index) => {
        pairs.push([item, index]);
      });

      expect(pairs).toEqual([
        ["x", 0],
        ["y", 1],
        ["z", 2],
      ]);
    });

    it("does nothing when iterating an empty Record", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      const collected: string[] = [];

      await runner.loop(0, {}, async (key) => {
        collected.push(key);
      });

      expect(collected).toEqual([]);
      // The iteration counter is initialized to 0 and the step counter
      // still advances past this loop.
      expect(frame.locals.__iteration_0).toBe(0);
      expect(frame.step).toBe(1);
    });

    it("halts mid-iteration over a Record and preserves state", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      const collected: string[] = [];

      await runner.loop(
        0,
        { a: 1, b: 2, c: 3 },
        async (key, _i, runner) => {
          collected.push(key);
          if (key === "b") {
            runner.halt("stopped");
          }
        },
      );

      expect(runner.halted).toBe(true);
      // Object.keys order is insertion order for string keys -> a, b, c
      expect(collected).toEqual(["a", "b"]);
      // Completed iteration 0 ("a") only. The halt happens inside iteration
      // 1, so the counter still points at iteration 1 for resumption.
      expect(frame.locals.__iteration_0).toBe(1);
    });

    it("does nothing when given null/undefined as the iterable", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      const collected: string[] = [];

      await runner.loop(0, null as any, async (item) => {
        collected.push(item);
      });

      expect(collected).toEqual([]);
      expect(frame.step).toBe(1);
    });
  });

  describe("whileLoop()", () => {
    it("loops while condition is true", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      let count = 0;

      await runner.whileLoop(
        0,
        () => count < 3,
        async () => {
          count++;
        },
      );

      expect(count).toBe(3);
      expect(frame.step).toBe(1);
    });

    it("resumes at saved iteration", async () => {
      const frame = makeFrame();
      frame.locals.__iteration_0 = 2;
      const runner = new Runner(makeMockCtx(), frame);
      let count = 0;

      // condition must account for iterations already done
      await runner.whileLoop(
        0,
        () => count + 2 < 3,
        async () => {
          count++;
        },
      );

      expect(count).toBe(1); // only 1 more iteration (iteration 2)
    });

    // The condition arrow generated by the TS builder is `async () => ${cond}`
    // (because the builder always emits `await` around function calls inside
    // expressions). The runtime must `await` the condition so a
    // Promise<boolean> is correctly consumed.
    it("awaits an async condition that returns Promise<boolean>", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame);
      let count = 0;

      await runner.whileLoop(
        0,
        async () => {
          // Force the condition to genuinely return a Promise.
          await Promise.resolve();
          return count < 3;
        },
        async () => {
          count++;
        },
      );

      expect(count).toBe(3);
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
      ctx.threads.pushActive = () => {
        calls.push("push");
      };
      ctx.threads.popActive = () => {
        calls.push("pop");
      };

      const runner = new Runner(ctx, frame, { threads: ctx.threads });

      await runner.thread(0, "create", {}, async () => {
        calls.push("body");
      });

      expect(calls).toEqual(["create", "push", "body", "pop"]);
    });

    it("pops thread even on halt", async () => {
      const frame = makeFrame();
      const ctx = makeMockCtx();
      let popped = false;
      ctx.threads.popActive = () => {
        popped = true;
      };

      const runner = new Runner(ctx, frame, { threads: ctx.threads });

      await runner.thread(0, "create", {}, async (runner) => {
        runner.halt("interrupt");
      });

      expect(popped).toBe(true);
      expect(runner.halted).toBe(true);
    });

    it("fires onThreadStart and onThreadEnd with slug ids and label", async () => {
      const frame = makeFrame();
      const ctx = makeMockCtx();
      const events: Array<{ kind: string; data: any }> = [];
      ctx.callbacks = {
        onThreadStart: (data: any) => { events.push({ kind: "start", data }); },
        onThreadEnd: (data: any) => { events.push({ kind: "end", data }); },
      };
      // makeMockCtx returns "tid-1" from create(). Override get() to
      // surface a non-empty message list so we can assert the snapshot.
      ctx.threads.get = () => ({
        messages: [{ toJSON: () => ({ role: "user", content: "hi" }) }],
        parentId: null,
      });

      const runner = new Runner(ctx, frame, { threads: ctx.threads });

      await runner.thread(
        0,
        "create",
        { label: "coding task", summarize: true },
        async () => {
          /* body */
        },
      );

      expect(events.length).toBe(2);
      expect(events[0].kind).toBe("start");
      expect(events[0].data.threadId).toBe("ttid-1");
      expect(events[0].data.label).toBe("coding task");
      expect(events[0].data.threadType).toBe("thread");
      expect(events[0].data.isResumption).toBe(false);
      expect(events[1].kind).toBe("end");
      expect(events[1].data.threadId).toBe("ttid-1");
      expect(events[1].data.label).toBe("coding task");
      expect(events[1].data.eagerSummarize).toBe(true);
      expect(events[1].data.messages).toEqual([{ role: "user", content: "hi" }]);
    });
  });

  describe("handle()", () => {
    it("pushes and pops handler", async () => {
      const frame = makeFrame();
      const ctx = makeMockCtx();
      const runner = new Runner(ctx, frame);
      const handler = async () => ({ type: "approve" as const });

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
      const handler = async () => ({ type: "approve" as const });

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
      frame.newBranch("0_1"); // simulate that branch data was created in a previous run
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
      const handler = async () => ({ type: "approve" as const });
      const trace: string[] = [];

      await runner.handle(0, handler, async (runner) => {
        await runner.loop(0, ["a", "b"], async (item, i, runner) => {
          await runner.ifElse(
            0,
            [
              {
                condition: () => item === "a",
                body: async (runner) => {
                  await runner.step(0, async () => {
                    trace.push(`${item}-if`);
                  });
                },
              },
            ],
            async (runner) => {
              await runner.step(0, async () => {
                trace.push(`${item}-else`);
              });
            },
          );
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

  describe("runInScope seeds the ALS callsite slot", () => {
    it("populates moduleId / scopeName / stepPath for a single step", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame, {
        moduleId: "modX",
        scopeName: "fooScope",
        stack: new StateStack(),
        threads: new ThreadStore(),
      });
      let seen: any = null;
      await runner.step(1, async () => {
        seen = getRuntimeContext().callsite;
      });
      expect(seen).toEqual({
        moduleId: "modX",
        scopeName: "fooScope",
        stepPath: "1",
      });
    });

    it("updates stepPath for nested step IDs", async () => {
      const frame = makeFrame();
      const runner = new Runner(makeMockCtx(), frame, {
        moduleId: "modX",
        scopeName: "fooScope",
        stack: new StateStack(),
        threads: new ThreadStore(),
      });
      const paths: string[] = [];
      await runner.step(0, async () => {
        paths.push(getRuntimeContext().callsite!.stepPath);
        await runner.ifElse(0, [
          {
            condition: () => true,
            body: async (r) => {
              await r.step(0, async () => {
                paths.push(getRuntimeContext().callsite!.stepPath);
              });
            },
          },
        ]);
      });
      // Top-level step 0 (path = ["0"]) and nested step 0.0.0 inside
      // the ifElse branch (path = ["0", "0", "0", "0"]).
      expect(paths[0]).toBe("0");
      expect(paths[paths.length - 1]).toContain("0.0");
    });
  });
});

describe("match exit propagation", () => {
  let frame: State;
  let runner: Runner;

  beforeEach(() => {
    frame = makeFrame();
    runner = new Runner(makeMockCtx(), frame);
  });

  const frameLocals = () => frame.locals;

  it("exitMatch stores the value and skips to the owning ifElse", async () => {
    const ran: string[] = [];
    await runner.ifElse(
      0,
      [
        {
          condition: async () => true,
          body: async (r) => {
            ran.push("before");
            r.exitMatch(7, "yielded");
            ran.push("unreachable"); // exitMatch does not throw; codegen adds `return;`
          },
        },
      ],
      undefined,
      { matchId: 7 },
    );
    await runner.step(1, async () => {
      ran.push("after-match");
    });
    expect(ran).toContain("after-match"); // flag cleared by owner
    expect(frameLocals()["__matchval_7"]).toBe("yielded"); // value stored by runner
  });

  it("a non-owning inner ifElse neither runs nor clears an outer exit", async () => {
    runner.exitMatch(1, "outer");
    const ran: string[] = [];
    await runner.ifElse(
      2,
      [{ condition: async () => true, body: async () => { ran.push("inner"); } }],
      undefined,
      { matchId: 2 },
    );
    await runner.step(3, async () => {
      ran.push("after");
    });
    expect(ran).toEqual([]); // inner skipped, flag still set, step skipped
  });

  it("nested matches: inner ifElse does not clear the outer id; outer does", async () => {
    const ran: string[] = [];
    await runner.ifElse(
      0,
      [
        {
          condition: async () => true,
          body: async (r) => {
            await r.ifElse(
              0,
              [
                {
                  condition: async () => true,
                  body: async (r2) => {
                    r2.exitMatch(10, "from-inner-arm-of-OUTER");
                  },
                },
              ],
              undefined,
              { matchId: 11 }, // inner match id 11 ≠ 10
            );
            // A post-yield statement in the outer arm is its own substep and
            // must be SKIPPED while exit 10 is pending.
            await r.step(1, async () => {
              ran.push("outer-arm-after-inner");
            });
          },
        },
      ],
      undefined,
      { matchId: 10 },
    );
    await runner.step(2, async () => {
      ran.push("after-outer");
    });
    expect(ran).toEqual(["after-outer"]);
  });

  it("exitMatch propagates through a nested non-match ifElse", async () => {
    const ran: string[] = [];
    await runner.ifElse(
      0,
      [
        {
          condition: async () => true,
          body: async (r) => {
            await r.ifElse(0, [
              {
                condition: async () => true,
                body: async (r2) => {
                  r2.exitMatch(5, 1);
                },
              },
            ]); // plain if, no matchId
            await r.step(1, async () => {
              ran.push("skipped");
            });
          },
        },
      ],
      undefined,
      { matchId: 5 },
    );
    await runner.step(2, async () => {
      ran.push("after");
    });
    expect(ran).toEqual(["after"]);
  });

  it("stops loop AND whileLoop iterations when a match exit is pending", async () => {
    // loop(): exitMatch inside iteration 0 → iteration 1 must never run, and
    // the loop must NOT clear the flag (a following step stays skipped).
    {
      const f = makeFrame();
      const r = new Runner(makeMockCtx(), f);
      const seen: number[] = [];
      await r.loop(0, [0, 1, 2], async (item, _i, rr) => {
        seen.push(item);
        if (item === 0) rr.exitMatch(20, "x");
      });
      expect(seen).toEqual([0]); // iteration 1 never ran
      const ran: string[] = [];
      await r.step(1, async () => {
        ran.push("after");
      });
      expect(ran).toEqual([]); // loop did not clear the flag
    }
    // whileLoop(): same contract.
    {
      const f = makeFrame();
      const r = new Runner(makeMockCtx(), f);
      const seen: number[] = [];
      let n = 0;
      await r.whileLoop(
        0,
        () => n < 3,
        async (rr) => {
          seen.push(n);
          n++;
          if (n === 1) rr.exitMatch(21, "y");
        },
      );
      expect(seen).toEqual([0]); // iteration 1 never ran
      const ran: string[] = [];
      await r.step(1, async () => {
        ran.push("after");
      });
      expect(ran).toEqual([]); // whileLoop did not clear the flag
    }
  });

  it("clears the flag even when the branch body throws", async () => {
    await expect(
      runner.ifElse(
        0,
        [
          {
            condition: async () => true,
            body: async (r) => {
              r.exitMatch(9, "x");
              throw new Error("boom");
            },
          },
        ],
        undefined,
        { matchId: 9 },
      ),
    ).rejects.toThrow("boom");
    const ran: string[] = [];
    await runner.step(1, async () => {
      ran.push("after");
    });
    expect(ran).toEqual(["after"]); // try/finally cleared the flag
  });

  it("_matchExit is not part of serialized checkpoint state", () => {
    runner.exitMatch(3, "v");
    const snapshot = JSON.stringify(frame.toJSON());
    expect(snapshot).not.toContain("_matchExit");
    expect(snapshot).toContain("__matchval_3"); // the VALUE does serialize (it is a frame local)
  });
});

describe("stripSlug", () => {
  it("strips the leading t from canonical slugs", () => {
    expect(stripSlug("t1")).toBe("1");
    expect(stripSlug("t42")).toBe("42");
  });

  it("leaves non-slug strings untouched", () => {
    expect(stripSlug("hello")).toBe("hello");
    // Regression: prior to the tightened regex this returned "hello".
    expect(stripSlug("thello")).toBe("thello");
    expect(stripSlug("t")).toBe("t");
    expect(stripSlug("t1a")).toBe("t1a");
    expect(stripSlug("")).toBe("");
  });
});
