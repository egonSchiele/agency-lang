import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgencyCancelledError } from "./errors.js";

// Mock only smoltalk's audio entry points; keep every other real export
// (SmolError classes etc.) so the rest of SmoltalkClient is unaffected.
vi.mock("smoltalk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("smoltalk")>();
  return { ...actual, transcribe: vi.fn(), speak: vi.fn() };
});

import * as smoltalk from "smoltalk";
import { SmoltalkClient } from "./llmClient.js";

const client = new SmoltalkClient();
const source = { kind: "path", path: "a.wav" } as const;

beforeEach(() => {
  vi.mocked(smoltalk.transcribe).mockReset();
  vi.mocked(smoltalk.speak).mockReset();
});

describe("SmoltalkClient.transcribe / speak adapters", () => {
  it("forwards the exact source, complete config, and the branch signal as abortSignal", async () => {
    vi.mocked(smoltalk.transcribe).mockResolvedValue({
      success: true,
      value: { text: "hi" },
    } as any);
    const signal = new AbortController().signal;
    await client.transcribe(source, { model: "whisper-1", language: "en" }, signal);

    expect(smoltalk.transcribe).toHaveBeenCalledTimes(1);
    const [gotSource, gotOpts] = vi.mocked(smoltalk.transcribe).mock.calls[0];
    expect(gotSource).toEqual(source);
    expect(gotOpts.model).toBe("whisper-1");
    expect(gotOpts.language).toBe("en");
    expect(gotOpts.abortSignal).toBe(signal); // same object, the sole channel
  });

  it("forwards speak text/config and the branch signal as abortSignal", async () => {
    vi.mocked(smoltalk.speak).mockResolvedValue({
      success: true,
      value: { audio: new Uint8Array([1]), mimeType: "audio/mpeg" },
    } as any);
    const signal = new AbortController().signal;
    await client.speak("say this", { model: "tts-1", voice: "alloy", format: "mp3" }, signal);

    const [gotText, gotOpts] = vi.mocked(smoltalk.speak).mock.calls[0];
    expect(gotText).toBe("say this");
    expect(gotOpts.model).toBe("tts-1");
    expect(gotOpts.voice).toBe("alloy");
    expect(gotOpts.format).toBe("mp3");
    expect(gotOpts.abortSignal).toBe(signal);
  });

  it("converts an aborted outcome into a rejection carrying signal.reason (transcribe)", async () => {
    const controller = new AbortController();
    const reason = new AgencyCancelledError("time guard");
    // smoltalk resolves its distinguishable abort failure (shape B, never throws).
    vi.mocked(smoltalk.transcribe).mockImplementation(async () => {
      controller.abort(reason);
      return { success: false, error: "Request was aborted" } as any;
    });
    await expect(
      client.transcribe(source, { model: "whisper-1" }, controller.signal),
    ).rejects.toBe(reason);
  });

  it("converts an aborted outcome into a rejection carrying signal.reason (speak)", async () => {
    const controller = new AbortController();
    const reason = new AgencyCancelledError("race lost");
    vi.mocked(smoltalk.speak).mockImplementation(async () => {
      controller.abort(reason);
      return { success: false, error: "Request was aborted" } as any;
    });
    await expect(
      client.speak("hi", { model: "tts-1", voice: "alloy", format: "mp3" }, controller.signal),
    ).rejects.toBe(reason);
  });

  it("passes a NON-abort failure Result through unchanged (does not throw)", async () => {
    vi.mocked(smoltalk.transcribe).mockResolvedValue({
      success: false,
      error: "no api key",
    } as any);
    const r = await client.transcribe(source, { model: "whisper-1" }, new AbortController().signal);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe("no api key");
  });

  it("rejects with a NON-Error abort reason unchanged (identity preserved)", async () => {
    const controller = new AbortController();
    const reason = { kind: "sentinel-object-reason" }; // abort() accepts non-Error values
    vi.mocked(smoltalk.speak).mockImplementation(async () => {
      controller.abort(reason);
      return { success: false, error: "Request was aborted" } as any;
    });
    await expect(
      client.speak("hi", { model: "tts-1", voice: "alloy", format: "mp3" }, controller.signal),
    ).rejects.toBe(reason); // the exact object, not a wrapped Error
  });

  it("keeps a SUCCESS that raced ahead of a late abort (not discarded as cancellation)", async () => {
    const controller = new AbortController();
    const value = { text: "done before abort" };
    vi.mocked(smoltalk.transcribe).mockImplementation(async () => {
      // The request resolved successfully; the branch aborts a tick later.
      const result = { success: true, value } as any;
      controller.abort(new AgencyCancelledError("late"));
      return result;
    });
    const r = await client.transcribe(source, { model: "whisper-1" }, controller.signal);
    expect(r.success).toBe(true); // success + its real cost survive the late abort
    if (r.success) expect(r.value).toBe(value);
  });
});
