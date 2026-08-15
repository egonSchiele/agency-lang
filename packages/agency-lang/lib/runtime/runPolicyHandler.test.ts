import { describe, it, expect, vi } from "vitest";
import {
  makeRunPolicyHandler,
  terminalPrompt,
  terminalValuePrompt,
  parsePromptAnswer,
  parseValueAnswer,
  installRunPolicyHandler,
  formatInterruptPrompt,
} from "./runPolicyHandler.js";
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

describe("parseValueAnswer", () => {
  it("typed text becomes the approval value verbatim", () => {
    expect(parseValueAnswer("Adit")).toEqual({ type: "approve", value: "Adit" });
    // Even text that looks like a decision keyword IS the answer.
    expect(parseValueAnswer("r")).toEqual({ type: "approve", value: "r" });
  });

  it("an empty or whitespace-only line rejects (incl. the EOF fallback)", () => {
    expect(parseValueAnswer("").type).toBe("reject");
    expect(parseValueAnswer("   ").type).toBe("reject");
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
      const out = plain(formatInterruptPrompt({ effect: "e", message: "m", data, origin: "t" }));
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
    const out = plain(formatInterruptPrompt({ effect, message: "m", data: {}, origin: "t" }));
    expect(out).toContain("─".repeat(50));
  });

  it("does not throw on unserializable data (circular, BigInt)", () => {
    const circular: any = { name: "loop" };
    circular.self = circular;
    for (const data of [circular, { n: BigInt(1) }]) {
      const out = plain(formatInterruptPrompt({ effect: "e", message: "m", data, origin: "t" }));
      expect(out).toContain("[object Object]"); // best-effort String() fallback
    }
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
      const v = await terminalValuePrompt({
        effect: "myapp::foo",
        message: "m",
        data: {},
        origin: "t",
        expectsValue: true,
      });
      expect(v.type).toBe("reject");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: prev,
        configurable: true,
      });
    }
  });
});

const READ_OK = JSON.stringify({ "std::read": [{ action: "approve" }] });

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
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
  it("pushes a handler when AGENCY_RUN_POLICY is set (root process)", async () => {
    await withEnv({ [AGENCY_RUN_POLICY]: READ_OK, AGENCY_IPC: undefined }, () => {
      const pushed: unknown[] = [];
      installRunPolicyHandler({ pushHandler: (h) => pushed.push(h) });
      expect(pushed).toHaveLength(1);
    });
  });

  it("is a no-op when AGENCY_RUN_POLICY is unset", async () => {
    await withEnv({ [AGENCY_RUN_POLICY]: undefined, AGENCY_IPC: undefined }, () => {
      const pushed: unknown[] = [];
      installRunPolicyHandler({ pushHandler: (h) => pushed.push(h) });
      expect(pushed).toHaveLength(0);
    });
  });

  it("is a no-op in an IPC subprocess even when the policy env is set", async () => {
    // isIpcMode() reads AGENCY_IPC === "1". The policy lives at the root; a
    // subprocess forwards its interrupts up, so it must NOT install its own.
    await withEnv({ [AGENCY_RUN_POLICY]: READ_OK, AGENCY_IPC: "1" }, () => {
      const pushed: unknown[] = [];
      installRunPolicyHandler({ pushHandler: (h) => pushed.push(h) });
      expect(pushed).toHaveLength(0);
    });
  });
});
