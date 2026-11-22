import { describe, it, expect, vi } from "vitest";
import { nodeHost } from "@/host/node/nodeHost.js";
import { resolvePolicyDirs } from "@/runtime/policyDirs.js";
import type { Policy, PolicyDirs } from "@/runtime/policy.js";

const DIRS = resolvePolicyDirs(nodeHost());

/** The host, the resolved policy directories, and the run policy slot a
 *  real execution context carries, built from the process the way the
 *  default host builds them. */
function hostAndDirs(): {
  host: ReturnType<typeof nodeHost>;
  policyDirs: PolicyDirs;
  runPolicy: Policy | null;
} {
  const host = nodeHost();
  return { host, policyDirs: resolvePolicyDirs(host), runPolicy: null };
}
import {
  makeRunPolicyHandler,
  terminalPrompt,
  terminalValuePrompt,
  parsePromptAnswer,
  parseValueAnswer,
  installRunPolicyHandler,
  formatInterruptPrompt,
  unansweredMode,
} from "./runPolicyHandler.js";
import {
  AGENCY_CARRIER_ON,
  AGENCY_RUN_POLICY,
  AGENCY_RUN_POLICY_INTERACTIVE,
  AGENCY_RUN_POLICY_INTERACTIVE_ON,
  AGENCY_RUN_POLICY_WAIT,
} from "@/constants.js";

const intr = (effect: string, data: any = {}) => ({
  effect,
  message: "m",
  data,
  origin: "test",
});

describe("makeRunPolicyHandler", () => {
  it("approves an effect the policy approves", async () => {
    const h = makeRunPolicyHandler({ "std::read": [{ action: "approve" }] }, DIRS);
    expect(await h(intr("std::read"))).toEqual({ type: "approve", value: undefined });
  });

  it("rejects an effect the policy rejects", async () => {
    const h = makeRunPolicyHandler({ "std::write": [{ action: "reject" }] }, DIRS);
    expect((await h(intr("std::write")))!.type).toBe("reject");
  });

  it("a reject rule's rejectMessage becomes the rejection value", async () => {
    const h = makeRunPolicyHandler(
      {
        "std::bash": [{ action: "reject", rejectMessage: "Use safeBash instead" }],
      },
      DIRS,
    );
    expect(await h(intr("std::bash"))).toEqual({
      type: "reject",
      value: "Use safeBash instead",
    });
  });

  it("stays silent on an unmatched effect (the chain decides)", async () => {
    const h = makeRunPolicyHandler({ "std::read": [{ action: "approve" }] }, DIRS);
    expect(await h(intr("myapp::foo"))).toBeUndefined();
  });

  it("returns propagate for an explicit propagate rule", async () => {
    const h = makeRunPolicyHandler({ "std::write": [{ action: "propagate" }] }, DIRS);
    expect((await h(intr("std::write")))!.type).toBe("propagate");
  });

  it("honors the '*' wildcard", async () => {
    const h = makeRunPolicyHandler({ "*": [{ action: "approve" }] }, DIRS);
    expect((await h(intr("anything::at::all")))!.type).toBe("approve");
  });

  // The rule said approve, and nobody is present to give a value, so the
  // raise gets the approval with no value: a null answer, which the effect
  // gives a meaning.
  it("approves a raise that expects a value with no value in a non-interactive run", async () => {
    const asking = { ...intr("std::workflow::review"), expectsValue: true };
    const named = makeRunPolicyHandler({ "std::workflow::review": [{ action: "approve" }] }, DIRS);
    expect(await named(asking)).toEqual({ type: "approve" });
    const wildcard = makeRunPolicyHandler({ "*": [{ action: "approve" }] }, DIRS);
    expect(await wildcard(asking)).toEqual({ type: "approve" });
  });

  // A person is present, so the value prompt gives the answer its content.
  it("stays silent on a raise that expects a value in an interactive run", async () => {
    const asking = { ...intr("std::workflow::review"), expectsValue: true };
    const h = makeRunPolicyHandler({ "*": [{ action: "approve" }] }, DIRS, true);
    expect(await h(asking)).toBeUndefined();
    // A statement raise under the same rule is still approved.
    expect(await h(intr("std::read"))).toEqual({ type: "approve" });
  });

  it("still rejects a raise that expects a value when a reject rule matches", async () => {
    const asking = { ...intr("std::question"), expectsValue: true };
    const h = makeRunPolicyHandler(
      { "std::question": [{ action: "reject", rejectMessage: "No questions" }] },
      DIRS,
    );
    expect(await h(asking)).toEqual({ type: "reject", value: "No questions" });
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
      installRunPolicyHandler({ pushHandler: (h) => pushed.push(h), ...hostAndDirs() });
      expect(pushed).toHaveLength(1);
    });
  });

  it("is a no-op when AGENCY_RUN_POLICY is unset", async () => {
    await withEnv({ [AGENCY_RUN_POLICY]: undefined, AGENCY_IPC: undefined }, () => {
      const pushed: unknown[] = [];
      installRunPolicyHandler({ pushHandler: (h) => pushed.push(h), ...hostAndDirs() });
      expect(pushed).toHaveLength(0);
    });
  });

  it("is a no-op in an IPC subprocess even when the policy env is set", async () => {
    // isIpcMode() reads AGENCY_IPC === "1". The policy lives at the root; a
    // subprocess forwards its interrupts up, so it must NOT install its own.
    await withEnv({ [AGENCY_RUN_POLICY]: READ_OK, AGENCY_IPC: "1" }, () => {
      const pushed: unknown[] = [];
      installRunPolicyHandler({ pushHandler: (h) => pushed.push(h), ...hostAndDirs() });
      expect(pushed).toHaveLength(0);
    });
  });

  it("keeps the policy it installed on the run, for runPolicy() to read", async () => {
    await withEnv({ [AGENCY_RUN_POLICY]: READ_OK, AGENCY_IPC: undefined }, () => {
      const ctx = { pushHandler: () => {}, ...hostAndDirs() };
      installRunPolicyHandler(ctx);
      expect(ctx.runPolicy).toEqual(JSON.parse(READ_OK));
    });
  });

  it("keeps an explicit policy over the environment's", async () => {
    await withEnv({ [AGENCY_RUN_POLICY]: READ_OK, AGENCY_IPC: undefined }, () => {
      const ctx = { pushHandler: () => {}, ...hostAndDirs() };
      const explicit: Policy = { "std::bash": [{ action: "reject" }] };
      installRunPolicyHandler(ctx, explicit);
      expect(ctx.runPolicy).toEqual(explicit);
    });
  });

  it("keeps no policy in an IPC subprocess, which installs none", async () => {
    await withEnv({ [AGENCY_RUN_POLICY]: READ_OK, AGENCY_IPC: "1" }, () => {
      const ctx = { pushHandler: () => {}, ...hostAndDirs() };
      installRunPolicyHandler(ctx);
      expect(ctx.runPolicy).toBeNull();
    });
  });
});

describe("unansweredMode", () => {
  const read = (vars: Record<string, string>) => ({
    read: (name: string) => vars[name] ?? null,
    log: () => {},
  });

  it("rejects with neither flag, prompts under --interactive, waits under --wait-for-response", () => {
    expect(unansweredMode(read({}))).toBe("reject");
    expect(
      unansweredMode(read({ [AGENCY_RUN_POLICY_INTERACTIVE]: AGENCY_RUN_POLICY_INTERACTIVE_ON })),
    ).toBe("prompt");
    expect(unansweredMode(read({ [AGENCY_RUN_POLICY_WAIT]: AGENCY_CARRIER_ON }))).toBe("wait");
  });
});

describe("the root policy handler under --wait-for-response", () => {
  const APPROVE_ALL = JSON.stringify({ "*": [{ action: "approve" }] });
  const installed = () => {
    const pushed: unknown[] = [];
    installRunPolicyHandler({ pushHandler: (h) => pushed.push(h), ...hostAndDirs() });
    return pushed[0] as (i: unknown) => Promise<{ type: string } | undefined>;
  };

  // `agency attach` can supply the value, so the rule must not answer the
  // raise with no value. Without the flag the same rule does.
  it("leaves a raise that expects a value to the person, and approves one that does not", async () => {
    const asking = { ...intr("std::question"), expectsValue: true };
    await withEnv(
      {
        [AGENCY_RUN_POLICY]: APPROVE_ALL,
        [AGENCY_RUN_POLICY_WAIT]: AGENCY_CARRIER_ON,
        [AGENCY_RUN_POLICY_INTERACTIVE]: undefined,
        AGENCY_IPC: undefined,
      },
      async () => {
        const handler = installed();
        expect(await handler(asking)).toBeUndefined();
        expect((await handler(intr("std::read")))?.type).toBe("approve");
      },
    );
    await withEnv(
      {
        [AGENCY_RUN_POLICY]: APPROVE_ALL,
        [AGENCY_RUN_POLICY_WAIT]: undefined,
        [AGENCY_RUN_POLICY_INTERACTIVE]: undefined,
        AGENCY_IPC: undefined,
      },
      async () => {
        expect((await installed()(asking))?.type).toBe("approve");
      },
    );
  });
});

describe("installRunPolicyHandler with an explicit policy", () => {
  const grab = () => {
    const pushed: unknown[] = [];
    return { pushed, execCtx: { pushHandler: (h: unknown) => pushed.push(h), ...hostAndDirs() } };
  };

  it("installs the explicit policy with no env policy set", async () => {
    await withEnv({ [AGENCY_RUN_POLICY]: undefined, AGENCY_IPC: undefined }, () => {
      const { pushed, execCtx } = grab();
      installRunPolicyHandler(execCtx, { "std::read": [{ action: "approve" }] });
      expect(pushed).toHaveLength(1);
    });
  });

  it("an explicit policy replaces a DISAGREEING env policy (env is not merged in)", async () => {
    // The env policy rejects std::read; the explicit policy approves it. The
    // installed handler must approve — this fails if the env policy leaks
    // through. (Two agreeing policies would pass either way.)
    const envRejectsRead = JSON.stringify({ "std::read": [{ action: "reject" }] });
    await withEnv({ [AGENCY_RUN_POLICY]: envRejectsRead, AGENCY_IPC: undefined }, async () => {
      const { pushed, execCtx } = grab();
      installRunPolicyHandler(execCtx, { "std::read": [{ action: "approve" }] });
      expect(pushed).toHaveLength(1);
      const handler = pushed[0] as (i: unknown) => Promise<{ type: string } | undefined>;
      const verdict = await handler(intr("std::read"));
      expect(verdict?.type).toBe("approve");
    });
  });

  it("falls back to the env policy when no explicit policy is passed", async () => {
    const envRejectsRead = JSON.stringify({ "std::read": [{ action: "reject" }] });
    await withEnv({ [AGENCY_RUN_POLICY]: envRejectsRead, AGENCY_IPC: undefined }, async () => {
      const { pushed, execCtx } = grab();
      installRunPolicyHandler(execCtx, undefined);
      expect(pushed).toHaveLength(1);
      const handler = pushed[0] as (i: unknown) => Promise<{ type: string } | undefined>;
      const verdict = await handler(intr("std::read"));
      expect(verdict?.type).toBe("reject");
    });
  });

  it("is still a no-op in an IPC subprocess, explicit policy or not", async () => {
    await withEnv({ [AGENCY_RUN_POLICY]: undefined, AGENCY_IPC: "1" }, () => {
      const { pushed, execCtx } = grab();
      installRunPolicyHandler(execCtx, { "std::read": [{ action: "approve" }] });
      expect(pushed).toHaveLength(0);
    });
  });

  it("stays a no-op with no explicit policy and no env policy (the pin)", async () => {
    await withEnv({ [AGENCY_RUN_POLICY]: undefined, AGENCY_IPC: undefined }, () => {
      const { pushed, execCtx } = grab();
      installRunPolicyHandler(execCtx, undefined);
      expect(pushed).toHaveLength(0);
    });
  });
});
