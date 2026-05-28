import { describe, it, expect } from "vitest";
import { agency } from "./agency.js";
import { approve, isApproved, isRejected, reject, type Interrupt } from "./interrupts.js";
import { ThreadStore } from "./state/threadStore.js";
import { makeMockCtx } from "./__tests__/testHelpers.js";

// `agency.interrupt()` only works inside a Runner-driven step body.
// The standard test harness for that is `withResumableScope` — its
// `s.step(...)` callback runs inside `Runner.step`, which seeds the
// ALS frame with the runner that `agency.interrupt` needs to halt.
function inFrame<T>(
  ctx: ReturnType<typeof makeMockCtx>,
  fn: () => Promise<T>,
): Promise<T> {
  return agency.withTestContext(
    { ctx, stack: ctx.stateStack, threads: new ThreadStore() },
    fn,
  );
}

describe("agency.interrupt — handler approves", () => {
  it("returns the handler's approve() outcome without halting", async () => {
    const ctx = makeMockCtx();
    let result: any;
    const ret = await inFrame(ctx, () =>
      agency.withResumableScope({ name: "approves" }, async (s) => {
        await s.step(async () => {
          await agency.withHandler(
            // eslint-disable-next-line @typescript-eslint/require-await
            async () => approve("handler-value"),
            async () => {
              result = await agency.interrupt({
                kind: "test",
                message: "needs approval",
                data: { foo: 1 },
              });
            },
          );
        });
        return "scope-completed";
      }),
    );
    expect(ret).toBe("scope-completed");
    expect(isApproved(result)).toBe(true);
    expect(result.value).toBe("handler-value");
  });
});

describe("agency.interrupt — handler rejects", () => {
  it("returns the handler's reject() outcome without halting", async () => {
    const ctx = makeMockCtx();
    let result: any;
    const ret = await inFrame(ctx, () =>
      agency.withResumableScope({ name: "rejects" }, async (s) => {
        await s.step(async () => {
          await agency.withHandler(
            // eslint-disable-next-line @typescript-eslint/require-await
            async () => reject("nope"),
            async () => {
              result = await agency.interrupt({
                kind: "test",
                message: "needs approval",
                data: {},
              });
            },
          );
        });
        return "scope-completed";
      }),
    );
    expect(ret).toBe("scope-completed");
    expect(isRejected(result)).toBe(true);
    expect(result.value).toBe("nope");
  });
});

describe("agency.interrupt — no handler", () => {
  it("halts the surrounding scope with [intr] and a checkpoint", async () => {
    const ctx = makeMockCtx();
    const ret = await inFrame(ctx, () =>
      agency.withResumableScope({ name: "halt" }, async (s) => {
        await s.step(async () => {
          await agency.interrupt({
            kind: "test",
            message: "propagated",
            data: { foo: 42 },
          });
        });
        return "should-not-reach";
      }),
    );
    // After halt, withResumableScope returns runner.haltResult.
    // Non-node-context runner halts with the raw interrupt array.
    expect(Array.isArray(ret)).toBe(true);
    const interrupts = ret as unknown as Interrupt[];
    expect(interrupts).toHaveLength(1);
    const intr = interrupts[0];
    expect(intr.type).toBe("interrupt");
    expect(intr.kind).toBe("test");
    expect(intr.message).toBe("propagated");
    expect(intr.data).toEqual({ foo: 42 });
    // The codegen path attaches both id and the full snapshot.
    expect(typeof intr.checkpointId).toBe("number");
    expect(intr.checkpoint).toBeDefined();
    expect(intr.checkpoint!.id).toBe(intr.checkpointId);
    // The checkpoint must exist in the store for respondToInterrupts
    // to resolve later.
    expect(ctx.checkpoints.get(intr.checkpointId!)).toBeDefined();
  });

  it("does NOT execute code after the agency.interrupt() call", async () => {
    const ctx = makeMockCtx();
    let reachedAfter = false;
    await inFrame(ctx, () =>
      agency.withResumableScope({ name: "no-after" }, async (s) => {
        await s.step(async () => {
          await agency.interrupt({
            kind: "test",
            message: "halt me",
            data: {},
          });
          reachedAfter = true;
        });
        return "ignored";
      }),
    );
    expect(reachedAfter).toBe(false);
  });

  it("does NOT execute later s.step(...) bodies after the halt", async () => {
    const ctx = makeMockCtx();
    const order: string[] = [];
    await inFrame(ctx, () =>
      agency.withResumableScope({ name: "no-later" }, async (s) => {
        await s.step(async () => {
          order.push("first");
          await agency.interrupt({
            kind: "test",
            message: "halt",
            data: {},
          });
        });
        await s.step(() => {
          order.push("second");
        });
        return "ignored";
      }),
    );
    expect(order).toEqual(["first"]);
  });
});

describe("agency.interrupt — resume idempotency", () => {
  it("on resume, returns the user's response without re-firing handlers", async () => {
    const ctx = makeMockCtx();

    // First pass: no handler, no response → halts and returns
    // [intr] with checkpointId.
    const firstResult = (await inFrame(ctx, () =>
      agency.withResumableScope({ name: "resume" }, async (s) => {
        await s.step(async () => {
          await agency.interrupt({
            kind: "test",
            message: "first pass",
            data: { round: 1 },
          });
        });
        return "should-not-reach-first-time";
      }),
    )) as unknown as Interrupt[];

    expect(Array.isArray(firstResult)).toBe(true);
    const intr = firstResult[0];
    expect(intr.kind).toBe("test");
    const persistedId = intr.interruptId;

    // Stamp a user response for the persisted interrupt id, mirroring
    // what `respondToInterrupts` does in production.
    ctx.setInterruptResponses({
      [persistedId]: { response: approve("user-said-yes") },
    });

    // Track whether the handler fires on the resume pass. It MUST
    // NOT — that's the resume-idempotency contract.
    let handlerCalled = 0;
    const handler = (): undefined => {
      handlerCalled++;
      return undefined;
    };

    // Resume: same scope body, with the response now in place. The
    // first-pass body advanced the State's `step` past 0 to record
    // the entered-but-not-completed step — wait, actually a halted
    // step does NOT advance `setCounter(id+1)`. So on the second
    // entry the body re-runs the step, agency.interrupt finds the
    // persisted id, looks up the response, returns it. The handler
    // is never consulted.
    //
    // We can't reuse the same withResumableScope frame across
    // invocations in this test (each call pushes a fresh State), so
    // instead we exercise the lookup path directly: install the same
    // persisted id on a fresh frame and confirm the helper returns
    // the response without going through the handler.
    let observed: any;
    await inFrame(ctx, () =>
      agency.withResumableScope({ name: "resume" }, async (s) => {
        await s.step(async () => {
          // Pre-seed the persisted id on the current frame to mimic
          // the post-restore state: respondToInterrupts deserializes
          // the checkpoint stack which still carries `__interrupt_<path>`.
          const frame = ctx.stateStack.lastFrame();
          frame.locals[`__interrupt_0`] = persistedId;
          await agency.withHandler(
            // eslint-disable-next-line @typescript-eslint/require-await
            async () => {
              handler();
              return undefined;
            },
            async () => {
              observed = await agency.interrupt({
                kind: "test",
                message: "ignored on resume",
                data: { round: 2 },
              });
            },
          );
        });
        return "completed";
      }),
    );

    expect(handlerCalled).toBe(0);
    expect(isApproved(observed)).toBe(true);
    expect(observed.value).toBe("user-said-yes");
  });
});

describe("agency.interrupt — option defaults", () => {
  it("defaults kind to \"unknown\" when omitted", async () => {
    const ctx = makeMockCtx();
    let observedKind: string | undefined;
    await inFrame(ctx, () =>
      agency.withResumableScope({ name: "defaults" }, async (s) => {
        await s.step(async () => {
          await agency.withHandler(
            // eslint-disable-next-line @typescript-eslint/require-await
            async (i) => {
              observedKind = i.kind;
              return approve("ok");
            },
            async () => {
              await agency.interrupt({ message: "no kind specified" });
            },
          );
        });
      }),
    );
    expect(observedKind).toBe("unknown");
  });

  it("propagates with undefined data when data is omitted", async () => {
    const ctx = makeMockCtx();
    const ret = (await inFrame(ctx, () =>
      agency.withResumableScope({ name: "no-data" }, async (s) => {
        await s.step(async () => {
          await agency.interrupt({ kind: "x", message: "no data" });
        });
      }),
    )) as unknown as Interrupt[];
    expect(ret[0].data).toBeUndefined();
  });
});

describe("agency.interrupt — frame requirements", () => {
  it("throws when called without a Runner in the ALS frame", async () => {
    const ctx = makeMockCtx();
    await expect(
      inFrame(ctx, () =>
        agency.interrupt({ kind: "test", message: "x", data: {} }),
      ),
    ).rejects.toThrow(/without an active Runner/);
  });
});
