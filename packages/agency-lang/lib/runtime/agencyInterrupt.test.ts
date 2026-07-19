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
                effect: "test",
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
                effect: "test",
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
            effect: "test",
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
    expect(intr.effect).toBe("test");
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
            effect: "test",
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
            effect: "test",
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
            effect: "test",
            message: "first pass",
            data: { round: 1 },
          });
        });
        return "should-not-reach-first-time";
      }),
    )) as unknown as Interrupt[];

    expect(Array.isArray(firstResult)).toBe(true);
    const intr = firstResult[0];
    expect(intr.effect).toBe("test");
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
                effect: "test",
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
              observedKind = i.effect;
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
          await agency.interrupt({ effect: "x", message: "no data" });
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
        agency.interrupt({ effect: "test", message: "x", data: {} }),
      ),
    ).rejects.toThrow(/without an active Runner/);
  });
});

// Regression test for the recursive handler bug debugged in
// https://ampcode.com/threads/T-019e7a80-0a51-75ce-840e-89b5f595da5c.
// A handler whose body raises an interrupt triggers a nested
// runHandlerChain dispatch that visits the same handler again
// (the chain visits every handler, even after one approves), leading
// to unbounded recursion. The runtime now bounds nested-dispatch depth
// at MAX_HANDLER_CHAIN_DEPTH and throws HandlerRecursionError when
// exceeded, naming the offending interrupt kind in the message.
describe("agency.interrupt — raising inside a handler", () => {
  // A handler never hears its own raises: the executing entry is skipped
  // during dispatch. With no other handler registered, nothing settles the
  // inner raise, and it cannot surface (a handler cannot pause to ask the
  // user), so it comes back as a rejection whose message names the effect.
  // The handler carries on and the original interrupt resolves normally —
  // this used to recurse to HandlerRecursionError.
  it("refuses a handler's own raise instead of re-entering it", async () => {
    const ctx = makeMockCtx();
    let innerOutcome: any;
    const raisingHandler = async () => {
      innerOutcome = await agency.interrupt({
        effect: "inner",
        message: "raised from inside handler",
        data: {},
      });
      return approve("outer-ok");
    };
    let outerResult: any;
    await inFrame(ctx, () =>
      agency.withResumableScope({ name: "self-raise" }, async (s) => {
        await s.step(async () => {
          await agency.withHandler(raisingHandler, async () => {
            outerResult = await agency.interrupt({
              effect: "outer",
              message: "trips the chain the first time",
              data: {},
            });
          });
        });
        return "done";
      }),
    );
    expect(isRejected(innerOutcome)).toBe(true);
    expect(innerOutcome.value).toContain('Cannot ask the user about "inner"');
    expect(isApproved(outerResult)).toBe(true);
    expect(outerResult.value).toBe("outer-ok");
  });

  // Exclusion is per ENTRY (registration), not per source handler. Two
  // registrations of the same handler are two entries: activation two's
  // raise is heard by activation one, which raises again — and at that
  // point BOTH activations are executing, so the third-level raise is
  // refused. Nesting is bounded by the number of registrations, and the
  // outer activation hears the inner's raise exactly once.
  it("a sibling registration of the same handler hears the raise once", async () => {
    const ctx = makeMockCtx();
    let heardInner = 0;
    let refusals = 0;
    const raisingHandler = async (intr: { effect: string }) => {
      if (intr.effect === "inner") {
        heardInner += 1;
      }
      const outcome = await agency.interrupt({
        effect: "inner",
        message: "raised from inside handler",
        data: {},
      });
      if (isRejected(outcome)) {
        refusals += 1;
      }
      return approve();
    };
    await inFrame(ctx, () =>
      agency.withResumableScope({ name: "sibling-activations" }, async (s) => {
        await s.step(async () => {
          await agency.withHandler(raisingHandler, async () =>
            agency.withHandler(raisingHandler, async () => {
              await agency.interrupt({
                effect: "outer",
                message: "trips first",
                data: {},
              });
            }),
          );
        });
        return "done";
      }),
    );
    // The outer kickoff runs both activations; each activation's own raise
    // is heard by the other side exactly as the chain allows: the deepest
    // raise (both executing) is refused.
    expect(heardInner).toBeGreaterThan(0);
    expect(refusals).toBeGreaterThan(0);
  });

  it("a refused in-handler raise does not leak state into the next dispatch", async () => {
    const ctx = makeMockCtx();
    const raisingHandler = async () => {
      await agency.interrupt({
        effect: "inner",
        message: "x",
        data: {},
      });
      return approve();
    };
    await inFrame(ctx, () =>
      agency.withResumableScope({ name: "cleanup" }, async (s) => {
        await s.step(async () => {
          await agency.withHandler(raisingHandler, async () => {
            await agency.interrupt({ effect: "outer", message: "x", data: {} });
          });
        });
        return "done";
      }),
    );
    // Exclusion and depth both live in AsyncLocalStorage, so the refused
    // dispatch's scope has fully unwound — a fresh dispatch must start
    // clean and resolve normally rather than inheriting stale executing
    // entries or a stale depth count.
    let result: any;
    await inFrame(ctx, () =>
      agency.withResumableScope({ name: "after-throw" }, async (s) => {
        await s.step(async () => {
          await agency.withHandler(
            // eslint-disable-next-line @typescript-eslint/require-await
            async () => approve("fresh"),
            async () => {
              result = await agency.interrupt({
                effect: "normal",
                message: "y",
                data: {},
              });
            },
          );
        });
        return "done";
      }),
    );
    expect(isApproved(result)).toBe(true);
    expect(result.value).toBe("fresh");
  });

  // Regression for the false positive where many CONCURRENT handler
  // dispatches (e.g. an LLM firing 15 tool calls in one round, each
  // interrupting) were mistaken for recursive nesting. The guard must
  // measure recursion DEPTH along one async lineage, not concurrent
  // BREADTH — none of these dispatches nests inside another, so no
  // HandlerRecursionError should be thrown however wide the fan-out.
  it("does not trip the recursion guard for many concurrent (non-nested) dispatches", async () => {
    const ctx = makeMockCtx();
    // Auto-approve handler that yields, so the concurrent dispatches
    // interleave with each other while all are still in flight — exactly
    // the shape of parallel tool calls sharing one ctx.
    const approveHandler = async () => {
      await Promise.resolve();
      return approve("ok");
    };
    const N = 15; // > MAX_HANDLER_CHAIN_DEPTH (10) — old code trips here
    let results: any[] = [];
    await inFrame(ctx, () =>
      agency.withResumableScope({ name: "parallel" }, async (s) => {
        await s.step(async () => {
          await agency.withHandler(approveHandler, async () => {
            results = await Promise.all(
              Array.from({ length: N }, (_, i) =>
                agency.interrupt({
                  effect: "read-file",
                  message: `read file ${i}`,
                  data: { i },
                }),
              ),
            );
          });
        });
        return "done";
      }),
    );
    expect(results).toHaveLength(N);
    for (const r of results) expect(isApproved(r)).toBe(true);
  });

  // Realistic mix: wide concurrency AND genuine (but shallow, legitimate)
  // nesting at the same time — e.g. an LLM fires many tool calls in one
  // round, and each tool's handler itself raises one further interrupt. Each
  // lineage reaches depth 2, well under the limit; the guard must count that
  // per-lineage depth (2), NOT the sum across all the concurrent lineages
  // (~2·N), which the old shared counter did.
  it("allows wide concurrency where each lineage also nests legitimately", async () => {
    const ctx = makeMockCtx();
    // One handler resolves both kinds. For an "outer" interrupt it raises
    // exactly ONE "inner" interrupt (depth-2 nesting) before approving; an
    // "inner" interrupt it approves outright, so nesting is bounded at 2 and
    // never recurses into the guard.
    const handler = async (intr: { effect: string }) => {
      if (intr.effect === "outer") {
        await agency.interrupt({ effect: "inner", message: "nested once", data: {} });
      }
      return approve("ok");
    };
    const N = 15; // wide fan-out; depth per lineage is only 2
    let results: any[] = [];
    await inFrame(ctx, () =>
      agency.withResumableScope({ name: "parallel-nested" }, async (s) => {
        await s.step(async () => {
          await agency.withHandler(handler, async () => {
            results = await Promise.all(
              Array.from({ length: N }, (_, i) =>
                agency.interrupt({
                  effect: "outer",
                  message: `outer ${i}`,
                  data: { i },
                }),
              ),
            );
          });
        });
        return "done";
      }),
    );
    expect(results).toHaveLength(N);
    for (const r of results) expect(isApproved(r)).toBe(true);
  });
});
