import { describe, it, expect } from "vitest";
import { resolveInterrupts } from "./interruptResolution.js";
import type { ResumeFn, DecideFn, InterruptResult } from "./interruptResolution.js";
import { approve, reject } from "./interruptResponse.js";
import { interrupt } from "./interrupts.js";
import type { Interrupt } from "./interrupts.js";

function makeInterrupt(interruptId: string): Interrupt {
  return interrupt({
    effect: "x",
    message: "?",
    data: null,
    origin: "o",
    runId: "run-1",
    interruptId,
  });
}

describe("resolveInterrupts", () => {
  it("returns the result unchanged when there are no interrupts", async () => {
    const respond: ResumeFn<InterruptResult> = async () => {
      throw new Error("respond should not be called");
    };
    const decide: DecideFn = async () => approve();
    const result = await resolveInterrupts({ data: "done" }, respond, decide);
    expect(result).toEqual({ data: "done" });
  });

  it("resolves a single pause: respond called once with one response", async () => {
    const calls: { interrupts: Interrupt[]; responses: unknown[] }[] = [];
    const respond: ResumeFn<InterruptResult> = async (interrupts, responses) => {
      calls.push({ interrupts, responses });
      return { data: "final" };
    };
    const decide: DecideFn = async () => approve();
    const result = await resolveInterrupts({ data: [makeInterrupt("a")] }, respond, decide);
    expect(result).toEqual({ data: "final" });
    expect(calls).toHaveLength(1);
    expect(calls[0].responses).toEqual([approve()]);
  });

  it("decides several interrupts in one pause, in order", async () => {
    const respond: ResumeFn<InterruptResult> = async (_interrupts, responses) => {
      return { data: responses };
    };
    // approve the first, reject the second, keyed by effect stashed in id
    const decide: DecideFn = async (intr) =>
      intr.interruptId === "yes" ? approve() : reject();
    const result = await resolveInterrupts(
      { data: [makeInterrupt("yes"), makeInterrupt("no")] },
      respond,
      decide,
    );
    expect(result).toEqual({ data: [approve(), reject()] });
  });

  it("loops until the run stops pausing", async () => {
    const script: InterruptResult[] = [
      { data: [makeInterrupt("second")] },
      { data: "done" },
    ];
    const calls: Interrupt[][] = [];
    const respond: ResumeFn<InterruptResult> = async (interrupts) => {
      calls.push(interrupts);
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      return next;
    };
    const decide: DecideFn = async () => approve();
    const result = await resolveInterrupts({ data: [makeInterrupt("first")] }, respond, decide);
    expect(result).toEqual({ data: "done" });
    expect(calls).toHaveLength(2);
    expect(calls[0][0].interruptId).toBe("first");
    expect(calls[1][0].interruptId).toBe("second");
  });
});
