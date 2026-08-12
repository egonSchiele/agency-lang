import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgencyCancelledError } from "./errors.js";

// Mock only smoltalk's text entry point; keep every other real export
// (SmolError classes etc.) so the rest of SmoltalkClient is unaffected.
vi.mock("smoltalk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("smoltalk")>();
  return { ...actual, text: vi.fn() };
});

import * as smoltalk from "smoltalk";
import { SmoltalkClient } from "./llmClient.js";

const client = new SmoltalkClient();

function configWith(signal: AbortSignal) {
  return { messages: [{ role: "user", content: "hi" }], abortSignal: signal } as any;
}

beforeEach(() => {
  vi.mocked(smoltalk.text).mockReset();
});

describe("SmoltalkClient.text — cancellation rejects", () => {
  it("converts an aborted failure Result into a rejection carrying signal.reason", async () => {
    const controller = new AbortController();
    const reason = new AgencyCancelledError("call timeout");
    // smoltalk resolves its distinguishable abort failure (never throws).
    vi.mocked(smoltalk.text).mockImplementation((async () => {
      controller.abort(reason);
      return { success: false, error: "Request was aborted" };
    }) as any);
    await expect(client.text(configWith(controller.signal))).rejects.toBe(reason);
  });

  it("converts an aborted EMPTY success into a rejection (local stopOnAbortSignal shape)", async () => {
    // smoltalk-llama-cpp sets stopOnAbortSignal, so an aborted generation
    // RESOLVES as success with output null (everything was in an unterminated
    // think segment) — that must surface as a cancellation, not a success.
    const controller = new AbortController();
    const reason = new AgencyCancelledError("call timeout");
    vi.mocked(smoltalk.text).mockImplementation((async () => {
      controller.abort(reason);
      return {
        success: true,
        value: { output: null, toolCalls: [], usage: { totalTokens: 169301 } },
      };
    }) as any);
    await expect(client.text(configWith(controller.signal))).rejects.toBe(reason);
  });

  it("keeps a success WITH content that raced ahead of a late abort", async () => {
    const controller = new AbortController();
    vi.mocked(smoltalk.text).mockImplementation((async () => {
      const result = { success: true, value: { output: "done", toolCalls: [] } };
      controller.abort(new AgencyCancelledError("late"));
      return result;
    }) as any);
    const r = await client.text(configWith(controller.signal));
    expect(r.success).toBe(true);
    if (r.success) expect(r.value.output).toBe("done");
  });

  it("keeps an aborted success that carries tool calls (content, not an empty shell)", async () => {
    const controller = new AbortController();
    vi.mocked(smoltalk.text).mockImplementation((async () => {
      const result = {
        success: true,
        value: {
          output: null,
          toolCalls: [{ id: "1", name: "getWeather", arguments: "{}" }],
        },
      };
      controller.abort(new AgencyCancelledError("late"));
      return result;
    }) as any);
    const r = await client.text(configWith(controller.signal));
    expect(r.success).toBe(true);
  });

  it("keeps an aborted success that carries only hosted tool results", async () => {
    // Hosted tools (e.g. web_search) run provider-side; their results can be
    // the only content on an otherwise output-less completion. That is real,
    // paid-for content — not an empty shell to discard as a cancellation.
    const controller = new AbortController();
    vi.mocked(smoltalk.text).mockImplementation((async () => {
      const result = {
        success: true,
        value: {
          output: null,
          toolCalls: [],
          hostedToolResults: [{ type: "web_search", queries: ["q"] }],
        },
      };
      controller.abort(new AgencyCancelledError("late"));
      return result;
    }) as any);
    const r = await client.text(configWith(controller.signal));
    expect(r.success).toBe(true);
  });

  it("passes a NON-abort failure Result through unchanged (does not throw)", async () => {
    vi.mocked(smoltalk.text).mockResolvedValue({
      success: false,
      error: "no api key",
    } as any);
    const r = await client.text(configWith(new AbortController().signal));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe("no api key");
  });

  it("rejects with a NON-Error abort reason unchanged (identity preserved)", async () => {
    const controller = new AbortController();
    const reason = { kind: "sentinel-object-reason" };
    vi.mocked(smoltalk.text).mockImplementation((async () => {
      controller.abort(reason);
      return { success: false, error: "Request was aborted" };
    }) as any);
    await expect(client.text(configWith(controller.signal))).rejects.toBe(reason);
  });
});

describe("SmoltalkClient.textStream — cancellation rejects", () => {
  async function drain(gen: AsyncGenerator<any>) {
    const chunks: any[] = [];
    for await (const chunk of gen) chunks.push(chunk);
    return chunks;
  }

  it("throws signal.reason instead of yielding an aborted empty done chunk", async () => {
    const controller = new AbortController();
    const reason = new AgencyCancelledError("call timeout");
    vi.mocked(smoltalk.text).mockImplementation((function* () {
      controller.abort(reason);
      yield { type: "done", result: { output: null, toolCalls: [] } };
    }) as any);
    await expect(drain(client.textStream(configWith(controller.signal)))).rejects.toBe(
      reason,
    );
  });

  it("throws signal.reason instead of yielding an aborted error chunk", async () => {
    const controller = new AbortController();
    const reason = new AgencyCancelledError("call timeout");
    vi.mocked(smoltalk.text).mockImplementation((function* () {
      controller.abort(reason);
      yield { type: "error", error: "Request was aborted" };
    }) as any);
    await expect(drain(client.textStream(configWith(controller.signal)))).rejects.toBe(
      reason,
    );
  });

  it("passes a normal stream through unchanged", async () => {
    vi.mocked(smoltalk.text).mockImplementation((function* () {
      yield { type: "text", text: "hel" };
      yield { type: "text", text: "lo" };
      yield { type: "done", result: { output: "hello", toolCalls: [] } };
    }) as any);
    const chunks = await drain(client.textStream(configWith(new AbortController().signal)));
    expect(chunks.map((c) => c.type)).toEqual(["text", "text", "done"]);
  });

  it("keeps an aborted done chunk that carries real output (late abort race)", async () => {
    const controller = new AbortController();
    vi.mocked(smoltalk.text).mockImplementation((function* () {
      controller.abort(new AgencyCancelledError("late"));
      yield { type: "text", text: "partial" };
      yield { type: "done", result: { output: "partial", toolCalls: [] } };
    }) as any);
    const chunks = await drain(client.textStream(configWith(controller.signal)));
    expect(chunks.at(-1).type).toBe("done");
    expect(chunks.at(-1).result.output).toBe("partial");
  });
});
