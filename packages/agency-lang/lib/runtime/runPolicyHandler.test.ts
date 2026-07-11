import { describe, it, expect } from "vitest";
import {
  makeRunPolicyHandler,
  terminalPrompt,
  installRunPolicyHandler,
  type PromptFn,
} from "./runPolicyHandler.js";
import { AGENCY_RUN_POLICY } from "./runPolicyEnv.js";

const intr = (effect: string, data: any = {}) => ({
  effect,
  message: "m",
  data,
  origin: "test",
});
const neverPrompt: PromptFn = async () => {
  throw new Error("prompt should not be called");
};

describe("makeRunPolicyHandler", () => {
  it("approves an effect the policy approves", async () => {
    const h = makeRunPolicyHandler(
      { "std::read": [{ action: "approve" }] },
      { interactive: false, prompt: neverPrompt },
    );
    expect(await h(intr("std::read"))).toEqual({ type: "approve", value: undefined });
  });

  it("rejects an effect the policy rejects", async () => {
    const h = makeRunPolicyHandler(
      { "std::write": [{ action: "reject" }] },
      { interactive: false, prompt: neverPrompt },
    );
    expect((await h(intr("std::write")))!.type).toBe("reject");
  });

  it("fail-closed: unmatched effect rejects in non-interactive mode", async () => {
    const h = makeRunPolicyHandler({}, { interactive: false, prompt: neverPrompt });
    expect((await h(intr("myapp::foo")))!.type).toBe("reject");
  });

  it("interactive: prompts on an unmatched effect", async () => {
    const prompt: PromptFn = async () => "approve";
    const h = makeRunPolicyHandler({}, { interactive: true, prompt });
    expect((await h(intr("myapp::foo")))!.type).toBe("approve");
  });

  it("interactive: 'approve-always' is remembered for the run", async () => {
    let calls = 0;
    const prompt: PromptFn = async () => {
      calls++;
      return "approve-always";
    };
    const h = makeRunPolicyHandler({}, { interactive: true, prompt });
    expect((await h(intr("myapp::foo")))!.type).toBe("approve");
    expect((await h(intr("myapp::foo")))!.type).toBe("approve");
    expect(calls).toBe(1); // second call served from memory
  });

  it("interactive: 'reject-always' is remembered for the run", async () => {
    let calls = 0;
    const prompt: PromptFn = async () => {
      calls++;
      return "reject-always";
    };
    const h = makeRunPolicyHandler({}, { interactive: true, prompt });
    expect((await h(intr("myapp::foo")))!.type).toBe("reject");
    expect((await h(intr("myapp::foo")))!.type).toBe("reject");
    expect(calls).toBe(1); // second call served from a remembered reject rule
  });

  it("honors the '*' wildcard", async () => {
    const h = makeRunPolicyHandler(
      { "*": [{ action: "approve" }] },
      { interactive: false, prompt: neverPrompt },
    );
    expect((await h(intr("anything::at::all")))!.type).toBe("approve");
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

describe("installRunPolicyHandler", () => {
  const READ_OK = JSON.stringify({ "std::read": [{ action: "approve" }] });

  function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) {
      prev[k] = process.env[k];
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k];
    }
    try {
      fn();
    } finally {
      for (const k of Object.keys(prev)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

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
