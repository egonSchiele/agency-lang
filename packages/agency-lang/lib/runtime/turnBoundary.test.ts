import { describe, it, expect } from "vitest";
import * as smoltalk from "smoltalk";
import { StateStack } from "./state/stateStack.js";
import { MessageThread } from "./state/messageThread.js";
import type { HarvestedReplyAttachment } from "./replyAttachments.js";
import {
  drainProducer,
  runGateAndFeedback,
  runRoundBoundary,
  runInitialBoundary,
  attachmentsProducer,
  guardFeedbackProducer,
  queuedMessagesProducer,
  type BoundaryContext,
  type TurnMessageProducer,
} from "./turnBoundary.js";

function makeBctx(overrides: Partial<BoundaryContext> = {}) {
  const stepKeys: string[] = [];
  const snapshots: number[] = [];
  const messages = new MessageThread();
  const bctx: BoundaryContext = {
    step: async (key, body) => {
      stepKeys.push(key);
      await body();
    },
    guardGate: async () => {},
    messages,
    runnerState: {},
    stateStack: new StateStack(),
    snapshot: (thread) => {
      snapshots.push(thread.getMessages().length);
    },
    ...overrides,
  };
  return { bctx, stepKeys, snapshots, messages };
}

function harvested(id: string, toolName: string): HarvestedReplyAttachment {
  return {
    id,
    toolName,
    part: {
      type: "image",
      source: { kind: "base64", base64: "AAAA", mimeType: "image/png" },
    },
  };
}

describe("drainProducer", () => {
  const oneMessage: TurnMessageProducer = {
    name: "fake",
    take: () => [{ message: smoltalk.userMessage("hi"), label: "lbl" }],
  };
  const empty: TurnMessageProducer = { name: "fake", take: () => [] };

  it("pushes, labels, and snapshots when the producer has work", async () => {
    const { bctx, stepKeys, snapshots, messages } = makeBctx();
    await drainProducer(oneMessage, "round.0.fake", bctx);
    expect(stepKeys).toEqual(["round.0.fake"]);
    expect(messages.getMessages()).toHaveLength(1);
    expect(messages.labelAt(0)).toBe("lbl");
    expect(snapshots).toEqual([1]);
  });

  it("opens the step on an empty take but does NOT push or snapshot", async () => {
    const { bctx, stepKeys, snapshots, messages } = makeBctx();
    await drainProducer(empty, "round.0.fake", bctx);
    expect(stepKeys).toEqual(["round.0.fake"]);
    expect(messages.getMessages()).toHaveLength(0);
    expect(snapshots).toEqual([]);
  });
});

describe("runGateAndFeedback", () => {
  it("runs the gate step then the feedback drain, keys passed verbatim", async () => {
    const gateRuns: number[] = [];
    const { bctx, stepKeys, messages } = makeBctx({
      guardGate: async () => {
        gateRuns.push(1);
      },
    });
    bctx.stateStack.queueGuardFeedback("wrap up", "guard:budget");
    await runGateAndFeedback("guardGate.initial", "guardFeedback.initial", bctx);
    expect(stepKeys).toEqual(["guardGate.initial", "guardFeedback.initial"]);
    expect(gateRuns).toHaveLength(1);
    expect(messages.getMessages()).toHaveLength(1);
  });
});

describe("producers", () => {
  it("guardFeedbackProducer joins entries newline-first and dedupes labels", () => {
    const { bctx } = makeBctx();
    bctx.stateStack.queueGuardFeedback("one", "guard:a");
    bctx.stateStack.queueGuardFeedback("two", "guard:a");
    const msgs = guardFeedbackProducer.take(bctx);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].label).toBe("guard:a");
    const json = msgs[0].message.toJSON() as { content: unknown };
    expect(json.content).toBe("one\ntwo");
  });

  it("guardFeedbackProducer take is destructive", () => {
    const { bctx } = makeBctx();
    bctx.stateStack.queueGuardFeedback("one", "guard:a");
    guardFeedbackProducer.take(bctx);
    expect(guardFeedbackProducer.take(bctx)).toEqual([]);
  });

  it("attachmentsProducer merges N attachments into ONE message and clears", () => {
    const { bctx } = makeBctx();
    bctx.runnerState.replyAttachments = [
      harvested("att1", "showChart"),
      harvested("att2", "showMap"),
    ];
    const msgs = attachmentsProducer.take(bctx);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].label).toBe(null);
    expect(bctx.runnerState.replyAttachments).toEqual([]);
  });

  it("attachments label parity: label null stores what a label-less push stores", async () => {
    // The shipped block pushes with NO label argument. Determine what that
    // stores, then assert the producer path stores the identical form.
    const plain = new MessageThread();
    plain.push(smoltalk.userMessage("x"));
    const { bctx, messages } = makeBctx();
    bctx.runnerState.replyAttachments = [harvested("att1", "showChart")];
    await drainProducer(attachmentsProducer, "round.0.attachReplies", bctx);
    expect(messages.labelAt(0)).toBe(plain.labelAt(0));
  });

  it("queuedMessagesProducer preserves FIFO order, roles, and labels; no collapsing", () => {
    const { bctx, messages } = makeBctx();
    messages.queueMessage("a");
    messages.queueMessage("b", { role: "assistant", label: "steer" });
    const msgs = queuedMessagesProducer.take(bctx);
    expect(msgs).toHaveLength(2);
    expect((msgs[0].message.toJSON() as { role: string }).role).toBe("user");
    expect((msgs[1].message.toJSON() as { role: string }).role).toBe("assistant");
    expect(msgs[0].label).toBe(null);
    expect(msgs[1].label).toBe("steer");
    expect(messages.hasQueuedMessages()).toBe(false);
  });
});

describe("canonical step sequences", () => {
  const roundCanonical = [
    "round.3.attachReplies",
    "round.3.queuedMessages",
    "round.3.guardGate",
    "round.3.guardFeedback",
  ];
  const initialCanonical = [
    "queuedMessages.initial",
    "guardGate.initial",
    "guardFeedback.initial",
  ];

  it("round boundary emits the canonical sequence with work pending", async () => {
    const { bctx, stepKeys, messages } = makeBctx();
    bctx.runnerState.replyAttachments = [harvested("att1", "showChart")];
    messages.queueMessage("queued");
    bctx.stateStack.queueGuardFeedback("fb", "guard:a");
    await runRoundBoundary(3, bctx);
    expect(stepKeys).toEqual(roundCanonical);
  });

  it("round boundary emits the SAME sequence with nothing pending", async () => {
    const { bctx, stepKeys } = makeBctx();
    await runRoundBoundary(3, bctx);
    expect(stepKeys).toEqual(roundCanonical);
  });

  it("initial boundary emits its canonical sequence, pending or not", async () => {
    const withWork = makeBctx();
    withWork.messages.queueMessage("early");
    await runInitialBoundary(withWork.bctx);
    expect(withWork.stepKeys).toEqual(initialCanonical);

    const without = makeBctx();
    await runInitialBoundary(without.bctx);
    expect(without.stepKeys).toEqual(initialCanonical);
  });

  it("content order across producers: attachment, then queued, then feedback", async () => {
    const { bctx, messages } = makeBctx();
    bctx.runnerState.replyAttachments = [harvested("att1", "showChart")];
    messages.queueMessage("queued middle", { label: "q" });
    bctx.stateStack.queueGuardFeedback("feedback last", "guard:a");
    await runRoundBoundary(3, bctx);
    const contents = messages
      .getMessages()
      .map((m) => JSON.stringify(m.toJSON()));
    expect(contents).toHaveLength(3);
    expect(contents[0]).toContain("att1");
    expect(contents[1]).toContain("queued middle");
    expect(contents[2]).toContain("feedback last");
    expect(messages.labelAt(1)).toBe("q");
    expect(messages.labelAt(2)).toBe("guard:a");
  });
});

describe("guard pause signal flows through the boundary untouched", () => {
  it("the gate body return value reaches step() (pr.step pauses on Interrupt[])", async () => {
    // Regression pin for the migration hazard: wrapping guardGate in a
    // void-returning adapter would silently discard the Interrupt[] that
    // pr.step turns into a checkpoint-and-pause.
    const returns: unknown[] = [];
    const fakeInterrupts = [{ id: "i1" }] as never[];
    const { bctx } = makeBctx({
      step: async (_key, body) => {
        returns.push(await body());
      },
      guardGate: async () => fakeInterrupts,
    });
    await runGateAndFeedback("g", "f", bctx);
    expect(returns[0]).toBe(fakeInterrupts);
  });
});
