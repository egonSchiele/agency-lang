import { describe, it, expect } from "vitest";
import { resolveInterrupts, buildDecider } from "./interruptResolution.js";
import type { ResumeFn, DecideFn, InterruptResult } from "./interruptResolution.js";
import type { PromptDecision, PromptFn, ValuePromptFn } from "./interruptPrompts.js";
import { approve, reject } from "./interruptResponse.js";
import type { Policy } from "./policy.js";
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

function makeInterruptFor(effect: string, expectsValue = false): Interrupt {
  return interrupt({
    effect,
    message: "?",
    data: null,
    origin: "o",
    runId: "run-1",
    interruptId: `id-${effect}-${expectsValue}`,
    expectsValue,
  });
}

/** A prompt that returns scripted answers, and records how often it was asked. */
function scriptedPrompt(answers: PromptDecision[]): { prompt: PromptFn; calls: () => number } {
  let index = 0;
  return {
    prompt: async () => answers[index++] ?? "reject",
    calls: () => index,
  };
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
    const decide: DecideFn = async (intr) => (intr.interruptId === "yes" ? approve() : reject());
    const result = await resolveInterrupts(
      { data: [makeInterrupt("yes"), makeInterrupt("no")] },
      respond,
      decide,
    );
    expect(result).toEqual({ data: [approve(), reject()] });
  });

  it("loops until the run stops pausing", async () => {
    const script: InterruptResult[] = [{ data: [makeInterrupt("second")] }, { data: "done" }];
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

describe("buildDecider", () => {
  const valuePrompt: ValuePromptFn = async () => approve("typed-value");

  it("no policy, interactive: prompts, and remembers an approve-always per effect", async () => {
    const { prompt, calls } = scriptedPrompt(["approve-always"]);
    const decide = buildDecider({ interactive: true, prompt, valuePrompt });
    expect(await decide(makeInterruptFor("X"))).toEqual(approve());
    // second X is remembered — no second prompt
    expect(await decide(makeInterruptFor("X"))).toEqual(approve());
    expect(calls()).toBe(1);
  });

  it("no policy, interactive: reject-always remembers a reject", async () => {
    const { prompt, calls } = scriptedPrompt(["reject-always"]);
    const decide = buildDecider({ interactive: true, prompt, valuePrompt });
    expect(await decide(makeInterruptFor("X"))).toEqual(reject());
    expect(await decide(makeInterruptFor("X"))).toEqual(reject());
    expect(calls()).toBe(1);
  });

  it("no policy, not interactive: rejects every interrupt without prompting", async () => {
    const { prompt, calls } = scriptedPrompt(["approve"]);
    const decide = buildDecider({ interactive: false, prompt, valuePrompt });
    expect(await decide(makeInterruptFor("X"))).toEqual(reject());
    expect(calls()).toBe(0);
  });

  it("policy approve/reject rules settle without prompting", async () => {
    const { prompt, calls } = scriptedPrompt(["approve"]);
    const policy: Policy = { A: [{ action: "approve" }], R: [{ action: "reject" }] };
    const decide = buildDecider({ policy, interactive: true, prompt, valuePrompt });
    expect(await decide(makeInterruptFor("A"))).toEqual(approve());
    expect(await decide(makeInterruptFor("R"))).toEqual(reject());
    expect(calls()).toBe(0);
  });

  it("a policy reject rule's rejectMessage becomes the rejection value", async () => {
    const { prompt, calls } = scriptedPrompt(["approve"]);
    const policy: Policy = {
      R: [{ action: "reject", rejectMessage: "Use safeBash instead" }],
    };
    const decide = buildDecider({ policy, interactive: true, prompt, valuePrompt });
    expect(await decide(makeInterruptFor("R"))).toEqual(reject("Use safeBash instead"));
    expect(calls()).toBe(0);
  });

  it("policy propagate is unsettled: prompts when interactive, else rejects; never returns propagate", async () => {
    const policy: Policy = { P: [{ action: "propagate" }] };
    const { prompt } = scriptedPrompt(["approve"]);
    const interactiveDecide = buildDecider({ policy, interactive: true, prompt, valuePrompt });
    const interactiveResult = await interactiveDecide(makeInterruptFor("P"));
    expect(interactiveResult).toEqual(approve());
    expect(interactiveResult.type).not.toBe("propagate");

    const nonInteractive = buildDecider({ policy, interactive: false, prompt, valuePrompt });
    expect(await nonInteractive(makeInterruptFor("P"))).toEqual(reject());
  });

  it("value-expecting: policy approve → valueless approve; reject → reject", async () => {
    const policy: Policy = { A: [{ action: "approve" }], R: [{ action: "reject" }] };
    const decide = buildDecider({ policy, interactive: true, valuePrompt });
    expect(await decide(makeInterruptFor("A", true))).toEqual(approve());
    expect(await decide(makeInterruptFor("R", true))).toEqual(reject());
  });

  it("value-expecting: unsettled uses the value prompt when interactive, else rejects", async () => {
    const interactiveDecide = buildDecider({ interactive: true, valuePrompt });
    expect(await interactiveDecide(makeInterruptFor("X", true))).toEqual(approve("typed-value"));

    const nonInteractive = buildDecider({ interactive: false, valuePrompt });
    expect(await nonInteractive(makeInterruptFor("X", true))).toEqual(reject());
  });
});
