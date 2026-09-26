import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgencyCancelledError } from "./errors.js";

// Mock only smoltalk's decide entry point; keep every other real export.
vi.mock("smoltalk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("smoltalk")>();
  return { ...actual, decide: vi.fn() };
});

import * as smoltalk from "smoltalk";
import { SmoltalkClient } from "./llmClient.js";

const client = new SmoltalkClient();
const questions = { answer: { type: "noul" as const, instructions: "Urgent?" } };

beforeEach(() => {
  vi.mocked(smoltalk.decide).mockReset();
});

describe("SmoltalkClient.decide adapter", () => {
  it("forwards state, questions, config, and the branch signal as abortSignal", async () => {
    vi.mocked(smoltalk.decide).mockResolvedValue({
      success: true,
      value: {
        answers: { answer: { type: "noul", noul: 0.9 } },
        usage: { inputTokens: 5, outputTokens: 0 },
        model: "jev-1.13",
      },
    });
    const signal = new AbortController().signal;
    const r = await client.decide!("the state", questions, { model: "jev-1.13" }, signal);
    expect(r.success).toBe(true);
    expect(smoltalk.decide).toHaveBeenCalledTimes(1);
    const [state, gotQuestions, gotConfig] = vi.mocked(smoltalk.decide).mock.calls[0];
    expect(state).toBe("the state");
    expect(gotQuestions).toBe(questions);
    expect(gotConfig).toEqual({ model: "jev-1.13", abortSignal: signal });
  });

  it("converts an aborted outcome into a rejection carrying signal.reason", async () => {
    const controller = new AbortController();
    const reason = new AgencyCancelledError("time guard");
    vi.mocked(smoltalk.decide).mockImplementation(async () => {
      controller.abort(reason);
      return { success: false, error: "Request was aborted" };
    });
    await expect(
      client.decide!("s", questions, { model: "jev-1.13" }, controller.signal),
    ).rejects.toBe(reason);
  });

  it("normalizeError reads a status off a plain error, so a decision 429 is retried like a text 429", () => {
    const err = Object.assign(new Error("Decision request failed with status 429: slow down"), {
      status: 429,
    });
    expect(client.normalizeError!(err)).toEqual({
      message: "Decision request failed with status 429: slow down",
      status: 429,
    });
    expect(client.normalizeError!(new Error("plain"))).toEqual({ message: "plain" });
  });

  it("returns a non-abort failure as a failure", async () => {
    vi.mocked(smoltalk.decide).mockResolvedValue({
      success: false,
      error: "No TypeSafe API key provided.",
    });
    const r = await client.decide!("s", questions, { model: "jev-1.13" }, new AbortController().signal);
    expect(r).toEqual({ success: false, error: "No TypeSafe API key provided." });
  });
});
