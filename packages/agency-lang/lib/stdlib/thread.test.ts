import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as smoltalk from "smoltalk";
import type { DecideResult } from "smoltalk";
import { runInTestContext } from "../runtime/asyncContext.js";
import { RuntimeContext } from "../runtime/state/context.js";
import { ThreadStore } from "../runtime/state/threadStore.js";
import { AgencyAbort, makeAbortCause } from "../runtime/errors.js";
import { isFailure } from "../runtime/result.js";
import { MAX_REPLY_ATTACHMENT_BYTES } from "../config/config.js";
import { _lastReply, _runGuarded, _viewFilePrecheck } from "./thread.js";

describe("_viewFilePrecheck", () => {
  let tmp: string;
  beforeEach(() => {
    // realpath: on macOS os.tmpdir() sits under /var, which is a symlink.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viewfile-")));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("classifies png as image and pdf as pdf", () => {
    const png = path.join(tmp, "a.png");
    const pdf = path.join(tmp, "b.pdf");
    fs.writeFileSync(png, "x");
    fs.writeFileSync(pdf, "x");
    expect(_viewFilePrecheck(png)).toEqual({ kind: "image" });
    expect(_viewFilePrecheck(pdf)).toEqual({ kind: "pdf" });
  });

  it("refuses an extension the reply pipeline cannot send", () => {
    const txt = path.join(tmp, "notes.txt");
    fs.writeFileSync(txt, "x");
    expect(() => _viewFilePrecheck(txt)).toThrow(/\.txt.*\.png/);
  });

  it("refuses a missing file", () => {
    expect(() => _viewFilePrecheck(path.join(tmp, "gone.png"))).toThrow(/not found/);
  });

  it("refuses a directory named like an image", () => {
    const dir = path.join(tmp, "folder.png");
    fs.mkdirSync(dir);
    expect(() => _viewFilePrecheck(dir)).toThrow(/not a regular file/);
  });

  it("refuses a file over the size cap", () => {
    const big = path.join(tmp, "big.png");
    const fd = fs.openSync(big, "w");
    fs.ftruncateSync(fd, MAX_REPLY_ATTACHMENT_BYTES + 1);
    fs.closeSync(fd);
    expect(() => _viewFilePrecheck(big)).toThrow(/attachment limit/);
  });
});

function makeCtx() {
  return new RuntimeContext({
    statelogConfig: {
      host: "https://example.com",
      apiKey: "test-api-key",
      projectId: "test-project",
      debugMode: false,
    },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
}

describe("_runGuarded — FailureOpts parity (C2)", () => {
  it("converts an OWNED guard trip and preserves functionName 'guard'", async () => {
    // The agency `try block()` this replaced lowered to __tryCall with
    // { checkpoint, functionName: <enclosing fn> = "guard", args }. _runGuarded
    // MUST forward the same opts (only adding ownedGuardIds) — a naive
    // { ownedGuardIds } would silently drop the Failure metadata that
    // retry/checkpoint + error reporting depend on.
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext({ runId: "r1" });
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      const block = () => {
        throw new AgencyAbort(
          "trip",
          makeAbortCause({
            kind: "guardTrip",
            dimension: "time",
            limit: 20,
            spent: 21,
            guardId: "g1",
          }),
        );
      };
      const result = await _runGuarded(["g1"], block);
      expect(isFailure(result)).toBe(true);
      expect((result as { data: { type: string } }).data.type).toBe("timeoutFailure");
      expect((result as { functionName: string | null }).functionName).toBe("guard");
    });
  });

  it("re-throws a trip it does NOT own (outer guard's id), preserving the abort", async () => {
    const ctx = makeCtx();
    const execCtx = await ctx.createExecutionContext({ runId: "r1" });
    await runInTestContext(execCtx, execCtx.stateStack, new ThreadStore(), async () => {
      const block = () => {
        throw new AgencyAbort(
          "trip",
          makeAbortCause({
            kind: "guardTrip",
            dimension: "time",
            limit: 20,
            spent: 21,
            guardId: "gOUTER",
          }),
        );
      };
      await expect(_runGuarded(["gINNER"], block)).rejects.toBeInstanceOf(AgencyAbort);
    });
  });
});

function threadsWith(messages: smoltalk.Message[]): ThreadStore {
  const threads = new ThreadStore();
  const active = threads.getOrCreateActive();
  for (const message of messages) {
    active.push(message);
  }
  return threads;
}

async function lastReplyOn(threads: ThreadStore) {
  const ctx = makeCtx();
  const execCtx = await ctx.createExecutionContext({ runId: "r1" });
  return runInTestContext(execCtx, execCtx.stateStack, threads, () => _lastReply());
}

describe("_lastReply", () => {
  it("is null when the thread has no assistant message", async () => {
    const reply = await lastReplyOn(threadsWith([smoltalk.userMessage("hi")]));
    expect(reply).toBeNull();
  });

  it("returns the last assistant message's extras, even when a later message follows it", async () => {
    // Typed as smoltalk's DecideResult on purpose: `answers` is passed
    // through to Agency's DecisionAnswer types field for field, so a change
    // to that shape in smoltalk must fail here, not in a user's program.
    const decision: DecideResult = {
      answers: {
        answer: {
          type: "choice",
          choice: "billing",
          confidence: 0.9,
          probabilities: { billing: 0.9 },
        },
      },
      usage: { inputTokens: 5, outputTokens: 0 },
      model: "jev",
    };
    const threads = threadsWith([
      smoltalk.userMessage("which team?"),
      smoltalk.assistantMessage(JSON.stringify({ response: "billing" }), {
        rawData: decision,
        usage: { inputTokens: 5, outputTokens: 0 },
        cost: { inputCost: 0.001, outputCost: 0, totalCost: 0.001, currency: "USD" },
      }),
      smoltalk.userMessage("thanks"),
    ]);
    expect(await lastReplyOn(threads)).toEqual({
      content: JSON.stringify({ response: "billing" }),
      thinkingBlocks: [],
      logprobs: [],
      usage: { inputTokens: 5, outputTokens: 0 },
      cost: 0.001,
      answers: decision.answers,
      rawData: decision,
    });
  });

  it("gives null and empty values for a reply that carried nothing extra", async () => {
    const reply = await lastReplyOn(threadsWith([smoltalk.assistantMessage("plain")]));
    expect(reply).toEqual({
      content: "plain",
      thinkingBlocks: [],
      logprobs: [],
      usage: null,
      cost: null,
      answers: null,
      rawData: null,
    });
  });

  it("does not mistake another provider's rawData for decision answers", async () => {
    const threads = threadsWith([
      smoltalk.assistantMessage("plain", {
        rawData: { id: "chatcmpl-1", object: "chat.completion" },
      }),
    ]);
    const reply = await lastReplyOn(threads);
    expect(reply?.answers).toBeNull();
    expect(reply?.rawData).toEqual({ id: "chatcmpl-1", object: "chat.completion" });
  });

  it("gives null answers when rawData carries a non-object `answers`", async () => {
    // A provider whose rawData happens to have an `answers` field that is not a
    // record must not be handed back as decision answers — a caller reading
    // `reply.answers.answer` would crash. rawData itself is preserved.
    const threads = threadsWith([
      smoltalk.assistantMessage("plain", { rawData: { answers: "explanation" } }),
    ]);
    const reply = await lastReplyOn(threads);
    expect(reply?.answers).toBeNull();
    expect(reply?.rawData).toEqual({ answers: "explanation" });
  });

  it("returns the reply's logprobs, with an empty top when there were no alternatives", async () => {
    const threads = threadsWith([
      smoltalk.assistantMessage("Hi!", {
        logprobs: [
          { token: "Hi", logprob: -0.1, top: [{ token: "Hey", logprob: -1.9 }] },
          { token: "!", logprob: -0.5 },
        ],
      }),
    ]);
    const reply = await lastReplyOn(threads);
    expect(reply?.logprobs).toEqual([
      { token: "Hi", logprob: -0.1, top: [{ token: "Hey", logprob: -1.9 }] },
      { token: "!", logprob: -0.5, top: [] },
    ]);
  });

  it("returns an empty logprobs array for a reply without them", async () => {
    const reply = await lastReplyOn(threadsWith([smoltalk.assistantMessage("plain")]));
    expect(reply?.logprobs).toEqual([]);
  });
});
