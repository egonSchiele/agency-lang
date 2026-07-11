import { describe, it, expect, vi } from "vitest";
import {
  makeRunPolicyHandler,
  terminalPrompt,
  parsePromptAnswer,
  installRunPolicyHandler,
  resolveCliInterrupts,
  formatInterruptPrompt,
  type PromptFn,
} from "./runPolicyHandler.js";
import type { Interrupt, InterruptResponse } from "./interrupts.js";
import {
  AGENCY_RUN_POLICY,
  AGENCY_RUN_POLICY_INTERACTIVE,
  AGENCY_RUN_POLICY_INTERACTIVE_ON,
} from "@/constants.js";

const intr = (effect: string, data: any = {}) => ({
  effect,
  message: "m",
  data,
  origin: "test",
});

describe("makeRunPolicyHandler", () => {
  it("approves an effect the policy approves", async () => {
    const h = makeRunPolicyHandler({ "std::read": [{ action: "approve" }] });
    expect(await h(intr("std::read"))).toEqual({ type: "approve", value: undefined });
  });

  it("rejects an effect the policy rejects", async () => {
    const h = makeRunPolicyHandler({ "std::write": [{ action: "reject" }] });
    expect((await h(intr("std::write")))!.type).toBe("reject");
  });

  it("stays silent on an unmatched effect (the chain decides)", async () => {
    const h = makeRunPolicyHandler({ "std::read": [{ action: "approve" }] });
    expect(await h(intr("myapp::foo"))).toBeUndefined();
  });

  it("returns propagate for an explicit propagate rule", async () => {
    const h = makeRunPolicyHandler({ "std::write": [{ action: "propagate" }] });
    expect((await h(intr("std::write")))!.type).toBe("propagate");
  });

  it("honors the '*' wildcard", async () => {
    const h = makeRunPolicyHandler({ "*": [{ action: "approve" }] });
    expect((await h(intr("anything::at::all")))!.type).toBe("approve");
  });
});

describe("parsePromptAnswer", () => {
  it("maps short forms to decisions", () => {
    expect(parsePromptAnswer("a")).toBe("approve");
    expect(parsePromptAnswer("r")).toBe("reject");
    expect(parsePromptAnswer("aa")).toBe("approve-always");
    expect(parsePromptAnswer("rr")).toBe("reject-always");
  });

  it("accepts spelled-out words (so 'approve' isn't silently a reject)", () => {
    expect(parsePromptAnswer("approve")).toBe("approve");
    expect(parsePromptAnswer("reject")).toBe("reject");
    expect(parsePromptAnswer("approve-always")).toBe("approve-always");
    expect(parsePromptAnswer("reject-always")).toBe("reject-always");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(parsePromptAnswer("  AA \n")).toBe("approve-always");
    expect(parsePromptAnswer("Approve")).toBe("approve");
  });

  it("fails closed on anything unrecognized", () => {
    expect(parsePromptAnswer("")).toBe("reject");
    expect(parsePromptAnswer("yes")).toBe("reject");
    expect(parsePromptAnswer("maybe")).toBe("reject");
  });
});

describe("formatInterruptPrompt", () => {
  // Strip ANSI codes so assertions read the visible text, not escape bytes.
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  it("shows effect, a rule, and the message", () => {
    const out = plain(
      formatInterruptPrompt({
        effect: "std::error",
        message: "This is a test error",
        data: {},
        origin: "t",
      }),
    );
    expect(out).toContain("std::error\n");
    expect(out).toContain("─".repeat(36));
    expect(out).toContain("This is a test error");
  });

  it("omits data when it is an empty object or null", () => {
    for (const data of [{}, null, undefined]) {
      const out = plain(
        formatInterruptPrompt({ effect: "e", message: "m", data, origin: "t" }),
      );
      expect(out).not.toContain("{}");
      expect(out).not.toContain("null");
      expect(out).not.toContain("undefined");
    }
  });

  it("pretty-prints data when present", () => {
    const out = plain(
      formatInterruptPrompt({
        effect: "std::edit",
        message: "m",
        data: { path: "/tmp/x", mode: "w" },
        origin: "t",
      }),
    );
    expect(out).toContain(JSON.stringify({ path: "/tmp/x", mode: "w" }, null, 2));
  });

  it("extends the rule to cover a long effect name", () => {
    const effect = "a".repeat(50);
    const out = plain(
      formatInterruptPrompt({ effect, message: "m", data: {}, origin: "t" }),
    );
    expect(out).toContain("─".repeat(50));
  });
});

describe("terminalPrompt", () => {
  it("returns 'reject' when stdin is not a TTY (fail-closed, no hang)", async () => {
    const prev = process.stdin.isTTY;
    // Force non-TTY; readline is never constructed on this branch.
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    try {
      const d = await terminalPrompt({
        effect: "myapp::foo",
        message: "m",
        data: {},
        origin: "t",
      });
      expect(d).toBe("reject");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: prev,
        configurable: true,
      });
    }
  });
});

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

describe("installRunPolicyHandler", () => {
  it("pushes a handler when AGENCY_RUN_POLICY is set (root process)", () => {
    withEnv({ [AGENCY_RUN_POLICY]: READ_OK, AGENCY_IPC: undefined }, () => {
      const pushed: unknown[] = [];
      installRunPolicyHandler({ pushHandler: (h) => pushed.push(h) });
      expect(pushed).toHaveLength(1);
    });
  });

  it("is a no-op when AGENCY_RUN_POLICY is unset", () => {
    withEnv({ [AGENCY_RUN_POLICY]: undefined, AGENCY_IPC: undefined }, () => {
      const pushed: unknown[] = [];
      installRunPolicyHandler({ pushHandler: (h) => pushed.push(h) });
      expect(pushed).toHaveLength(0);
    });
  });

  it("is a no-op in an IPC subprocess even when the policy env is set", () => {
    // isIpcMode() reads AGENCY_IPC === "1". The policy lives at the root; a
    // subprocess forwards its interrupts up, so it must NOT install its own.
    withEnv({ [AGENCY_RUN_POLICY]: READ_OK, AGENCY_IPC: "1" }, () => {
      const pushed: unknown[] = [];
      installRunPolicyHandler({ pushHandler: (h) => pushed.push(h) });
      expect(pushed).toHaveLength(0);
    });
  });
});

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
  const promptWith = (answers: string[]): PromptFn => {
    return async () => answers.shift() as any;
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
    await withEnv(
      {
        [AGENCY_RUN_POLICY]: READ_OK,
        [AGENCY_RUN_POLICY_INTERACTIVE]: AGENCY_RUN_POLICY_INTERACTIVE_ON,
        AGENCY_IPC: undefined,
      },
      async () => {
        const respond = vi.fn(async () => done);
        await resolveCliInterrupts(withInterrupts("myapp::foo"), respond, {
          prompt: promptWith(["approve"]),
        });
        expect(respond).toHaveBeenCalledWith(
          [surfaced("myapp::foo")],
          [{ type: "approve", value: undefined }],
        );
      },
    );
  });

  it("interactive: loops until the run finishes, remembering 'always' answers", async () => {
    await withEnv(
      {
        [AGENCY_RUN_POLICY]: READ_OK,
        [AGENCY_RUN_POLICY_INTERACTIVE]: AGENCY_RUN_POLICY_INTERACTIVE_ON,
        AGENCY_IPC: undefined,
      },
      async () => {
        // Round 1 surfaces foo (answered approve-always); round 2 surfaces
        // foo again — served from memory, prompt NOT called a second time.
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
      },
    );
  });

  it("in an IPC subprocess, never prompts or resumes (parent owns the user)", async () => {
    await withEnv(
      { [AGENCY_RUN_POLICY]: READ_OK, AGENCY_IPC: "1" },
      async () => {
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
      },
    );
  });
});
