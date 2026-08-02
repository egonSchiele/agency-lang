import { describe, it, expect, vi } from "vitest";
import { resolveCliInterrupts } from "./cliInterruptResolution.js";
import type { Interrupt, InterruptResponse } from "./interrupts.js";
import type { PromptFn, ValuePromptFn } from "./interruptPrompts.js";
import {
  AGENCY_RUN_POLICY,
  AGENCY_RUN_POLICY_INTERACTIVE,
  AGENCY_RUN_POLICY_INTERACTIVE_ON,
} from "@/constants.js";

const READ_OK = JSON.stringify({ "std::read": [{ action: "approve" }] });

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe("resolveCliInterrupts", () => {
  // A minimal surfaced interrupt — enough shape for hasInterrupts and the
  // decision loop, no checkpoint needed since `respond` is a fake.
  const surfaced = (effect: string): Interrupt => ({
    type: "interrupt",
    effect,
    message: "m",
    origin: "test",
    interruptId: `id-${effect}`,
    data: {},
    runId: "run",
  });
  const done = { messages: {} as any, data: "final" };
  const withInterrupts = (...effects: string[]) => ({
    messages: {} as any,
    data: effects.map(surfaced),
  });
  const valueInterrupt = (effect: string): Interrupt => ({
    ...surfaced(effect),
    expectsValue: true,
  });
  const promptWith = (answers: string[]): PromptFn => {
    return async () => answers.shift() as any;
  };
  const INTERACTIVE_ENV = {
    [AGENCY_RUN_POLICY]: READ_OK,
    [AGENCY_RUN_POLICY_INTERACTIVE]: AGENCY_RUN_POLICY_INTERACTIVE_ON,
    AGENCY_IPC: undefined,
  };

  it("returns the result untouched when there are no interrupts", async () => {
    const respond = vi.fn();
    const result = await resolveCliInterrupts(done, respond);
    expect(result).toBe(done);
    expect(respond).not.toHaveBeenCalled();
  });

  it("without a policy env, reports unhandled and exits (historical path)", async () => {
    await withEnv({ [AGENCY_RUN_POLICY]: undefined, AGENCY_IPC: undefined }, async () => {
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as any);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const respond = vi.fn();
        await resolveCliInterrupts(withInterrupts("std::write"), respond);
        expect(exit).toHaveBeenCalledWith(1);
        expect(respond).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
        err.mockRestore();
      }
    });
  });

  it("non-interactive: rejects every surfaced interrupt and resumes", async () => {
    await withEnv(
      {
        [AGENCY_RUN_POLICY]: READ_OK,
        [AGENCY_RUN_POLICY_INTERACTIVE]: undefined,
        AGENCY_IPC: undefined,
      },
      async () => {
        const seen: InterruptResponse[][] = [];
        const respond = vi.fn(async (_i: Interrupt[], r: InterruptResponse[]) => {
          seen.push(r);
          return done;
        });
        const result = await resolveCliInterrupts(
          withInterrupts("myapp::foo", "myapp::bar"),
          respond,
        );
        expect(result).toBe(done);
        expect(seen).toEqual([[
          { type: "reject", value: undefined },
          { type: "reject", value: undefined },
        ]]);
      },
    );
  });

  it("interactive: prompts and applies the answer", async () => {
    await withEnv(INTERACTIVE_ENV, async () => {
      const respond = vi.fn(async () => done);
      await resolveCliInterrupts(withInterrupts("myapp::foo"), respond, {
        prompt: promptWith(["approve"]),
      });
      expect(respond).toHaveBeenCalledWith(
        [surfaced("myapp::foo")],
        [{ type: "approve", value: undefined }],
      );
    });
  });

  it("interactive: loops until the run finishes, remembering 'always' answers", async () => {
    await withEnv(INTERACTIVE_ENV, async () => {
      // Round 1 surfaces foo (answered approve-always); round 2 surfaces foo
      // again — served from memory, prompt NOT called a second time.
      const rounds = [withInterrupts("myapp::foo"), done];
      const respond = vi.fn(async () => rounds.shift()!);
      let promptCalls = 0;
      const prompt: PromptFn = async () => {
        promptCalls++;
        return "approve-always";
      };
      const result = await resolveCliInterrupts(
        withInterrupts("myapp::foo"),
        respond,
        { prompt },
      );
      expect(result).toBe(done);
      expect(promptCalls).toBe(1);
      expect(respond).toHaveBeenCalledTimes(2);
      expect(respond).toHaveBeenNthCalledWith(
        2,
        [surfaced("myapp::foo")],
        [{ type: "approve", value: undefined }],
      );
    });
  });

  it("interactive: a value-expecting interrupt gets the value prompt, not a/r", async () => {
    await withEnv(INTERACTIVE_ENV, async () => {
      const respond = vi.fn(async () => done);
      const prompt = vi.fn();
      const valuePrompt: ValuePromptFn = vi.fn(async () => ({
        type: "approve",
        value: "Adit",
      } as any));
      const result = await resolveCliInterrupts(
        { messages: {} as any, data: [valueInterrupt("std::input")] },
        respond,
        { prompt: prompt as any, valuePrompt },
      );
      expect(result).toBe(done);
      expect(prompt).not.toHaveBeenCalled();
      expect(valuePrompt).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        [valueInterrupt("std::input")],
        [{ type: "approve", value: "Adit" }],
      );
    });
  });

  it("value-expecting interrupts bypass remembered 'always' decisions", async () => {
    await withEnv(INTERACTIVE_ENV, async () => {
      // Round 1: a statement interrupt of effect E answered approve-always.
      // Round 2: a VALUE interrupt of the same effect E — must still hit the
      // value prompt (a standing approve can't answer a question).
      const rounds = [
        { messages: {} as any, data: [valueInterrupt("myapp::foo")] },
        done,
      ];
      const respond = vi.fn(async () => rounds.shift()!);
      const valuePrompt: ValuePromptFn = vi.fn(async () => ({
        type: "approve",
        value: "42",
      } as any));
      const result = await resolveCliInterrupts(
        withInterrupts("myapp::foo"),
        respond,
        { prompt: promptWith(["approve-always"]), valuePrompt },
      );
      expect(result).toBe(done);
      expect(valuePrompt).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenNthCalledWith(
        2,
        [valueInterrupt("myapp::foo")],
        [{ type: "approve", value: "42" }],
      );
    });
  });

  it("non-interactive: a value-expecting interrupt is rejected without prompting", async () => {
    await withEnv(
      {
        [AGENCY_RUN_POLICY]: READ_OK,
        [AGENCY_RUN_POLICY_INTERACTIVE]: undefined,
        AGENCY_IPC: undefined,
      },
      async () => {
        const respond = vi.fn(async () => done);
        const valuePrompt = vi.fn();
        await resolveCliInterrupts(
          { messages: {} as any, data: [valueInterrupt("std::input")] },
          respond,
          { valuePrompt: valuePrompt as any },
        );
        expect(valuePrompt).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledWith(
          [valueInterrupt("std::input")],
          [{ type: "reject", value: undefined }],
        );
      },
    );
  });

  it("in an IPC subprocess, never prompts or resumes (parent owns the user)", async () => {
    await withEnv({ [AGENCY_RUN_POLICY]: READ_OK, AGENCY_IPC: "1" }, async () => {
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as any);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const respond = vi.fn();
        await resolveCliInterrupts(withInterrupts("std::write"), respond);
        expect(respond).not.toHaveBeenCalled();
      } finally {
        exit.mockRestore();
        err.mockRestore();
      }
    });
  });

  // Finding 1: the environment policy must never be re-applied at the endpoint.
  // A surfaced interrupt whose effect the policy approves simulates a program
  // handler having propagated it despite that approve rule; the endpoint must
  // decide it afresh (reject / prompt), never auto-approve from the policy.
  const APPROVE_X = JSON.stringify({ X: [{ action: "approve" }] });

  it("finding 1: non-interactive rejects a surfaced, policy-approved effect", async () => {
    await withEnv(
      {
        [AGENCY_RUN_POLICY]: APPROVE_X,
        [AGENCY_RUN_POLICY_INTERACTIVE]: undefined,
        AGENCY_IPC: undefined,
      },
      async () => {
        const seen: InterruptResponse[][] = [];
        const respond = vi.fn(async (_i: Interrupt[], r: InterruptResponse[]) => {
          seen.push(r);
          return done;
        });
        await resolveCliInterrupts(withInterrupts("X"), respond);
        expect(seen).toEqual([[{ type: "reject", value: undefined }]]);
      },
    );
  });

  it("finding 1: interactive prompts a surfaced, policy-approved effect (no auto-approve)", async () => {
    await withEnv(
      {
        [AGENCY_RUN_POLICY]: APPROVE_X,
        [AGENCY_RUN_POLICY_INTERACTIVE]: AGENCY_RUN_POLICY_INTERACTIVE_ON,
        AGENCY_IPC: undefined,
      },
      async () => {
        let promptCalls = 0;
        const prompt: PromptFn = async () => {
          promptCalls++;
          return "reject";
        };
        const respond = vi.fn(async () => done);
        await resolveCliInterrupts(withInterrupts("X"), respond, { prompt });
        expect(promptCalls).toBe(1);
        expect(respond).toHaveBeenCalledWith(
          [surfaced("X")],
          [{ type: "reject", value: undefined }],
        );
      },
    );
  });
});
