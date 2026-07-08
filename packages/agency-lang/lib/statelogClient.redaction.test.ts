import { describe, it, expect, vi, afterEach } from "vitest";
import { runInTestContext } from "./runtime/asyncContext.js";
import { RuntimeContext } from "./runtime/state/context.js";
import { ThreadStore } from "./runtime/state/threadStore.js";

function makeStdoutCtx() {
  return new RuntimeContext({
    statelogConfig: {
      host: "stdout",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
      observability: true,
    },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
}

function printed(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
}

afterEach(() => vi.restoreAllMocks());

describe("StatelogClient redaction", () => {
  it("replaces a redact-tagged primitive in a posted event with [REDACTED]", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      execCtx.globals.markRedacted("sk-secret");
      await execCtx.statelogClient.post({ event: "toolCall", args: { apiKey: "sk-secret" } });
    });
    expect(printed(spy)).toContain("[REDACTED]");
    expect(printed(spy)).not.toContain("sk-secret");
  });

  it("leaves untagged values untouched", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      await execCtx.statelogClient.post({ event: "toolCall", args: { city: "Mumbai" } });
    });
    expect(printed(spy)).toContain("Mumbai");
  });

  it("redacts a tagged object node end-to-end", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      const creds = { user: "alice", pass: "hunter2" };
      execCtx.globals.markRedacted(creds);
      await execCtx.statelogClient.post({ event: "toolCall", args: { creds } });
    });
    expect(printed(spy)).toContain("[REDACTED]");
    expect(printed(spy)).not.toContain("hunter2");
  });

  it("does not corrupt an untagged Date in the body (native-type guard)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      // Redaction is live (a tag exists) but the Date is untagged: it must
      // still serialize to its ISO string, not {}.
      execCtx.globals.markRedacted("unrelated");
      await execCtx.statelogClient.post({
        event: "toolCall",
        output: { when: new Date("2026-01-01T00:00:00.000Z") },
      });
    });
    expect(printed(spy)).toContain("2026-01-01T00:00:00.000Z");
  });

  it("never redacts envelope fields even when a colliding value is tagged", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      // 1 === STATELOG_FORMAT_VERSION. A pathological value-tag on 1 must NOT
      // touch the envelope's format_version (scoped-to-data redaction), but the
      // same value inside the payload IS redacted.
      execCtx.globals.markRedacted(1);
      await execCtx.statelogClient.post({ event: "toolCall", args: { n: 1 } });
    });
    expect(printed(spy)).toContain('"format_version":1'); // infra field intact
    expect(printed(spy)).toContain("[REDACTED]"); // payload value redacted
  });

  it("redacts an out-of-frame post via the fallback globals (agentEnd path)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    execCtx.globals.markRedacted("sk-final");
    // NO runInTestContext: this post fires outside any ALS frame, exactly like
    // the result-bearing agentEnd event after the run's frame has ended. The
    // client's fallbackGlobals (wired by createExecutionContext) must kick in.
    await execCtx.statelogClient.post({
      event: "agentEnd",
      result: { apiKey: "sk-final" },
    });
    expect(printed(spy)).toContain("[REDACTED]");
    expect(printed(spy)).not.toContain("sk-final");
  });

  it("redaction survives a fork-style globals clone (durable primitive path)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ctx = makeStdoutCtx();
    const execCtx = await ctx.createExecutionContext("r1");
    // Tag on the parent store, then run post() against a CLONE of it — exactly
    // what runInBranchAlsFrame does when entering a fork/parallel/race branch.
    // This pins the headline claim: a primitive redact tag set before a fork is
    // still honored inside the branch's post().
    execCtx.globals.markRedacted("sk-fork");
    execCtx.globals = execCtx.globals.clone();
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      await execCtx.statelogClient.post({ event: "toolCall", args: { apiKey: "sk-fork" } });
    });
    expect(printed(spy)).toContain("[REDACTED]");
    expect(printed(spy)).not.toContain("sk-fork");
  });
});
