import { describe, expect, it } from "vitest";
import { AgencyAbort } from "../../runtime/errors.js";
import type { Interrupt } from "../../runtime/interrupts.js";
import { approve } from "../../runtime/interruptResponse.js";
import type { RunUsage } from "../../runtime/invocationUsage.js";
import type { Policy } from "../../runtime/policy.js";
import { failure as runFailure } from "../../runtime/result.js";
import type { RunNodeResult } from "../../runtime/types.js";
import {
  PAUSE_WITH_OTHER_INTERRUPTS_ERROR,
  RUN_ENDED_ERROR,
  resumeRun,
  startRun,
  toStep,
  withCancelNote,
  type AgentModule,
  type ResumeOptions,
  type StartOptions,
} from "./run.js";

// The real runs are driven in tests/agency-js/agent-driver. These use a
// stand-in module, to see what the driver passes in and makes of what
// comes back.

function interrupt(effect: string): Interrupt {
  return {
    type: "interrupt",
    effect,
    message: "",
    origin: "test",
    interruptId: effect,
    data: {},
    runId: "run",
  };
}

const USAGE = { tokens: { totalTokens: 3 } } as unknown as RunUsage;

function resultWith(data: unknown): RunNodeResult<unknown> {
  return {
    messages: { threads: {} },
    data,
    usage: USAGE,
    traceId: "trace",
  } as RunNodeResult<unknown>;
}

const PAUSE = [interrupt("agent::sessionInput")];
const PIN: Policy = { "agent::sessionInput": [{ action: "propagate" }] };

/** A module that returns `data`, or throws `thrown`, and keeps the
 *  options it was called with. */
function standIn(args: { data?: unknown; thrown?: unknown }): {
  agent: AgentModule;
  started: StartOptions[];
  resumed: ResumeOptions[];
} {
  const started: StartOptions[] = [];
  const resumed: ResumeOptions[] = [];
  const answer = async (): Promise<RunNodeResult<unknown>> => {
    if (args.thrown !== undefined) {
      throw args.thrown;
    }
    return resultWith(args.data);
  };
  const agent: AgentModule = {
    main: (opts) => {
      started.push(opts);
      return answer();
    },
    respondToInterrupts: (_interrupts, _responses, opts) => {
      resumed.push(opts);
      return answer();
    },
  };
  return { agent, started, resumed };
}

function resume(agent: AgentModule, policy: Policy | null) {
  return resumeRun({
    agent,
    callbacks: {},
    policy,
    interrupts: PAUSE,
    responses: [approve()],
  });
}

describe("toStep", () => {
  it("reads the core's pause as waiting for the user", () => {
    expect(toStep(resultWith(PAUSE))).toEqual({
      success: true,
      value: { kind: "waitingForUser", interrupts: PAUSE },
    });
  });

  it("reads any other interrupts as approvals", () => {
    const asked = [interrupt("std::bash")];
    expect(toStep(resultWith(asked))).toEqual({
      success: true,
      value: { kind: "needsApproval", interrupts: asked },
    });
  });

  it("fails when the pause comes with other interrupts", () => {
    const mixed = [...PAUSE, interrupt("std::bash")];
    expect(toStep(resultWith(mixed))).toEqual({
      success: false,
      error: PAUSE_WITH_OTHER_INTERRUPTS_ERROR,
    });
  });

  it("reads a failure as its error, and a run that returned as ended", () => {
    expect(toStep(resultWith(runFailure("boom")))).toEqual({ success: false, error: "boom" });
    expect(toStep(resultWith("done"))).toEqual({ success: false, error: RUN_ENDED_ERROR });
  });
});

describe("startRun and resumeRun", () => {
  it("pin the pause in the policy they are given", async () => {
    const policy: Policy = { "*": [{ action: "reject" }] };
    const { agent, started, resumed } = standIn({ data: PAUSE });
    await startRun({ agent, callbacks: {}, policy });
    await resume(agent, policy);
    const pinned = { "*": [{ action: "reject" }], ...PIN };
    expect(started[0].policy).toEqual(pinned);
    expect(resumed[0].invocation?.policy).toEqual(pinned);
  });

  it("give a run with no policy just the pin", async () => {
    const { agent, started, resumed } = standIn({ data: PAUSE });
    await startRun({ agent, callbacks: {}, policy: null });
    await resume(agent, null);
    expect(started[0].policy).toEqual(PIN);
    expect(resumed[0].invocation?.policy).toEqual(PIN);
  });

  it("pass the callbacks again on a resume", async () => {
    const callbacks = { onEmit: () => undefined };
    const { agent, resumed } = standIn({ data: PAUSE });
    await resumeRun({ agent, callbacks, policy: null, interrupts: PAUSE, responses: [] });
    expect(resumed[0].metadata.callbacks).toBe(callbacks);
  });

  it("give back the step and the run's usage", async () => {
    const { agent } = standIn({ data: PAUSE });
    const outcome = await startRun({ agent, callbacks: {}, policy: null });
    expect(outcome.result.success).toBe(true);
    expect(outcome.usage).toBe(USAGE);
  });

  it("turn an abort into cancelled", async () => {
    const { agent } = standIn({ thrown: new AgencyAbort("stop", { kind: "userInterrupt" }) });
    expect(await resume(agent, null)).toEqual({
      result: { success: true, value: { kind: "cancelled" } },
      usage: null,
      startedJobs: [],
    });
  });

  it("turn a throw into a failure", async () => {
    const { agent } = standIn({ thrown: new Error("no key") });
    const outcome = await startRun({ agent, callbacks: {}, policy: null });
    expect(outcome).toEqual({
      result: { success: false, error: "no key" },
      usage: null,
      startedJobs: [],
    });
  });
});

describe("withCancelNote", () => {
  it("prefixes the exact note", () => {
    expect(withCancelNote({ message: "next", cancelledTexts: [] })).toBe("next");
    expect(withCancelNote({ message: "next", cancelledTexts: ["do x"] })).toBe(
      '(The user cancelled their previous request, "do x", partway through. Some of its changes may already have been made.)\n\nnext',
    );
    expect(withCancelNote({ message: "next", cancelledTexts: ["a", "b"] })).toBe(
      '(The user cancelled their previous requests, "a", "b", partway through. Some of their changes may already have been made.)\n\nnext',
    );
  });

  it("words a failed request, alone or beside a cancelled one", () => {
    expect(withCancelNote({ message: "next", cancelledTexts: [], failedTexts: ["do x"] })).toBe(
      '(The user\'s previous request, "do x", failed partway through. Some of its changes may already have been made.)\n\nnext',
    );
    expect(withCancelNote({ message: "next", cancelledTexts: ["a"], failedTexts: ["b"] })).toBe(
      '(The user cancelled their previous request, "a", partway through. Their previous request, "b", failed partway through. Some of their changes may already have been made.)\n\nnext',
    );
  });
});
