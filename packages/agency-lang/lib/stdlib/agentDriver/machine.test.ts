import { describe, expect, it } from "vitest";
import type { Interrupt } from "../../runtime/interrupts.js";
import { approve, reject } from "../../runtime/interruptResponse.js";
import { failure, success, type Result } from "../../types/result.js";
import type { Settle } from "./approvals.js";
import { messageAnswer, type PauseData, type SettingsAnswer } from "./interface.js";
import {
  initialPhase,
  reduceDriver,
  type DriverAction,
  type DriverPhase,
  type DriverStep,
  type Happened,
  type Leg,
} from "./machine.js";
import { withCancelNote, type AgentStep } from "./run.js";

function interrupt(effect: string, id: string): Interrupt {
  return {
    type: "interrupt",
    effect,
    message: "",
    origin: "test",
    interruptId: id,
    data: {},
    runId: "run",
  };
}

function reported(model: string): PauseData {
  return {
    thread: "t1",
    cwd: "/work",
    record: null,
    models: { main: { model, provider: "anthropic", via: "" } },
    preset: "",
    fixedProvider: "",
    effort: "",
    budget: { maxCost: 1, maxTime: 1 },
    context: "",
    brain: "simple",
  };
}

/** The pause a run comes back to, reporting `model` as its main model. */
function pauseWith(model: string, id: string): Interrupt[] {
  return [{ ...interrupt("agent::sessionInput", id), data: reported(model) }];
}

const PAUSE = pauseWith("sonnet", "pause-1");
const asksAll: Settle = () => null;

function finished(result: Result<AgentStep>, settle: Settle = asksAll): DriverAction {
  return { type: "legFinished", result, settle };
}

function step(value: AgentStep, settle: Settle = asksAll): DriverAction {
  return finished(success(value), settle);
}

/** Every action in turn, and everything that happened on the way. */
function run(actions: DriverAction[], from: DriverPhase = initialPhase): DriverStep {
  const happened: Happened[] = [];
  let phase = from;
  for (const action of actions) {
    const next = reduceDriver(phase, action);
    happened.push(...next.happened);
    phase = next.phase;
  }
  return { phase, happened };
}

const waiting = run([step({ kind: "waitingForUser", interrupts: PAUSE })]).phase;

function legOf(phase: DriverPhase): Leg {
  if (phase.kind !== "working") {
    throw new Error(`expected working, got ${phase.kind}`);
  }
  return phase.leg;
}

function expectNothingFrom(phase: DriverPhase, action: DriverAction): void {
  const next = reduceDriver(phase, action);
  expect(next.phase).toBe(phase);
  expect(next.happened).toEqual([]);
}

describe("a turn", () => {
  it("starts a leg that answers the pause with the message", () => {
    const { phase, happened } = run([{ type: "submitted", text: "hi" }], waiting);
    expect(legOf(phase)).toEqual({ interrupts: PAUSE, responses: [approve(messageAnswer("hi"))] });
    expect(happened).toEqual([{ type: "submitted", text: "hi" }]);
  });

  it("is not started outside waitingForUser", () => {
    const working = run([{ type: "submitted", text: "hi" }], waiting).phase;
    expectNothingFrom(working, { type: "submitted", text: "again" });
    expectNothingFrom(initialPhase, { type: "submitted", text: "x" });
  });

  it("that finishes waits for the next message, and says the turn finished", () => {
    const next = pauseWith("sonnet", "pause-2");
    const { phase, happened } = run(
      [{ type: "submitted", text: "hi" }, step({ kind: "waitingForUser", interrupts: next })],
      waiting,
    );
    expect(phase).toEqual({ kind: "waitingForUser", pause: next, cancelledTexts: [] });
    expect(happened).toEqual([{ type: "submitted", text: "hi" }, { type: "turnFinished" }]);
  });

  it("does not say a turn finished when the run first pauses", () => {
    const started = reduceDriver(initialPhase, step({ kind: "waitingForUser", interrupts: PAUSE }));
    expect(started.happened).toEqual([]);
  });

  it("cancelled goes back to the same pause, and the next message carries the note", () => {
    const cancelled = run(
      [{ type: "submitted", text: "slow" }, step({ kind: "cancelled" })],
      waiting,
    );
    expect(cancelled.phase).toEqual({
      kind: "waitingForUser",
      pause: PAUSE,
      cancelledTexts: ["slow"],
    });
    expect(cancelled.happened.at(-1)).toEqual({ type: "turnCancelled" });

    const next = run([{ type: "submitted", text: "next" }], cancelled.phase);
    const note = withCancelNote({ message: "next", cancelledTexts: ["slow"] });
    expect(legOf(next.phase).responses).toEqual([approve(messageAnswer(note))]);
  });

  it("cancelled twice names both in the note", () => {
    const twice = run(
      [
        { type: "submitted", text: "slow" },
        step({ kind: "cancelled" }),
        { type: "submitted", text: "again" },
        step({ kind: "cancelled" }),
        { type: "submitted", text: "next" },
      ],
      waiting,
    );
    const note = withCancelNote({ message: "next", cancelledTexts: ["slow", "again"] });
    expect(legOf(twice.phase).responses).toEqual([approve(messageAnswer(note))]);
  });

  it("that fails goes back to the same pause with the error, and remembers the request", () => {
    const failed = run([{ type: "submitted", text: "hi" }, finished(failure("boom"))], waiting);
    expect(failed.phase).toEqual({
      kind: "waitingForUser",
      pause: PAUSE,
      cancelledTexts: [],
      failedTexts: ["hi"],
    });
    expect(failed.happened.at(-1)).toEqual({ type: "legFailed", error: "boom" });
  });

  it("that fails gives the next message a note, which names a cancel too", () => {
    const next = run(
      [
        { type: "submitted", text: "slow" },
        step({ kind: "cancelled" }),
        { type: "submitted", text: "hi" },
        finished(failure("boom")),
        { type: "submitted", text: "next" },
      ],
      waiting,
    );
    const note = withCancelNote({ message: "next", cancelledTexts: ["slow"], failedTexts: ["hi"] });
    expect(legOf(next.phase).responses).toEqual([approve(messageAnswer(note))]);
  });

  it("that finishes after a failure drops the failure's note", () => {
    const after = run(
      [
        { type: "submitted", text: "hi" },
        finished(failure("boom")),
        { type: "submitted", text: "again" },
        step({ kind: "waitingForUser", interrupts: PAUSE }),
      ],
      waiting,
    );
    expect(after.phase).toEqual({ kind: "waitingForUser", pause: PAUSE, cancelledTexts: [] });
  });
});

describe("the start", () => {
  it("that fails ends the session", () => {
    const ended = run([finished(failure("no key"))]);
    expect(ended.phase).toEqual({ kind: "ended", reason: "Could not start the agent: no key" });
    expect(ended.happened).toEqual([{ type: "startFailed", error: "no key" }]);
  });

  it("that pauses on an approval ends the session", () => {
    const ended = run([step({ kind: "needsApproval", interrupts: [interrupt("std::bash", "b")] })]);
    expect(ended.phase.kind).toBe("ended");
    expect(ended.happened).toEqual([
      { type: "startFailed", error: "unexpected needsApproval before the first message" },
    ]);
  });
});

const TO_OPUS: SettingsAnswer = { kind: "model", spec: "anthropic/opus" };

function answering(from: DriverPhase = waiting): DriverPhase {
  return run([{ type: "answered", answer: TO_OPUS }], from).phase;
}

describe("a settings answer", () => {
  it("answers the pause with the core's answer, and is not a turn", () => {
    const { phase, happened } = run([{ type: "answered", answer: TO_OPUS }], waiting);
    expect(phase).toMatchObject({
      kind: "answering",
      answer: TO_OPUS,
      leg: { interrupts: PAUSE, responses: [approve(TO_OPUS)] },
    });
    expect(happened).toEqual([]);
  });

  it("reports what the run said before and after", () => {
    const applied = pauseWith("opus", "pause-2");
    const { phase, happened } = run(
      [step({ kind: "waitingForUser", interrupts: applied })],
      answering(),
    );
    expect(phase).toEqual({ kind: "waitingForUser", pause: applied, cancelledTexts: [] });
    expect(happened).toEqual([
      { type: "answered", before: reported("sonnet"), after: reported("opus") },
    ]);
  });

  it("that fails goes back to the same pause with the error", () => {
    const { phase, happened } = run([finished(failure("boom"))], answering());
    expect(phase).toEqual({ kind: "waitingForUser", pause: PAUSE, cancelledTexts: [] });
    expect(happened).toEqual([{ type: "legFailed", error: "boom" }]);
  });

  it("keeps a cancelled request for the next message's note", () => {
    const cancelled = run(
      [{ type: "submitted", text: "slow" }, step({ kind: "cancelled" })],
      waiting,
    ).phase;
    const applied = pauseWith("opus", "pause-2");
    const next = run(
      [
        { type: "answered", answer: TO_OPUS },
        step({ kind: "waitingForUser", interrupts: applied }),
        { type: "submitted", text: "next" },
      ],
      cancelled,
    );
    const note = withCancelNote({ message: "next", cancelledTexts: ["slow"] });
    expect(legOf(next.phase)).toEqual({
      interrupts: applied,
      responses: [approve(messageAnswer(note))],
    });
  });

  it("is taken only while the run waits for a message", () => {
    const working = run([{ type: "submitted", text: "hi" }], waiting).phase;
    expectNothingFrom(working, { type: "answered", answer: TO_OPUS });
    expectNothingFrom(answering(), { type: "submitted", text: "too soon" });
  });
});

/** A turn paused on three approvals at once: two reads and a shell command. */
function askingForThree(settle: Settle = asksAll): DriverStep {
  const batch = [
    interrupt("std::read", "read-1"),
    interrupt("std::read", "read-2"),
    interrupt("std::bash", "bash-1"),
  ];
  return run(
    [{ type: "submitted", text: "hi" }, step({ kind: "needsApproval", interrupts: batch }, settle)],
    waiting,
  );
}

function showing(phase: DriverPhase): string | undefined {
  if (phase.kind !== "approving") {
    throw new Error(`expected approving, got ${phase.kind}`);
  }
  const { queue } = phase;
  return queue.interrupts[queue.responses.length]?.interruptId;
}

const readsByRule: Settle = (waitingOn) =>
  waitingOn.effect === "std::read" ? { response: approve(), by: "rule" } : null;

describe("approvals", () => {
  it("are asked, and the answer resumes the run", () => {
    const tool = interrupt("std::bash", "tool-1");
    const asking = run(
      [{ type: "submitted", text: "hi" }, step({ kind: "needsApproval", interrupts: [tool] })],
      waiting,
    ).phase;
    expect(asking.kind).toBe("approving");
    const resumed = run(
      [{ type: "decided", response: approve(), interruptId: "tool-1", settle: asksAll }],
      asking,
    );
    expect(legOf(resumed.phase)).toEqual({ interrupts: [tool], responses: [approve()] });
    expect(resumed.happened).toEqual([]);
  });

  it("a rule decides are settled when the pause comes back, and reported", () => {
    const { phase, happened } = askingForThree(readsByRule);
    expect(showing(phase)).toBe("bash-1");
    expect(happened.filter((event) => event.type === "settled")).toEqual([
      {
        type: "settled",
        interrupt: interrupt("std::read", "read-1"),
        response: approve(),
        by: "rule",
      },
      {
        type: "settled",
        interrupt: interrupt("std::read", "read-2"),
        response: approve(),
        by: "rule",
      },
    ]);
  });

  it("after an answer are settled by the rule it saved", () => {
    const next = run(
      [{ type: "decided", response: approve(), interruptId: "read-1", settle: readsByRule }],
      askingForThree().phase,
    );
    expect(showing(next.phase)).toBe("bash-1");
    expect(next.happened).toEqual([
      {
        type: "settled",
        interrupt: interrupt("std::read", "read-2"),
        response: approve(),
        by: "rule",
      },
    ]);
  });

  it("all settled by an answer's rule resume the run", () => {
    const rejectAll: Settle = () => ({ response: reject(), by: "rule" });
    const resumed = run(
      [{ type: "decided", response: reject(), interruptId: "read-1", settle: rejectAll }],
      askingForThree().phase,
    );
    expect(legOf(resumed.phase).responses).toEqual([reject(), reject(), reject()]);
    expect(resumed.happened).toHaveLength(2);
  });

  it("all settled at the pause resume the run at once", () => {
    const all: Settle = () => ({ response: approve(), by: "rule" });
    const { phase } = askingForThree(all);
    expect(legOf(phase).responses).toEqual([approve(), approve(), approve()]);
  });

  it("an answer for one that isn't showing is ignored", () => {
    const asking = askingForThree().phase;
    expectNothingFrom(asking, {
      type: "decided",
      response: approve(),
      interruptId: "bash-1",
      settle: asksAll,
    });
  });

  it("an answer outside approving changes nothing", () => {
    expectNothingFrom(waiting, {
      type: "decided",
      response: approve(),
      interruptId: "x",
      settle: asksAll,
    });
  });

  it("cancelled drops the turn and goes back to the pause", () => {
    const asking = run(
      [
        { type: "submitted", text: "delete it" },
        step({ kind: "needsApproval", interrupts: [interrupt("std::bash", "tool-1")] }),
      ],
      waiting,
    ).phase;
    const cancelled = reduceDriver(asking, { type: "approvalCancelled" });
    expect(cancelled.phase).toEqual({
      kind: "waitingForUser",
      pause: PAUSE,
      cancelledTexts: ["delete it"],
    });
    expect(cancelled.happened).toEqual([{ type: "turnCancelled" }]);
  });

  it("approvalCancelled outside approving changes nothing", () => {
    const working = run([{ type: "submitted", text: "hi" }], waiting).phase;
    expectNothingFrom(working, { type: "approvalCancelled" });
  });

  it("undecidedDeclined declines what is open and resumes; elsewhere it does nothing", () => {
    const tool = interrupt("std::bash", "tool-1");
    const asking = run(
      [{ type: "submitted", text: "hi" }, step({ kind: "needsApproval", interrupts: [tool] })],
      waiting,
    ).phase;
    const action: DriverAction = {
      type: "undecidedDeclined",
      reasonFor: () => "no one to ask",
      settle: asksAll,
    };
    expect(legOf(reduceDriver(asking, action).phase)).toEqual({
      interrupts: [tool],
      responses: [reject("no one to ask")],
    });
    expectNothingFrom(waiting, action);
  });
});
